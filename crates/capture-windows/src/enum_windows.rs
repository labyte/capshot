//! 窗口枚举（EnumWindows 天然顶→底，满足 capture-core z 序契约）。
//! 过滤原理移植自参考：仅可见窗口、cloaked 剔除（虚拟桌面/UWP 挂起）、DWM 扩展 frame
//! （去透明阴影边，等价 macOS kCGWindowBounds）、系统壳/桌面类名分类。

use capture_core::types::{PhysicalRect, WindowInfo, WindowKind};
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DWMWINDOWATTRIBUTE,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongW, GetWindowTextW, GetWindowThreadProcessId,
    IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_LAYERED, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST,
};

pub const WINDOWS_SHELL_CLASSES: [&str; 7] = [
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Windows.UI.Core.CoreWindow",
    "XamlExplorerHostIslandWindow",
    "NotifyIconOverflowWindow",
    "TaskListThumbnailWnd",
    // CEF 离屏渲染面（NVIDIA GeForce Overlay 等），非用户内容窗口
    "CEF-OSC-WIDGET",
];
pub const DESKTOP_CLASSES: [&str; 2] = ["Progman", "WorkerW"];

fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..n as usize])
}

fn window_title(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    if n <= 0 {
        return None;
    }
    let s = String::from_utf16_lossy(&buf[..n as usize]);
    if s.is_empty() { None } else { Some(s) }
}

fn exe_name(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
        let _ = CloseHandle(h);
        if ok.is_err() {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..size as usize]);
        path.rsplit(['\\', '/']).next().map(|s| s.to_string())
    }
}

fn bounds_physical(hwnd: HWND) -> Option<PhysicalRect> {
    let mut r = RECT::default();
    let ext: DWMWINDOWATTRIBUTE = DWMWA_EXTENDED_FRAME_BOUNDS;
    let got_ext =
        unsafe { DwmGetWindowAttribute(hwnd, ext, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32) };
    if got_ext.is_err() {
        unsafe { windows::Win32::UI::WindowsAndMessaging::GetWindowRect(hwnd, &mut r) }.ok()?;
    }
    let w = (r.right - r.left).max(0);
    let h = (r.bottom - r.top).max(0);
    if w < 1 || h < 1 {
        return None;
    }
    Some(PhysicalRect::new(r.left, r.top, w as u32, h as u32))
}

/// 顶→底有序、仅可见窗口（对齐 mac 端 OnScreenOnly 语义）。
pub fn list_windows(exclude: &[HWND]) -> Vec<WindowInfo> {
    let mut out: Vec<WindowInfo> = Vec::new();
    unsafe extern "system" fn cb(hwnd: HWND, data: LPARAM) -> BOOL {
        unsafe {
        let out = &mut *(data.0 as *mut Vec<WindowInfo>);
        if IsWindowVisible(hwnd).0 == 0 {
            return BOOL(1);
        }
        let mut cloak: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloak as *mut _ as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        let class = class_name(hwnd);
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        let kind = if DESKTOP_CLASSES.contains(&class.as_str()) {
            WindowKind::Desktop
        } else if WINDOWS_SHELL_CLASSES.contains(&class.as_str()) || class.starts_with("Windows.UI.") {
            WindowKind::Shell
        } else if ex & WS_EX_TOOLWINDOW.0 != 0 {
            WindowKind::Tooltip
        } else {
            WindowKind::Normal
        };
        let Some(bounds) = bounds_physical(hwnd) else { return BOOL(1) };
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let title = window_title(hwnd);
        let exe = exe_name(pid);
        let cloaked = cloak != 0;
        let z = out.len();
        out.push(WindowInfo {
            id: hwnd.0 as u64,
            pid,
            title,
            app_name: exe.clone(),
            app_id: exe,
            bounds,
            z_index: z,
            layer: if ex & WS_EX_TOPMOST.0 != 0 { 0 } else { 5 },
            // 最小化窗口仍 IsWindowVisible 且非 cloaked，但 bounds 停在 (-32000,-32000)
            // 的 146×21 小条 —— 必须按 iconic 剔除，否则污染吸附候选
            is_on_screen: !cloaked && !IsIconic(hwnd).as_bool(),
            cloaked,
            kind,
        });
        BOOL(1)
        }
    }
    unsafe {
        let _ = EnumWindows(
            Some(cb),
            LPARAM(&mut out as *mut Vec<WindowInfo> as isize),
        );
    }
    out.retain(|w| !exclude.iter().any(|h| h.0 as u64 == w.id));
    out
}

/// 自身 pid 的窗口一并剔除（overlay/pin 不被自己截到）。
pub fn list_windows_with_owner(my_pid: u32, exclude: &[HWND]) -> Vec<WindowInfo> {
    let mut ws = list_windows(exclude);
    ws.retain(|w| w.pid != my_pid);
    ws
}

// 备用导入（WS_EX_APPWINDOW/LAYERED 在分类细化时启用）
const _: (u32, u32) = (WS_EX_APPWINDOW.0, WS_EX_LAYERED.0);
