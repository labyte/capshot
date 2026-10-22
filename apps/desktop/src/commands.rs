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
            // 兜底：前端就绪信号丢失（webview 异常）时强制显示，避免隐形窗口。
            // dev 模式要等 Vite 首次按需转译整条 React 依赖图，1.2s 明显不够 ——
            // 抢在首帧前 show 就是一个盖住整屏的透明空窗，故 debug 放宽到 3s。
            let app4 = app3.clone();
            let force_show_ms: u64 = if cfg!(debug_assertions) { 3000 } else { 1200 };
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(force_show_ms));
                for l in &overlays {
                    if let Some(w) = app4.get_webview_window(l) {
                        if !w.is_visible().unwrap_or(true) {
                            log::warn!("overlay {l} not shown by frontend within {force_show_ms}ms — forcing visible");
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
            // H 键恢复上次选区。与上面 sessions 锁是两把不同的 mutex，嵌套持有是安全的；
            // 真正要避免的是同锁重入（见 cancel_capture 的注释）
            "lastRect": *state.last_rect.lock().unwrap(),
        }));
    }
    if let Some(rest) = label.strip_prefix("editor-") {
        let sel: u64 = rest.parse().map_err(|_| ApiError { code: "bad_label", message: label })?;
        let g = state.selections.lock().unwrap();
        let s = g.get(&sel).ok_or(ApiError { code: "target_not_found", message: "sel gone".into() })?;
        return Ok(serde_json::json!({
            "kind": "editor", "sel": sel,
            "width": s.frame.width, "height": s.frame.height,
            "bounds": { "x": 0, "y": 0, "width": s.frame.width, "height": s.frame.height },
            "scale": window.scale_factor().unwrap_or(1.0),
            "annotation": s.annotation,
            "settings": *state.settings.lock().unwrap(),
        }));
    }
    if let Some(rest) = label.strip_prefix("pin-") {
        let sel: u64 = rest.parse().map_err(|_| ApiError { code: "bad_label", message: label })?;
        let g = state.selections.lock().unwrap();
        let s = g.get(&sel).ok_or(ApiError { code: "target_not_found", message: "sel gone".into() })?;
        return Ok(serde_json::json!({ "kind": "pin", "sel": sel, "width": s.frame.width, "height": s.frame.height,
            // 贴图窗四周留白，前端据此把「图像矩形」与「窗口矩形」互相换算
            "pad": crate::windows::PIN_PAD }));
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
        Sel { frame, rect, png, source, app_hint, annotation: None },
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
        Sel { frame, rect, png, source: "window".into(), app_hint: None, annotation: None },
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
pub async fn export_result(
    app: AppHandle,
    webview_window: tauri::WebviewWindow,
    req: ExportReq,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, ApiError> {
    export_core(&app, &webview_window, &req, &state)
}

/// 导出核心：命令面与贴图右键菜单走同一条路径（菜单原先想复用只能把入库逻辑整段复制）。
/// 声明为同步函数 —— 函数体里本来就没有 await。
/// parent = 发起导出的窗口（截图层/贴图窗），另存为对话框挂它下面才能浮在置顶窗之上。
pub fn export_core(
    app: &AppHandle,
    parent: &tauri::WebviewWindow,
    req: &ExportReq,
    state: &AppState,
) -> Result<serde_json::Value, ApiError> {
    log::info!("export_result enter op={} sel={}", req.op, req.sel);
    let sel = {
        let mut g = state.selections.lock().unwrap();
        let s = g.get_mut(&req.sel).ok_or(ApiError { code: "target_not_found", message: "sel gone".into() })?;
        if let Some(b64) = &req.png_base64 {
            let bytes = base64_decode(b64).ok_or(ApiError { code: "degenerate_geometry", message: "bad png b64".into() })?;
            s.png = bytes;
            s.frame = history::png_to_frame(&s.png).ok_or(ApiError { code: "degenerate_geometry", message: "png decode".into() })?;
        }
        // 把标注一并留在 sel 上，贴图菜单的「重新编辑」才能还原成可编辑图形而不是已烘焙的像素
        if req.annotation_json.is_some() {
            s.annotation = req.annotation_json.clone();
        }
        Sel {
            frame: s.frame.clone(),
            rect: s.rect,
            png: s.png.clone(),
            source: s.source.clone(),
            app_hint: s.app_hint.clone(),
            annotation: s.annotation.clone(),
        }
    };

    let mut result = serde_json::json!({ "op": req.op });

    // 保存：先弹「另存为」让用户选位置，而不是直接落到默认历史目录。
    // 取消 → 整次保存作废（不写历史、不关截图层），用户可继续标注或改走复制。
    let save_target = if req.op == "save" || req.op == "copySave" {
        match pick_save_path(app, parent) {
            Some(p) => Some(p),
            None => {
                log::info!("export_result save cancelled");
                return Ok(serde_json::json!({ "op": req.op, "cancelled": true }));
            }
        }
    } else {
        None
    };

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
        copy_to_clipboard(state, &sel)?;
    }
    if req.op == "save" || req.op == "copySave" {
        // 写用户选定的路径；历史目录里那份是内部留档（供历史面板/重编辑），两者并存
        let target = save_target.unwrap_or_default();
        std::fs::write(&target, &sel.png)
            .map_err(|e| ApiError { code: "save_failed", message: e.to_string() })?;
        result["path"] = serde_json::json!(target.display().to_string());
        // 保存成功的可见反馈（此前"存图无效"实为静默成功）
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app
            .notification()
            .builder()
            .title("CapsShot 已保存")
            .body(target.display().to_string())
            .show()
        {
            log::warn!("save notification failed: {e}");
        }
    }
    if req.op == "pin" {
        match windows::open_pin(app, req.sel, &sel.rect) {
            Ok(label) => schedule_pin_force_show(app, label),
            Err(e) => log::error!("open_pin failed: {e}"),
        }
    }
    // 记住这次选区，供下次截图的「H 恢复上次选区」使用（虚拟屏物理坐标）
    if sel.rect.width > 0 && sel.rect.height > 0 {
        *state.last_rect.lock().unwrap() = Some(sel.rect);
    }

    // 关闭本会话 overlays
    close_session_overlays(app, state);
    log::info!("export_result done op={} id={}", req.op, result["id"]);
    Ok(result)
}

/// 「另存为」原生对话框：默认名走历史同一时间戳模板，PNG 过滤器。
/// 返回 None = 用户取消。blocking：命令在 tokio 工作线程上跑，不卡主线程。
fn pick_save_path(app: &AppHandle, parent: &tauri::WebviewWindow) -> Option<std::path::PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        // 挂到发起窗口下：截图层/贴图窗是 always-on-top，无属主的原生对话框会被它盖住看不见
        .set_parent(parent)
        .add_filter("PNG 图片", &["png"])
        .set_file_name(&history::default_save_name())
        .blocking_save_file()
        .and_then(|fp| fp.into_path().ok())
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

/// 贴图窗前端解码完图像后调用：此刻才显示，避免先亮出一块深色空窗。
#[tauri::command]
pub fn pin_ready(window: tauri::WebviewWindow) -> Result<(), ApiError> {
    window.show().map_err(|e| ApiError { code: "platform_error", message: e.to_string() })?;
    let _ = window.set_focus();
    Ok(())
}

/// 兜底：webview 异常没调 pin_ready 时，别让贴图永远是隐形窗口
fn schedule_pin_force_show(app: &AppHandle, label: String) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        if let Some(w) = app.get_webview_window(&label) {
            if !w.is_visible().unwrap_or(true) {
                log::warn!("pin {label} not shown by frontend within 900ms — forcing visible");
                let _ = w.show();
            }
        }
    });
}

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
    pub hotkey_pin: Option<String>,
    pub hotkey_hide_pins: Option<String>,
    /// 空串 = 解绑（Snipaste 当前也不给穿透默认键）
    pub hotkey_through: Option<String>,
    pub quality: Option<f64>,
    pub flash_ms: Option<u64>,
    pub autostart: Option<bool>,
    pub save_on_copy: Option<bool>,
}

