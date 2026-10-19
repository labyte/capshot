//! Tauri 命令面（计划 §5.2）。二进制 IPC 走 tauri::ipc::Response；
//! 会话 token 幂等 + 帧缓存生命周期都收在这里（对应参考 requestId 缓存与日志链）。

use std::collections::HashSet;
use std::time::{Duration, Instant};

use capture_core::plan;
use capture_core::{ApiError, CaptureError, Frame, PhysicalRect};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::history::{self, base64_decode};
use crate::settings::Settings;
use crate::state::{AppState, Sel, Session};
use crate::windows;

// ---------- 会话触发（热键/托盘共用） ----------

pub fn trigger_capture(app: &AppHandle) {
    let state = app.state::<AppState>();
    // 去抖：500ms 内重复触发 → 聚焦已有 overlay（requestId 幂等原理）
    // 先拷贝出快照再判断，避免 if-let 条件守卫占住 active 锁
    let active_snapshot = *state.active.lock().unwrap();
    if let Some((token, since)) = active_snapshot {
        if since.elapsed() < Duration::from_millis(500) {
            let overlays: Vec<String> = state
                .sessions
                .lock()
                .unwrap()
                .iter()
                .find(|s| s.token == token)
                .map(|s| s.overlays.clone())
                .unwrap_or_default();
            if !overlays.is_empty() {
                for l in overlays {
                    if let Some(w) = app.get_webview_window(&l) {
                        let _ = w.set_focus();
                    }
                }
            }
            // 会话尚未落库（工作线程抓取中）也视为进行中：吞掉重复触发，
            // 否则按下/松开各起一个 overlay，两层冻结帧错位
            return;
        }
    }

    let token = state.next_id();
    *state.active.lock().unwrap() = Some((token, Instant::now()));

    // 抓屏 + PNG 编码是重活（debug 下可达秒级），必须离开主线程，否则事件循环
    // 停摆 → WebView2 挂起（WER AppHangB1）、Esc/托盘/后续命令全部无响应。
    let app2 = app.clone();
    std::thread::spawn(move || {
        let state = app2.state::<AppState>();
        let t0 = Instant::now();
        let monitors = match state.backend.monitors() {
            Ok(m) => m,
            Err(e) => {
                report_capture_error(&app2, &e);
                return;
            }
        };
        let windows = match state.backend.list_windows() {
            Ok(w) => w,
            Err(e) => {
                report_capture_error(&app2, &e);
                return;
            }
        };
        let mut frames = std::collections::HashMap::new();
        let mut pngs = std::collections::HashMap::new();
        for m in &monitors {
            match state.backend.capture_monitor(m.id) {
                Ok(f) => {
                    let png = capture_core::encode::to_png(&f).unwrap_or_default();
                    frames.insert(m.id, f);
                    pngs.insert(m.id, png);
                }
                Err(e) => {
                    log::error!("capture screen frame failed monitor={} err={e}", m.id);
                    report_capture_error(&app2, &e);
                    return;
                }
            }
        }
        log::info!("capture target request_id={token} (elapsed {:?}ms)", t0.elapsed().as_millis());

        // 窗口创建回主线程（macOS 要求；Windows 亦可），overlay 立即可见
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            let state = app3.state::<AppState>();
            let mut overlays = Vec::new();
            for (i, m) in monitors.iter().enumerate() {
                match windows::open_overlay(&app3, token, i, m) {
                    Ok(label) => overlays.push(label),
                    Err(e) => log::error!("open overlay failed: {e}"),
                }
            }
            state.put_session(Session {
                token,
                monitors,
                windows,
                frames,
                pngs,
                overlays: overlays.clone(),
            });
            // 兜底：前端就绪信号丢失（webview 异常）时 1.2s 后强制显示，避免隐形窗口
            let app4 = app3.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                for l in &overlays {
                    if let Some(w) = app4.get_webview_window(l) {
                        if !w.is_visible().unwrap_or(true) {
                            log::warn!("overlay {l} not shown by frontend within 1.2s — forcing visible");
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                }
            });
        });
    });
}

fn report_capture_error(app: &AppHandle, e: &CaptureError) {
    log::error!("capture failed: {e}");
    let api = ApiError::from(e.clone_serde());
    let payload = serde_json::json!({ "code": api.code, "message": api.message });
    let _ = app.emit("capture-error", payload);
}

