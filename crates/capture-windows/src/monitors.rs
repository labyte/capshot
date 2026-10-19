//! 显示器枚举。EnumDisplayMonitors 的 rcMonitor **已是物理像素**（负坐标原生支持）。
//! scale = shcore GetDpiForMonitor(有效 DPI)；失败回退 GetDpiForWindow(Shell)/96。

use capture_core::types::{MonitorInfo, PhysicalRect};
use windows::core::BOOL;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HMONITOR, HDC, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, GetDpiForWindow, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{GetShellWindow, MONITORINFOF_PRIMARY};

#[derive(Clone)]
pub struct DisplayPt {
    pub hmon: HMONITOR,
    pub scale: f64,
    pub phys: MonitorInfo,
}

fn rect_to_physical(r: &RECT) -> PhysicalRect {
    PhysicalRect::new(
        r.left,
        r.top,
        (r.right - r.left).max(0) as u32,
        (r.bottom - r.top).max(0) as u32,
    )
}

unsafe extern "system" fn cb(hmon: HMONITOR, _dc: HDC, _r: *mut RECT, data: LPARAM) -> BOOL {
    unsafe {
    let out = &mut *(data.0 as *mut Vec<DisplayPt>);
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    let ok = GetMonitorInfoW(hmon, &mut mi.monitorInfo as *mut MONITORINFO);
    if ok.0 != 0 {
        let mut dpi_x: u32 = 96;
        let mut dpi_y: u32 = 96;
        
        let _ = GetDpiForMonitor(hmon, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);
        let scale = if dpi_x.max(dpi_y) == 0 {
            let s = GetDpiForWindow(GetShellWindow()) as f64 / 96.0;
            if s > 0.0 { s } else { 1.0 }
        } else {
            dpi_x.max(dpi_y) as f64 / 96.0
        };
        let bounds = rect_to_physical(&mi.monitorInfo.rcMonitor);
        let visible_bounds = rect_to_physical(&mi.monitorInfo.rcWork);
        let name = String::from_utf16_lossy(
            &mi.szDevice.iter().map(|c| *c as u16).take_while(|&c| c != 0).collect::<Vec<u16>>(),
        );
        let is_primary = (mi.monitorInfo.dwFlags & MONITORINFOF_PRIMARY) != 0;
        out.push(DisplayPt {
            hmon,
            scale,
            phys: MonitorInfo {
                id: hmon.0 as u64, // HMONITOR 指针值作稳定 id
                name: if name.is_empty() { "monitor".into() } else { name },
                bounds,
                visible_bounds,
                scale_factor: scale,
                is_primary,
            },
        });
    }
    BOOL(1)
    }
}

pub fn displays() -> Vec<DisplayPt> {
    let mut out: Vec<DisplayPt> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(cb),
            LPARAM(&mut out as *mut Vec<DisplayPt> as isize),
        );
    }
    out
}

pub fn monitors() -> Vec<MonitorInfo> {
    displays().into_iter().map(|d| d.phys).collect()
}

pub fn primary<'a>(ds: &'a [DisplayPt]) -> Option<&'a DisplayPt> {
    ds.iter().find(|d| d.phys.is_primary).or(ds.first())
}

pub fn display_for_point<'a>(ds: &'a [DisplayPt], x: i64, y: i64) -> Option<&'a DisplayPt> {
    ds.iter().find(|d| d.phys.bounds.contains(x, y))
}

// 常量占位防未用导入（HINSTANCE/HWND 在其它模块复用）
const _: (Option<HINSTANCE>, Option<HWND>) = (None, None);