#[tauri::command]
pub fn set_settings(app: AppHandle, patch: SettingsPatch, state: State<'_, AppState>) -> Result<serde_json::Value, ApiError> {
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
    // 快捷键：先落到 settings，再逐槽重注册。有任何一槽失败就把 settings 整体回滚、
    // 重绑一次 —— 回滚之所以安全，是因为 rebind_all 是逐槽的：旧键从未被提前注销，
    // 重新按旧 settings 走一遍会把它们原样认回来。
    let hotkey_changed = patch.hotkey.is_some()
        || patch.hotkey_pin.is_some()
        || patch.hotkey_hide_pins.is_some()
        || patch.hotkey_through.is_some();
    if hotkey_changed {
        let before = state.settings.lock().unwrap().clone();
        {
            let mut s = state.settings.lock().unwrap();
            if let Some(v) = &patch.hotkey { s.hotkey = v.clone(); }
            if let Some(v) = &patch.hotkey_pin { s.hotkey_pin = v.clone(); }
            if let Some(v) = &patch.hotkey_hide_pins { s.hotkey_hide_pins = v.clone(); }
            if let Some(v) = &patch.hotkey_through { s.hotkey_through = v.clone(); }
        }
        if let Err(e) = rebind_all(&app) {
            *state.settings.lock().unwrap() = before.clone();
            if let Err(e2) = rebind_all_keep_report(&app) {
                log::error!("shortcut rollback failed: {e2}");
            }
            out["hotkeyError"] = serde_json::json!(e);
        } else {
            out["hotkey"] = serde_json::json!(state.settings.lock().unwrap().hotkey);
            out["hotkeyPin"] = serde_json::json!(state.settings.lock().unwrap().hotkey_pin);
        }
    }
    if let Some(auto) = patch.autostart {
        use tauri_plugin_autostart::ManagerExt;
        let _ = if auto { app.autolaunch().enable() } else { app.autolaunch().disable() };
        let mut s = state.settings.lock().unwrap();
        s.autostart = auto;
    }
    state.save_settings();
    if hotkey_changed {
        // 托盘 tooltip 里带着截图/贴图快捷键，改键后必须同步
        crate::refresh_tray_tooltip(&app);
    }
    out["settings"] = serde_json::to_value(state.settings.lock().unwrap().clone()).unwrap_or_default();
    Ok(out)
}

