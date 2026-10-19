//! Windows probe CLI —— M3 验收工具（与 capture-macos probe 同形 JSON）。
//! 需在 Windows 上运行；mac 上仅 `cargo check` 验证类型正确。

#[cfg(windows)]
use capture_core::{encode, plan, CaptureBackend};
#[cfg(windows)]
use capture_windows::WindowsBackend;
#[cfg(windows)]
use std::collections::HashSet;

#[cfg(windows)]
fn print_json(v: serde_json::Value) {
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}

#[cfg(windows)]
fn body() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let be = WindowsBackend::new().expect("backend");
    let Some(cmd) = args.first().map(|s| s.as_str()) else {
        eprintln!("usage: probe <permission|list|target|monitor|window> [id] [--out PATH] [--jpeg] [--snap]");
        std::process::exit(2);
    };
    let opt_out = args.iter().position(|a| a == "--out").and_then(|i| args.get(i + 1)).cloned();
    let flag = |n: &str| args.iter().any(|a| a == n);
    let pos_id = || -> u64 {
        let mut skip = false;
        for a in args.iter().skip(1) {
            if skip { skip = false; continue; }
            if a == "--out" { skip = true; continue; }
            if a.starts_with("--") { continue; }
            if let Ok(v) = a.parse::<u64>() { return v; }
        }
        0
    };
    match cmd {
        "permission" => print_json(serde_json::json!({ "success": true, "permissionStatus": be.permission_status() })),
        "list" => {
            let ws = be.list_windows().unwrap();
            if flag("--snap") {
                let ms = be.monitors().unwrap();
                let cands = plan::snap_candidates(&ws, &HashSet::new(), std::process::id());
                let out: Vec<_> = cands.iter().map(|w| serde_json::json!({
                    "windowId": w.id, "title": w.title, "appName": w.app_name,
                    "effective": plan::effective_capture_rect(w, &ms),
                    "visibleAreaRatio": plan::visible_area_ratio(w, &ms),
                    "fullscreen": plan::is_fullscreen_window(w, &ms) })).collect();
                print_json(serde_json::json!({ "success": true, "candidates": out }));
            } else {
                print_json(serde_json::json!({ "success": true, "windows": ws }));
            }
        }
        "target" => {
            let ms = be.monitors().unwrap();
            let ws = be.list_windows().unwrap();
            let cands = plan::snap_candidates(&ws, &HashSet::new(), std::process::id());
            let Some(w) = plan::best_snap_target(&cands, None, &ms) else {
                print_json(serde_json::json!({ "success": false, "errorCode": "no_target" }));
                return;
            };
            let frame = plan::effective_capture_rect(w, &ms);
            let scale = ms.iter().find(|m| m.bounds.contains(frame.mid_x(), frame.mid_y())).map(|m| m.scale_factor).unwrap_or(1.0);
            let mut via = "window";
            let img = match be.capture_window(w.id) {
                Ok(f) if !plan::window_image_too_small((f.width, f.height), &frame, scale) => f,
                _ => {
                    via = "screenFrame";
                    // 兜底：主显示器整幅（真实产品里是冻结帧裁剪）
                    let id = ms.iter().find(|m| m.is_primary).or(ms.first()).map(|m| m.id).unwrap_or(0);
                    be.capture_monitor(id).expect("monitor")
                }
            };
            let bytes = encode::to_png(&img).unwrap();
            if let Some(o) = opt_out.as_ref() { std::fs::write(o, &bytes).unwrap(); }
            print_json(serde_json::json!({ "success": true, "via": via, "target": {
                "windowId": w.id, "pid": w.pid, "title": w.title, "frame": frame, "scale": scale,
                "bundleIdentifier": w.app_id },
                "width": img.width, "height": img.height, "saved": opt_out }));
        }
        "monitor" => {
            let ms = be.monitors().unwrap();
            let raw = pos_id();
            let id = if raw == 0 { ms.first().map(|m| m.id).unwrap_or(0) } else { raw };
            let img = be.capture_monitor(id).unwrap();
            let bytes = encode::to_png(&img).unwrap();
            if let Some(o) = opt_out.as_ref() { std::fs::write(o, &bytes).unwrap(); }
            print_json(serde_json::json!({ "success": true, "monitor": id, "width": img.width, "height": img.height, "saved": opt_out }));
        }
        "window" => {
            let id = pos_id();
            let img = be.capture_window(id).unwrap();
            let bytes = encode::to_png(&img).unwrap();
            if let Some(o) = opt_out.as_ref() { std::fs::write(o, &bytes).unwrap(); }
            print_json(serde_json::json!({ "success": true, "window": id, "width": img.width, "height": img.height, "saved": opt_out }));
        }
        other => println!("{{\"success\":false,\"error\":\"{other}\"}}"),
    }
}

#[cfg(not(windows))]
fn body() {}

fn main() {
    if cfg!(windows) { body(); } else { println!("{{\"success\":false,\"error\":\"windows-only\"}}"); }
}