// ---------- 命令 ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapDto {
    pub window_id: u64,
    pub title: Option<String>,
    pub app_name: Option<String>,
    pub bundle_id: Option<String>,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// overlay/pin/settings 启动时按窗口 label 取回自己的上下文。
#[tauri::command]
pub fn bootstrap(window: tauri::Window, state: State<'_, AppState>) -> Result<serde_json::Value, ApiError> {
    let label = window.label().to_string();
    if let Some(rest) = label.strip_prefix("overlay-") {
        let (token_s, idx_s) = rest.split_once('-').ok_or(ApiError {
            code: "bad_label",
            message: label.clone(),
        })?;
        let token: u64 = token_s.parse().map_err(|_| ApiError { code: "bad_label", message: label.clone() })?;
        let idx: usize = idx_s.parse().map_err(|_| ApiError { code: "bad_label", message: label.clone() })?;
        let g = state.sessions.lock().unwrap();
        let s = g.iter().find(|s| s.token == token).ok_or(ApiError { code: "target_not_found", message: "expired session".into() })?;
        let m = s.monitors.get(idx).ok_or(ApiError { code: "target_not_found", message: "no monitor".into() })?;
        let excluded: HashSet<u64> = HashSet::new();
        let cands = plan::snap_candidates(&s.windows, &excluded, std::process::id());
        let snaps: Vec<SnapDto> = cands
            .iter()
            .map(|w| SnapDto {
                window_id: w.id,
                title: w.title.clone(),
                app_name: w.app_name.clone(),
                bundle_id: w.app_id.clone(),
                x: w.bounds.x,
                y: w.bounds.y,
                width: w.bounds.width,
                height: w.bounds.height,
            })
            .collect();
        return Ok(serde_json::json!({
            "kind": "overlay", "token": token, "monitor": m.id, "bounds": m.bounds,
            "scale": m.scale_factor, "windows": snaps,
            "settings": *state.settings.lock().unwrap(),
        }));
    }
    if let Some(rest) = label.strip_prefix("pin-") {
        let sel: u64 = rest.parse().map_err(|_| ApiError { code: "bad_label", message: label })?;
        let g = state.selections.lock().unwrap();
        let s = g.get(&sel).ok_or(ApiError { code: "target_not_found", message: "sel gone".into() })?;
        return Ok(serde_json::json!({ "kind": "pin", "sel": sel, "width": s.frame.width, "height": s.frame.height }));
    }
    Ok(serde_json::json!({ "kind": "plain" }))
}

#[tauri::command]
pub fn get_monitor_frame(token: u64, monitor: u64, state: State<'_, AppState>) -> Result<tauri::ipc::Response, ApiError> {
    let g = state.sessions.lock().unwrap();
    let s = g.iter().find(|s| s.token == token).ok_or(ApiError { code: "target_not_found", message: "expired".into() })?;
    let png = s.pngs.get(&monitor).cloned().ok_or(ApiError { code: "target_not_found", message: "no monitor".into() })?;
    Ok(tauri::ipc::Response::new(png))
}

/// 提交选区：在缓存冻结帧上裁剪（所见即所得，无二次抓屏竞态），跨屏则合成。
#[tauri::command]
pub async fn commit_selection(token: u64, rect: PhysicalRect, source: String, app_hint: Option<String>, state: State<'_, AppState>) -> Result<serde_json::Value, ApiError> {
    let frame = {
        let g = state.sessions.lock().unwrap();
        let s = g.iter().find(|s| s.token == token).ok_or(ApiError { code: "target_not_found", message: "expired".into() })?;
        compose_rect(s, &rect)?
    };
    let sel = state.next_id();
    let png = capture_core::encode::to_png(&frame)?;
    state.selections.lock().unwrap().insert(
        sel,
        Sel { frame, rect, png, source, app_hint },
    );
    Ok(serde_json::json!({ "sel": sel }))
}