/// 关于窗口：定尺寸信息卡，展示软件名 / 版本 / 快捷键。
#[tauri::command]
pub fn open_about_window(app: AppHandle) -> Result<(), ApiError> {
    windows::open_simple(&app, "about", "about.html", 380.0, 400.0)
        .map_err(|e| ApiError { code: "platform_error", message: e.to_string() })
}

/// 关于页数据。version 取 tauri.conf.json 的 package_info（与 bundle 一致）。
#[tauri::command]
pub fn about_info(app: AppHandle, state: State<'_, AppState>) -> serde_json::Value {
    let (snip, pin, hide) = {
        let s = state.settings.lock().unwrap();
        (s.hotkey.clone(), s.hotkey_pin.clone(), s.hotkey_hide_pins.clone())
    };
    serde_json::json!({
        "name": "CapsShot",
        "version": app.package_info().version.to_string(),
        "hotkey": snip,
        "hotkeyPin": pin,
        "hotkeyHidePins": hide,
    })
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
    let sel = Sel { frame, rect: PhysicalRect::ZERO, png, source: "history".into(), app_hint: None, annotation: None };
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
        Sel { frame, rect, png, source: "history".into(), app_hint: None, annotation: None },
    );
    let label = format!("pin-{sel}");
    if app.get_webview_window(&label).is_none() {
        if let Ok(l) = windows::open_pin(&app, sel, &rect) {
            schedule_pin_force_show(&app, l);
        }
    }
    Ok(())
}

// ---------- 全局快捷键（四槽） ----------

use crate::state::{Shortcut, ShortcutAction};

/// 单一 handler 的落点：按「哪把键触发」分派。存的是解析后的 Shortcut，
/// 不能用字符串比（Display 是大写规范名）。
pub fn dispatch_shortcut(app: &AppHandle, shortcut: &Shortcut) {
    let action = {
        let state = app.state::<AppState>();
        let g = state.bindings.lock().unwrap();
        g.iter().find(|(s, _)| s == shortcut).map(|(_, a)| *a)
    };
    match action {
        Some(ShortcutAction::Snip) => trigger_capture(app),
        Some(ShortcutAction::PinClipboard) => {
            if let Err(e) = pin_from_clipboard(app.clone()) {
                log::warn!("pin_from_clipboard: {e:?}");
            }
        }
        Some(ShortcutAction::TogglePins) => {
            let _ = toggle_pins_visible(app.clone());
        }
        Some(ShortcutAction::ToggleThrough) => {
            let _ = toggle_through_pins(app);
        }
        None => {}
    }
}

