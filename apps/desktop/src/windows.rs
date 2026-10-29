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
    disable_dwm_transitions(&win);
    // 物理坐标落位（builder 只吃逻辑，创建后立刻改物理）
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: m.bounds.x,
        y: m.bounds.y,
    }));
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: m.bounds.width,
        height: m.bounds.height,
    }));
    // 保持隐藏 —— 前端画完冻结帧第一帧后才 show（见 OverlayPage 的 reveal），
    // 避免用户看到深色空窗→画面的过渡（"多了一层"感）。兜底强显见 commands.rs。
    Ok(label)
}

/// 贴图窗四周留白（物理 px）：投影与 1px 边框在窗内自绘，
/// 这样窗口几何与图像矩形是精确的 PAD 关系，不受 DWM 阴影内缩影响。
pub const PIN_PAD: i32 = 16;

/// 禁用 DWM 窗口开合动画：否则 show() 带 ~200ms 淡入缩放，"覆盖感/闪一下"明显
fn disable_dwm_transitions(win: &tauri::WebviewWindow) {
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
    #[cfg(not(windows))]
    let _ = win;
}

/// 贴图窗。**不在此处 show()**：前端解码完 PNG 调 `pin_ready` 再显示，
/// 消掉「先出现一块深色空窗」的闪烁；兜底强显见 commands::schedule_pin_force_show。
pub fn open_pin(app: &AppHandle, sel: u64, frame: &PhysicalRect) -> tauri::Result<String> {
    let win = build_pin(app, sel, frame.width, frame.height)?;
    // 贴回截图原位：窗口 = 图像 + 四周 PAD，所以原点要外移 PAD
    let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition {
        x: frame.x - PIN_PAD,
        y: frame.y - PIN_PAD,
    }));
    Ok(win.label().to_string())
}

/// 剪贴板贴图：落在光标处（Snipaste 的 F3 语义）。
///
/// 光标坐标只能在**已存在的窗口**上取 —— `cursor_position()` 挂在 App/Window/WebviewWindow 上，
/// `AppHandle`（全局快捷键 handler 手里就这个）没有该方法。所以先建隐藏窗再定位。
pub fn open_pin_at_cursor(app: &AppHandle, sel: u64, img_w: u32, img_h: u32) -> tauri::Result<String> {
    let win = build_pin(app, sel, img_w, img_h)?;
    let cursor = win.cursor_position()?;
    let monitor = win
        .monitor_from_point(cursor.x, cursor.y)?
        .or(win.primary_monitor()?);
    if let Some(m) = monitor {
        let mp = m.position();
        let ms = m.size();
        let w = win.outer_size()?;
        // 以光标为中心，并 clamp 进该显示器，避免贴到屏外
        let x = (cursor.x as i32 - (w.width / 2) as i32).clamp(mp.x, (mp.x + ms.width as i32 - w.width as i32).max(mp.x));
        let y = (cursor.y as i32 - (w.height / 2) as i32).clamp(mp.y, (mp.y + ms.height as i32 - w.height as i32).max(mp.y));
        let _ = win.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }
    Ok(win.label().to_string())
}

fn build_pin(app: &AppHandle, sel: u64, img_w: u32, img_h: u32) -> tauri::Result<tauri::WebviewWindow> {
    let label = format!("pin-{sel}");
    let win = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("pin.html".into()))
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .transparent(true)
        // shadow(false) + 窗内自绘投影：原先 shadow(true) 让 outer 比图像实际位置偏 8px，
        // 「贴回原处」就不准了（pin_bounds 里那段 inner/outer 注释是这个坑的临时绕行）
        .shadow(false)
        .visible(false)
        // 必须可聚焦：Snipaste 式贴图快捷键（Esc/方向键/缩放/穿透开关）都依赖键盘进得来
        .focused(true)
        .inner_size(200.0, 200.0)
        .build()?;
    disable_dwm_transitions(&win);
    let _ = win.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: img_w + (PIN_PAD as u32) * 2,
        height: img_h + (PIN_PAD as u32) * 2,
    }));
    {
        // 关闭时记下这条 Sel，F3 在无剪贴板图时复活（Snipaste 的"可恢复关闭"）
        let app2 = app.clone();
        win.on_window_event(move |e| {
            if let tauri::WindowEvent::Destroyed = e {
                crate::commands::note_pin_closed(&app2, sel);
            }
        });
    }
    Ok(win)
}

pub fn open_simple(app: &AppHandle, label: &str, url: &str, w: f64, h: f64) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(label) {
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let title = match label {
        "settings" => "CapsShot 设置",
        "about" => "关于 CapsShot",
        _ => "CapsShot 历史",
    };
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(w, h);
    // 关于窗是定尺寸信息卡，不给拉伸；设置/历史仍可调
    if label == "about" {
        b = b.resizable(false).maximizable(false).center();
    } else {
        b = b.resizable(true);
    }
    b.build()?;
    Ok(())
}