fn compose_rect(s: &Session, rect: &PhysicalRect) -> Result<Frame, ApiError> {
    // 单显示器快速路径
    if let Some(m) = s.monitors.iter().find(|m| {
        m.bounds.contains(rect.mid_x(), rect.mid_y())
            && m.bounds.intersection(rect).map(|i| i.area()).unwrap_or(0) == rect.area()
    }) {
        let local = PhysicalRect::new(
            rect.x - m.bounds.x,
            rect.y - m.bounds.y,
            rect.width,
            rect.height,
        );
        let f = s.frames.get(&m.id).ok_or(ApiError { code: "degenerate_geometry", message: "frame missing".into() })?;
        return f.crop(&local).map_err(|e| e.into_api());
    }
    // 跨屏：union 帧 + 各显示器条带粘贴
    let mut out = vec![0u8; rect.width as usize * rect.height as usize * 4];
    let row = rect.width as usize * 4;
    for m in &s.monitors {
        let Some(i) = m.bounds.intersection(rect) else { continue };
        let Some(f) = s.frames.get(&m.id) else { continue };
        let local_src = PhysicalRect::new(i.x - m.bounds.x, i.y - m.bounds.y, i.width, i.height);
        let crop = f.crop(&local_src).map_err(|e| e.into_api())?;
        for y in 0..i.height as usize {
            let src = &crop.pixels[y * crop.stride..(y + 1) * crop.stride];
            let dx = (i.x - rect.x) as usize * 4;
            let dy = (y + (i.y - rect.y) as usize) * row;
            out[dy + dx..dy + dx + i.width as usize * 4].copy_from_slice(src);
        }
    }
    Frame::new(rect.width, rect.height, row, out).ok_or(ApiError { code: "degenerate_geometry", message: "compose".into() })
}

