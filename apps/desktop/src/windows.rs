//! 窗口工厂：overlay（每显示器一窗、不透明冻结帧铺满）与 pin（透明无边框置顶）。
//! 坑位处理集中在计划 §5.3：位置尺寸用物理坐标 set（避免逻辑/物理混用）。

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use capture_core::{MonitorInfo, PhysicalRect};

pub fn open_overlay(app: &AppHandle, token: u64, idx: usize, m: &MonitorInfo) -> tauri::Result<String> {
    let label = format!("overlay-{token}-{idx}");
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("overlay.html".into()))
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(false)
        .transparent(true)
        // 关键：无边框窗默认 shadow(true) 会带 8px 不可见 resize 边框，
        // 导致 client 区域相对屏幕偏移 (8,1) —— 冻结帧整幅错位。overlay 必须关阴影。
        .shadow(false)
        .focused(true)
        .inner_size(200.0, 200.0)
        .build()?;
    // 禁用 DWM 窗口开合动画：否则 show() 带 ~200ms 淡入缩放，"覆盖感"明显
    #[cfg(windows)]
    if let Ok(hwnd) = win.hwnd() {
        unsafe {
            let on: i32 = 1;
            let _ = windows::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                hwnd,
                windows::Win32::Graphics::Dwm::DWMWA_TRANSITIONS_FORCEDISABLED,
                &on as *const _ as *const core::ffi::c_void,
                4,
            );
        }
    }
    // 物理坐标落位（builder 只吃逻辑，创建后立刻改物理）
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: m.bounds.x,
        y: m.bounds.y,
    }));
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: m.bounds.width,
        height: m.bounds.height,
    }));
    // 保持隐藏 —— 前端画完冻结帧第一帧后才 show（overlay/main.js init 末尾），
    // 避免用户看到深色空窗→画面的过渡（"多了一层"感）。兜底强显见 commands.rs。
    Ok(label)
}

pub fn open_pin(app: &AppHandle, sel: u64, frame: &PhysicalRect) -> tauri::Result<String> {
    let label = format!("pin-{sel}");
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("pin.html".into()))
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .transparent(true)
        .shadow(true)
        .visible(false)
        .inner_size(200.0, 200.0)
        .build()?;
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: frame.x,
        y: frame.y,
    }));
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: frame.width,
        height: frame.height,
    }));
    let _ = win.show();
    Ok(label)
}

pub fn open_simple(app: &AppHandle, label: &str, url: &str, w: f64, h: f64) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(match label {
            "settings" => "capshot 设置",
            _ => "capshot 历史",
        })
        .inner_size(w, h)
        .resizable(true)
        .build()?;
    Ok(())
}