/// 按当前 settings 逐槽重注册快捷键。
///
/// 每个槽位独立「先注册新键 → 成功才注销旧键」。不能做成
/// `unregister_all()` + 整批 `register_multiple()`：那样只要有一把键被别的程序
/// 占了（实测 F1 就撞过 `HotKey already registered`），整批注册一起失败，
/// 回滚时旧表又已经被注销掉 —— 用户会一把键都不剩。逐槽最坏只损失那一槽。
pub fn rebind_all(app: &AppHandle) -> Result<usize, String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let state = app.state::<AppState>();
    let desired: Vec<(String, ShortcutAction)> = state.settings.lock().unwrap().bindings();
    let gs = app.global_shortcut();

    let mut registered: Vec<(Shortcut, ShortcutAction)> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    for (raw, action) in desired {
        let shortcut = match raw.parse::<Shortcut>() {
            Ok(s) => s,
            Err(e) => {
                failed.push(format!("{raw}（解析失败：{e}）"));
                continue;
            }
        };
        // 已经注册着且动作没变 → 原样保留
        if state
            .bindings
            .lock()
            .unwrap()
            .iter()
            .any(|(s, a)| *s == shortcut && *a == action)
        {
            registered.push((shortcut, action));
            continue;
        }
        match gs.register(shortcut) {
            Ok(()) => {
                // 新键生效后才撤旧键：撤的是同 action 的旧绑定
                let stale: Vec<Shortcut> = state
                    .bindings
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(_, a)| *a == action)
                    .map(|(s, _)| *s)
                    .filter(|s| *s != shortcut)
                    .collect();
                for s in stale {
                    if let Err(e) = gs.unregister(s) {
                        log::warn!("旧快捷键注销失败 {s:?}: {e}");
                    }
                }
                registered.push((shortcut, action));
            }
            Err(e) => {
                // 关键：新键没配上，就得把这一槽原来的旧键**留在表里** ——
                // 它在系统侧仍是注册状态，从表里剔掉的话按键会没人分派，变成哑键
                let prev = state
                    .bindings
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|(_, a)| *a == action)
                    .map(|(s, a)| (*s, *a));
                if let Some(p) = prev {
                    if !registered.contains(&p) {
                        registered.push(p);
                    }
                }
                failed.push(format!("{raw}（注册失败：{e}）"));
            }
        }
    }

    // 撞键保护：同一把物理键不能占两个动作槽
    let mut seen: Vec<(Shortcut, ShortcutAction)> = Vec::new();
    for entry in &registered {
        if seen.iter().any(|(s, _)| *s == entry.0) && seen.iter().any(|(s, a)| *s == entry.0 && *a != entry.1) {
            failed.push(format!("{:?} 被多个动作占用", entry.0));
        }
        seen.push(*entry);
    }

    *state.bindings.lock().unwrap() = registered.clone();
    *state.hotkey_errors.lock().unwrap() = failed.clone();
    if failed.is_empty() {
        Ok(registered.len())
    } else {
        // 部分成功：已经注册上的槽位保持可用，调用方按 failed 提示用户
        Err(failed.join(" | "))
    }
}

/// 回滚用的重绑：语义与 rebind_all 相同，但**不改** hotkey_errors。
/// 否则改键失败→回滚成功→错误被清空，用户重开设置窗时那条
/// 「默认键被别的程序占了」的提示就凭空消失了。
fn rebind_all_keep_report(app: &AppHandle) -> Result<usize, String> {
    let state = app.state::<AppState>();
    let saved = state.hotkey_errors.lock().unwrap().clone();
    let r = rebind_all(app);
    *state.hotkey_errors.lock().unwrap() = saved;
    r
}

/// 前端可见的快捷键状态：注册失败必须说得出是哪一槽、为什么
/// （本机实测：Snipaste 在跑时 F1/F3/Shift+F3 全部撞键）
#[tauri::command]
pub fn hotkey_status(state: State<'_, AppState>) -> serde_json::Value {
    let errors = state.hotkey_errors.lock().unwrap().clone();
    let registered = state.bindings.lock().unwrap().len();
    serde_json::json!({ "errors": errors, "registered": registered })
}

// ---------- 贴图：剪贴板 / 可见性 / 穿透 / 菜单 ----------