/// 双击吸附整窗：两级抓取（窗口图 → too-small 用缓存帧裁剪兜底，复刻参考链与日志字面）。
#[tauri::command]
pub async fn capture_window_clean(token: u64, window_id: u64, state: State<'_, AppState>) -> Result<serde_json::Value, ApiError> {
    let (rect, frame) = {
        let g = state.sessions.lock().unwrap();
        let s = g.iter().find(|s| s.token == token).ok_or(ApiError { code: "target_not_found", message: "expired".into() })?;
        let w = s.windows.iter().find(|w| w.id == window_id).ok_or(ApiError { code: "target_not_found", message: "window gone".into() })?;
        let rect = plan::effective_capture_rect(w, &s.monitors);
        let scale = s
            .monitors
            .iter()
            .find(|m| m.bounds.contains(rect.mid_x(), rect.mid_y()))
            .map(|m| m.scale_factor)
            .unwrap_or(1.0);
        let frame = match state.backend.capture_window(window_id) {
            Ok(f) if !plan::window_image_too_small((f.width, f.height), &rect, scale) => {
                log::info!("capture window image success window_id={window_id}");
                f
            }
            _ => {
                log::info!("capture window image too small window_id={window_id}, fallback to frame should_try_screen_frame=true");
                compose_rect(s, &rect)?
            }
        };
        (rect, frame)
    };
    let sel = state.next_id();
    let png = capture_core::encode::to_png(&frame)?;
    state.selections.lock().unwrap().insert(
        sel,
        Sel { frame, rect, png, source: "window".into(), app_hint: None },
    );
    Ok(serde_json::json!({ "sel": sel, "rect": rect }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReq {
    pub sel: u64,
    /// 前端渲染（含标注）后的 PNG base64；None 则用原裁剪帧
    pub png_base64: Option<String>,
    pub annotation_json: Option<String>,
    /// copy | save | pin | copySave
    pub op: String,
}

#[tauri::command]
pub async fn export_result(app: AppHandle, req: ExportReq, state: State<'_, AppState>) -> Result<serde_json::Value, ApiError> {
    log::info!("export_result enter op={} sel={}", req.op, req.sel);
    let sel = {
        let mut g = state.selections.lock().unwrap();
        let s = g.get_mut(&req.sel).ok_or(ApiError { code: "target_not_found", message: "sel gone".into() })?;
        if let Some(b64) = &req.png_base64 {
            let bytes = base64_decode(b64).ok_or(ApiError { code: "degenerate_geometry", message: "bad png b64".into() })?;
            s.png = bytes;
            s.frame = history::png_to_frame(&s.png).ok_or(ApiError { code: "degenerate_geometry", message: "png decode".into() })?;
        }
        Sel {
            frame: s.frame.clone(),
            rect: s.rect,
            png: s.png.clone(),
            source: s.source.clone(),
            app_hint: s.app_hint.clone(),
        }
    };

    let mut result = serde_json::json!({ "op": req.op });

    // 历史落库（copySave/save/pin 都入历史；纯 copy 也入 —— 便于找回，计划 §6.3）
    let thumb = capture_core::encode::to_thumbnail(&sel.frame).unwrap_or_default();
    let day = {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        history::epoch_day_key(now)
    };
    let seq = { state.history.lock().unwrap().day_seq(&day) + 1 };
    let id = {
        let h = state.history.lock().unwrap();
        h.insert(&sel.png, &thumb, &sel.rect, &sel.source, sel.app_hint.as_deref(), req.annotation_json.as_deref(), seq, sel.app_hint.as_deref().unwrap_or("capture"))
            .map_err(|e| ApiError { code: "save_failed", message: e })?
    };
    result["id"] = serde_json::json!(id);

    if req.op == "copy" || req.op == "copySave" {
        copy_to_clipboard(&state, &sel)?;
    }
    if req.op == "save" || req.op == "copySave" {
        let path = {
            let h = state.history.lock().unwrap();
            h.png_path(id).unwrap_or_default()
        };
        result["path"] = serde_json::json!(path.display().to_string());
        // 保存成功的可见反馈（此前"存图无效"实为静默成功）
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app
            .notification()
            .builder()
            .title("capshot 已保存")
            .body(path.display().to_string())
            .show()
        {
            log::warn!("save notification failed: {e}");
        }
    }
    if req.op == "pin" {
        let _ = windows::open_pin(&app, req.sel, &sel.rect);
    }
    // 关闭本会话 overlays
    close_session_overlays(&app, &state);
    log::info!("export_result done op={} id={}", req.op, result["id"]);
    Ok(result)
}

fn copy_to_clipboard(state: &AppState, sel: &Sel) -> Result<(), ApiError> {
    let bytes = sel.frame.densify();
    let mut guard = state.clip.lock().unwrap();
    if guard.is_none() {
        *guard = arboard::Clipboard::new().ok();
    }
    let clip = guard.as_mut().ok_or(ApiError { code: "platform_error", message: "clipboard unavailable".into() })?;
    clip.set_image(arboard::ImageData {
        width: sel.frame.width as usize,
        height: sel.frame.height as usize,
        bytes: std::borrow::Cow::Owned(bytes),
    })
    .map_err(|e| ApiError { code: "platform_error", message: format!("clipboard: {e}") })
}

#[tauri::command]
pub fn get_selection_png(sel: u64, state: State<'_, AppState>) -> Result<tauri::ipc::Response, ApiError> {
    let g = state.selections.lock().unwrap();
    let s = g.get(&sel).ok_or(ApiError { code: "target_not_found", message: "sel gone".into() })?;
    Ok(tauri::ipc::Response::new(s.png.clone()))
}

#[tauri::command]
pub async fn cancel_capture(token: u64, app: AppHandle, state: State<'_, AppState>) -> Result<(), ApiError> {
    log::info!("cancel_capture enter token={token}");
    let overlays: Vec<String> = {
        let mut g = state.sessions.lock().unwrap();
        if let Some(pos) = g.iter().position(|s| s.token == token) {
            g.remove(pos).map(|s| s.overlays).unwrap_or_default()
        } else {
            Vec::new()
        }
    };
    for l in overlays {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.close();
        }
    }
    log::info!("cancel_capture exit token={token}");
    // 注意：`if let Some(..) = *lock()` 的守卫会存活到块结束，体内再 lock() 即自死锁
    let should_clear = state
        .active
        .lock()
        .unwrap()
        .map(|(a, _)| a == token)
        .unwrap_or(false);
    if should_clear {
        *state.active.lock().unwrap() = None;
    }
    Ok(())
}

fn close_session_overlays(app: &AppHandle, state: &AppState) {
    let overlays: Vec<String> = state
        .sessions
        .lock()
        .unwrap()
        .iter()
        .flat_map(|s| s.overlays.iter().cloned())
        .collect();
    for l in overlays {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.close();
        }
    }
    *state.active.lock().unwrap() = None;
}

// ---------- pin 辅助 ----------

#[tauri::command]
pub fn pin_move(window: tauri::Window, x: i32, y: i32, w: u32, h: u32) -> Result<(), ApiError> {
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: w, height: h }));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    Ok(())
}

