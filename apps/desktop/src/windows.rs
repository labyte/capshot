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
        .transparent(false)
        .focused(true)
        .inner_size(200.0, 200.0)
        .build()?;
    // 物理坐标落位（builder 只吃逻辑，创建后立刻改物理）
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: m.bounds.x,
        y: m.bounds.y,
    }));
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: m.bounds.width,
        height: m.bounds.height,
    }));
    let _ = win.show();
    let _ = win.set_focus();
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