/// F3：剪贴板有图就贴它，没有就复活最近关掉的那张贴图（Snipaste 语义）
#[tauri::command]
pub fn pin_from_clipboard(app: AppHandle) -> Result<serde_json::Value, ApiError> {
    let state = app.state::<AppState>();
    let clipboard_img = {
        let mut guard = state.clip.lock().unwrap();
        if guard.is_none() {
            *guard = arboard::Clipboard::new().ok();
        }
        match guard.as_mut() {
            Some(clip) => clip.get_image().ok(),
            None => None,
        }
    };
    let frame = match clipboard_img {
        Some(data) => Frame::new(
            data.width as u32,
            data.height as u32,
            data.width * 4,
            data.bytes.into_owned(),
        )
        .ok_or(ApiError { code: "degenerate_geometry", message: "clipboard image size".into() })?,
        None => {
            let revived = state.take_closed_sel().ok_or(ApiError {
                code: "clipboard_no_image",
                message: "剪贴板没有图片，也没有可恢复的贴图".into(),
            })?;
            revived.frame
        }
    };
    let dims = (frame.width, frame.height);
    let png = capture_core::encode::to_png(&frame)?;
    let sel = state.next_id();
    state.selections.lock().unwrap().insert(
        sel,
        Sel { frame, rect: PhysicalRect::ZERO, png, source: "clipboard".into(), app_hint: None, annotation: None },
    );
    let label =
        windows::open_pin_at_cursor(&app, sel, dims.0, dims.1).map_err(|e| ApiError {
            code: "platform_error",
            message: e.to_string(),
        })?;
    schedule_pin_force_show(&app, label);
    Ok(serde_json::json!({ "sel": sel }))
}

/// Shift+F3：隐藏/显示全部贴图
#[tauri::command]
pub fn toggle_pins_visible(app: AppHandle) -> Result<bool, ApiError> {
    let state = app.state::<AppState>();
    let hide = !*state.pins_hidden.lock().unwrap();
    for (label, w) in app.webview_windows() {
        if !label.starts_with("pin-") {
            continue;
        }
        if hide {
            let _ = w.hide();
        } else {
            let _ = w.show();
        }
    }
    *state.pins_hidden.lock().unwrap() = hide;
    log::info!("pins visible toggled -> hidden={hide}");
    Ok(hide)
}

/// 用户自定义的穿透热键（默认为空）。穿透是全局态，热键触发时没有「哪一张」的上下文，
/// 因此按光标命中的贴图切换；命不中就把全部穿透清掉（Snipaste 同语义）。
///
/// 穿透态存在 `AppState::pin_through` —— tauri 只有 set_ignore_cursor_events 的 setter，
/// 没有 getter，不自己记就无从切换。
pub fn toggle_through_pins(app: &AppHandle) -> Result<(), ApiError> {
    let state = app.state::<AppState>();
    let windows = app.webview_windows();

    let hit: Option<(String, u64)> = windows.iter().find_map(|(label, w)| {
        let sel = label.strip_prefix("pin-")?.parse::<u64>().ok()?;
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else { return None };
        let Ok(cursor) = w.cursor_position() else { return None };
        let inside = cursor.x >= pos.x as f64
            && cursor.y >= pos.y as f64
            && cursor.x < (pos.x + size.width as i32) as f64
            && cursor.y < (pos.y + size.height as i32) as f64;
        inside.then(|| (label.clone(), sel))
    });

    match hit {
        Some((label, sel)) => {
            let on = state.pin_through.lock().unwrap().remove(&sel);
            if let Some(w) = windows.get(&label) {
                let _ = w.set_ignore_cursor_events(!on);
                let _ = app.emit_to(&label, "pin-menu", serde_json::json!({ "action": if on { "through-off" } else { "through-on" } }));
            }
            if !on {
                state.pin_through.lock().unwrap().insert(sel);
            }
        }
        None => {
            clear_all_through(app);
        }
    }
    Ok(())
}

/// 托盘兜底：穿透中的贴图收不到鼠标事件，必须留一条不依赖它自己的恢复路径
fn clear_all_through(app: &AppHandle) {
    let state = app.state::<AppState>();
    let set: Vec<u64> = state.pin_through.lock().unwrap().iter().copied().collect();
    for sel in set {
        if let Some(w) = app.get_webview_window(&format!("pin-{sel}")) {
            let _ = w.set_ignore_cursor_events(false);
            let _ = app.emit_to(w.label(), "pin-menu", serde_json::json!({ "action": "through-off" }));
        }
    }
    state.pin_through.lock().unwrap().clear();
}

#[tauri::command]
pub fn clear_through_pins(app: AppHandle) {
    clear_all_through(&app);
}

#[tauri::command]
pub fn close_all_pins(app: AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with("pin-") {
            let _ = w.close();
        }
    }
}