#[tauri::command]
pub fn pin_ignore_cursor(window: tauri::Window, on: bool) -> Result<(), ApiError> {
    window.set_ignore_cursor_events(on).map_err(|e| ApiError { code: "platform_error", message: e.to_string() })
}

// ---------- 历史 ----------

#[tauri::command]
pub fn list_history(limit: Option<i64>, offset: Option<i64>, state: State<'_, AppState>) -> serde_json::Value {
    let rows = state.history.lock().unwrap().list(limit.unwrap_or(60).min(200), offset.unwrap_or(0));
    serde_json::to_value(rows).unwrap_or(serde_json::json!([]))
}

#[tauri::command]
pub fn history_png(id: i64, state: State<'_, AppState>) -> Result<tauri::ipc::Response, ApiError> {
    let path = state.history.lock().unwrap().png_path(id).ok_or(ApiError { code: "target_not_found", message: "missing".into() })?;
    let bytes = std::fs::read(path).map_err(|e| ApiError { code: "save_failed", message: e.to_string() })?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn history_delete(id: i64, state: State<'_, AppState>) {
    state.history.lock().unwrap().delete(id);
}

#[tauri::command]
pub fn history_open_folder(id: i64, state: State<'_, AppState>) -> Result<(), ApiError> {
    let path = state.history.lock().unwrap().png_path(id).ok_or(ApiError { code: "target_not_found", message: "missing".into() })?;
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(windows)]
    let _ = std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn();
    Ok(())
}

// ---------- 权限 / 设置 ----------

#[tauri::command]
pub fn permission_status(state: State<'_, AppState>) -> serde_json::Value {
    serde_json::to_value(state.backend.permission_status()).unwrap_or_default()
}

#[tauri::command]
pub fn permission_request(state: State<'_, AppState>) -> String {
    use capture_core::PermissionOutcome;
    match state.backend.request_permission() {
        PermissionOutcome::Allowed => "allowed",
        PermissionOutcome::Prompted => "prompted",
        PermissionOutcome::Denied => "denied",
    }
    .to_string()
}

#[tauri::command]
pub fn permission_open_settings() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn();
    #[cfg(windows)]
    let _ = std::process::Command::new("ms-settings:privacy-screen-recapture").spawn();
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub hotkey: Option<String>,
    pub quality: Option<f64>,
    pub flash_ms: Option<u64>,
    pub autostart: Option<bool>,
    pub save_on_copy: Option<bool>,
}

#[tauri::command]
pub fn set_settings(app: AppHandle, patch: SettingsPatch, state: State<'_, AppState>) -> Result<serde_json::Value, ApiError> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let mut out = serde_json::json!({});
    {
        let mut s = state.settings.lock().unwrap();
        if let Some(q) = patch.quality {
            s.quality = q.clamp(0.1, 1.0);
        }
        if let Some(f) = patch.flash_ms {
            s.flash_ms = f.min(2000);
        }
        if let Some(v) = patch.save_on_copy {
            s.save_on_copy = v;
        }
    }
    if let Some(new_hk) = &patch.hotkey {
        let old = state.settings.lock().unwrap().hotkey.clone();
        if new_hk != &old {
            if let Err(e) = app.global_shortcut().register(new_hk.as_str()) {
                out["hotkeyError"] = serde_json::json!(format!("{e:?}"));
            } else {
                let _ = app.global_shortcut().unregister(old.as_str());
                let mut s = state.settings.lock().unwrap();
                s.hotkey = new_hk.clone();
                *state.current_shortcut.lock().unwrap() = Some(new_hk.clone());
                out["hotkey"] = serde_json::json!(new_hk);
            }
        }
    }
    if let Some(auto) = patch.autostart {
        use tauri_plugin_autostart::ManagerExt;
        let _ = if auto { app.autolaunch().enable() } else { app.autolaunch().disable() };
        let mut s = state.settings.lock().unwrap();
        s.autostart = auto;
    }
    state.save_settings();
    out["settings"] = serde_json::to_value(state.settings.lock().unwrap().clone()).unwrap_or_default();
    Ok(out)
}

/// 钉图窗口当前物理几何（前端缩放锚点用）。
#[tauri::command]
pub fn pin_bounds(window: tauri::Window) -> Result<serde_json::Value, ApiError> {
    // 用 inner（客户区）几何：钉图带阴影时 outer 比图像实际位置偏 8px，
    // 光标锚定缩放会错位
    let pos = window.inner_position().map_err(|e| ApiError { code: "platform_error", message: e.to_string() })?;
    let size = window.inner_size().map_err(|e| ApiError { code: "platform_error", message: e.to_string() })?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Ok(serde_json::json!({ "x": pos.x, "y": pos.y, "width": size.width, "height": size.height, "scale": scale }))
}

/// 历史 → 剪贴板。
#[tauri::command]
pub async fn history_copy(id: i64, state: State<'_, AppState>) -> Result<(), ApiError> {
    let path = state.history.lock().unwrap().png_path(id).ok_or(ApiError { code: "target_not_found", message: "missing".into() })?;
    let png = std::fs::read(path).map_err(|e| ApiError { code: "save_failed", message: e.to_string() })?;
    let frame = history::png_to_frame(&png).ok_or(ApiError { code: "degenerate_geometry", message: "decode".into() })?;
    let sel = Sel { frame, rect: PhysicalRect::ZERO, png, source: "history".into(), app_hint: None };
    copy_to_clipboard(&state, &sel)
}

/// 历史 → 新钉图。
#[tauri::command]
pub async fn history_pin(app: AppHandle, id: i64, state: State<'_, AppState>) -> Result<(), ApiError> {
    let path = state.history.lock().unwrap().png_path(id).ok_or(ApiError { code: "target_not_found", message: "missing".into() })?;
    let png = std::fs::read(path).map_err(|e| ApiError { code: "save_failed", message: e.to_string() })?;
    let frame = history::png_to_frame(&png).ok_or(ApiError { code: "degenerate_geometry", message: "decode".into() })?;
    let rect = {
        let h = state.history.lock().unwrap();
        let (x, y, w, hh) = h.rect_of(id).unwrap_or((100, 100, frame.width, frame.height));
        PhysicalRect::new(x, y, w, hh)
    };
    let sel = state.next_id();
    state.selections.lock().unwrap().insert(
        sel,
        Sel { frame, rect, png, source: "history".into(), app_hint: None },
    );
    let label = format!("pin-{sel}");
    if app.get_webview_window(&label).is_none() {
        let _ = windows::open_pin(&app, sel, &rect);
    }
    Ok(())
}

// ---------- 打开固定窗口 ----------

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), ApiError> {
    windows::open_simple(&app, "settings", "settings.html", 520.0, 560.0)
        .map_err(|e| ApiError { code: "platform_error", message: e.to_string() })
}

#[tauri::command]
pub fn open_history_window(app: AppHandle) -> Result<(), ApiError> {
    windows::open_simple(&app, "history", "history.html", 760.0, 560.0)
        .map_err(|e| ApiError { code: "platform_error", message: e.to_string() })
}

// ---------- helpers：CaptureError→ApiError（带 Clone 以复用） ----------

pub trait ApiErr {
    fn clone_serde(&self) -> CaptureError;
    fn into_api(&self) -> ApiError;
}
impl ApiErr for CaptureError {
    fn clone_serde(&self) -> CaptureError {
        match self {
            CaptureError::PermissionDenied(k) => CaptureError::PermissionDenied(*k),
            CaptureError::TargetNotFound => CaptureError::TargetNotFound,
            CaptureError::DegenerateGeometry(s) => CaptureError::DegenerateGeometry(s),
            CaptureError::WindowImageTooSmall { window, got, expect } => {
                CaptureError::WindowImageTooSmall { window: *window, got: *got, expect: *expect }
            }
            CaptureError::BackendUnavailable(s) => CaptureError::BackendUnavailable(s),
            CaptureError::Platform { api, os_status } => CaptureError::Platform { api, os_status: os_status.clone() },
        }
    }
    fn into_api(&self) -> ApiError {
        ApiError::from(self.clone_serde())
    }
}