/// 贴图右键菜单走 JS 的 `@tauri-apps/api/menu`（core:menu:default 已授予全部菜单命令）。
/// 这里只保留 JS 自己做不到、必须回到宿主的两件事：置顶与鼠标穿透。
///
/// 穿透态记在 `AppState::pin_through` —— tauri 只有 setter、**没有 getter**，
/// 不自己记就无从切换，也没法在托盘上兜底恢复。
#[tauri::command]
pub fn pin_set_through(window: tauri::WebviewWindow, on: bool) -> Result<(), ApiError> {
    let state = window.app_handle().state::<AppState>();
    let sel = window.label().strip_prefix("pin-").and_then(|s| s.parse::<u64>().ok());
    window
        .set_ignore_cursor_events(on)
        .map_err(|e| ApiError { code: "platform_error", message: e.to_string() })?;
    if let Some(sel) = sel {
        let mut g = state.pin_through.lock().unwrap();
        if on {
            g.insert(sel);
        } else {
            g.remove(&sel);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn pin_set_top(window: tauri::WebviewWindow, on: bool) -> Result<(), ApiError> {
    // 用宿主 API 改置顶，避免为此再开一条 core:window:allow-set-always-on-top 授权
    window
        .set_always_on_top(on)
        .map_err(|e| ApiError { code: "platform_error", message: e.to_string() })
}

/// 贴图窗销毁时记下这条 Sel，供 F3 复活（Snipaste 的"可恢复关闭"）
pub fn note_pin_closed(app: &AppHandle, sel: u64) {
    let state = app.state::<AppState>();
    let owned = {
        let g = state.selections.lock().unwrap();
        g.get(&sel).map(|s| Sel {
            frame: s.frame.clone(),
            rect: s.rect,
            png: s.png.clone(),
            source: s.source.clone(),
            app_hint: s.app_hint.clone(),
            annotation: s.annotation.clone(),
        })
    };
    if let Some(s) = owned {
        state.push_closed_sel(s);
    }
}

// ---------- 打开固定窗口 ----------

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), ApiError> {
    windows::open_simple(&app, "settings", "settings.html", 520.0, 560.0)
        .map_err(|e| ApiError { code: "platform_error", message: e.to_string() })
}

/// 重新编辑器。贴图菜单与历史窗共用：入参恒为 sel id（历史条目先物化成 sel）。
pub fn open_editor(app: &AppHandle, sel: u64) -> Result<(), ApiError> {
    let state = app.state::<AppState>();
    let dims = {
        let g = state.selections.lock().unwrap();
        let s = g.get(&sel).ok_or(ApiError { code: "target_not_found", message: "sel gone".into() })?;
        (s.frame.width, s.frame.height)
    };
    windows::open_editor(app, sel, dims.0, dims.1)
        .map_err(|e| ApiError { code: "platform_error", message: e.to_string() })?;
    Ok(())
}

#[tauri::command]
pub fn open_editor_window(app: AppHandle, sel: u64) -> Result<(), ApiError> {
    open_editor(&app, sel)
}

/// 历史条目 → 重编辑：读 PNG + 已存的 annotationJson，物化成一个新的 Sel 再开编辑窗。
/// 导出仍走 export_result（每次插新条目），所以是**另存为新条目**，原条目不动。
#[tauri::command]
pub fn history_edit(id: i64, app: AppHandle, state: State<'_, AppState>) -> Result<serde_json::Value, ApiError> {
    let (png, annotation) = {
        let h = state.history.lock().unwrap();
        let path = h.png_path(id).ok_or(ApiError { code: "target_not_found", message: "missing".into() })?;
        (std::fs::read(path).map_err(|e| ApiError { code: "save_failed", message: e.to_string() })?, h.annotation_of(id))
    };
    let frame = history::png_to_frame(&png).ok_or(ApiError { code: "degenerate_geometry", message: "png decode".into() })?;
    let rect = {
        let h = state.history.lock().unwrap();
        match h.rect_of(id) {
            Some((x, y, w, hh)) => PhysicalRect::new(x, y, w, hh),
            None => PhysicalRect::ZERO,
        }
    };
    let sel = state.next_id();
    state.selections.lock().unwrap().insert(
        sel,
        Sel { frame, rect, png, source: "history".into(), app_hint: Some(format!("history:{id}")), annotation },
    );
    open_editor(&app, sel)?;
    Ok(serde_json::json!({ "sel": sel }))
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

