//! macOS probe CLI —— M2 验收工具，JSON 形与参考实现原型对照。
//!
//!   cargo run -p capture-macos --example probe -- permission
//!   cargo run -p capture-macos --example probe -- list [--snap]
//!   cargo run -p capture-macos --example probe -- target [--out /tmp/t.png] [--jpeg]
//!   cargo run -p capture-macos --example probe -- monitor [id] --out /tmp/m.png
//!   cargo run -p capture-macos --example probe -- window <id> --out /tmp/w.png

#[cfg(target_os = "macos")]
use capture_core::{encode, plan, CaptureBackend};
#[cfg(target_os = "macos")]
use capture_macos::MacOsBackend;
#[cfg(target_os = "macos")]
use std::collections::HashSet;

#[cfg(target_os = "macos")]
fn die(e: impl std::fmt::Debug) -> ! {
    println!(
        "{{\"success\":false,\"error\":{}}}",
        serde_json::to_string(&format!("{e:?}")).unwrap()
    );
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
fn print_json(v: serde_json::Value) {
    println!("{}", serde_json::to_string_pretty(&v).unwrap());
}

#[cfg(target_os = "macos")]
fn save(img: &capture_core::Frame, out: &str, jpeg: bool) -> serde_json::Value {
    let bytes = if jpeg {
        encode::to_jpeg(img, encode::DEFAULT_JPEG_QUALITY).unwrap_or_else(|e| die(e))
    } else {
        encode::to_png(img).unwrap_or_else(|e| die(e))
    };
    std::fs::write(out, &bytes).unwrap_or_else(|e| die(e));
    serde_json::json!({ "path": out, "bytes": bytes.len(), "width": img.width, "height": img.height })
}

#[cfg(target_os = "macos")]
fn body() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let be = match MacOsBackend::new() {
        Some(b) => b,
        None => die("macos backend unavailable"),
    };
    let Some(cmd) = args.first().map(|s| s.as_str()) else {
        eprintln!("usage: probe <permission|list|target|monitor|window> [id] [--out PATH] [--jpeg] [--snap]");
        std::process::exit(2);
    };
    let flag = |name: &str| args.iter().any(|a| a == name);
    let opt_out = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .cloned();
    // 第一个数值位置参数（跳过 --out 的取值）
    let positional_id = || -> u64 {
        let mut skip_next = false;
        for a in args.iter().skip(1) {
            if skip_next {
                skip_next = false;
                continue;
            }
            if a == "--out" {
                skip_next = true;
                continue;
            }
            if a.starts_with("--") {
                continue;
            }
            if let Ok(v) = a.parse::<u64>() {
                return v;
            }
        }
        0
    };

    match cmd {
        "permission" => {
            print_json(serde_json::json!({ "success": true, "permissionStatus": be.permission_status() }));
        }
        "list" => {
            let ws = be.list_windows().unwrap_or_else(|e| die(e));
            if flag("--snap") {
                let ms = be.monitors().unwrap_or_else(|e| die(e));
                let cands = plan::snap_candidates(&ws, &HashSet::new(), std::process::id());
                let out: Vec<_> = cands
                    .iter()
                    .map(|w| {
                        serde_json::json!({
                            "windowId": w.id,
                            "title": w.title,
                            "appName": w.app_name,
                            "effective": plan::effective_capture_rect(w, &ms),
                            "visibleAreaRatio": plan::visible_area_ratio(w, &ms),
                            "fullscreen": plan::is_fullscreen_window(w, &ms),
                        })
                    })
                    .collect();
                print_json(serde_json::json!({ "success": true, "candidates": out }));
            } else {
                print_json(serde_json::json!({ "success": true, "windows": ws }));
            }
        }
        "target" => {
            // 复刻参考链：吸附候选最顶 → 两级抓取（窗口图 too-small 则显示器帧）
            let ms = be.monitors().unwrap_or_else(|e| die(e));
            let ws = be.list_windows().unwrap_or_else(|e| die(e));
            let cands = plan::snap_candidates(&ws, &HashSet::new(), std::process::id());
            let Some(w) = plan::best_snap_target(&cands, None, &ms) else {
                print_json(serde_json::json!({ "success": false, "errorCode": "no_target" }));
                return;
            };
            let frame = plan::effective_capture_rect(w, &ms); // physical px
            let scale = ms
                .iter()
                .find(|m| m.bounds.contains(frame.mid_x(), frame.mid_y()))
                .or_else(|| ms.iter().find(|m| m.is_primary))
                .map(|m| m.scale_factor)
                .unwrap_or(2.0);
            let mut via = "window";
            // frame(px)→pt 供 too-small 用期望点尺寸：plan 接口按 pt*scale 比较
            let frame_pt = capture_core::PhysicalRect::new(
                (frame.min_x() as f64 / scale).round() as i32,
                (frame.min_y() as f64 / scale).round() as i32,
                (frame.width as f64 / scale).round() as u32,
                (frame.height as f64 / scale).round() as u32,
            );
            let img = match be.capture_window(w.id) {
                Ok(f) if !plan::window_image_too_small((f.width, f.height), &frame_pt, scale) => f,
                _ => {
                    via = "screenFrame";
                    be.capture_physical_rect(&frame).unwrap_or_else(|e| die(e))
                }
            };
            let target = serde_json::json!({
                "windowId": w.id, "pid": w.pid, "title": w.title, "appName": w.app_name,
                "bundleIdentifier": w.app_id, "frame": frame,
                "visibleAreaRatio": plan::visible_area_ratio(w, &ms),
                "fullscreen": plan::is_fullscreen_window(w, &ms),
            });
            if let Some(out) = opt_out {
                let meta = save(&img, &out, flag("--jpeg"));
                print_json(serde_json::json!({ "success": true, "via": via, "target": target, "saved": meta }));
            } else {
                print_json(serde_json::json!({ "success": true, "via": via, "target": target,
                    "width": img.width, "height": img.height }));
            }
        }
        "monitor" => {
            let ms = be.monitors().unwrap_or_else(|e| die(e));
            let raw = positional_id();
            let id = if raw == 0 { ms.first().map(|m| m.id).unwrap_or(0) } else { raw };
            let img = be.capture_monitor(id).unwrap_or_else(|e| die(e));
            let meta = opt_out.map(|o| save(&img, &o, flag("--jpeg"))).unwrap_or(serde_json::Value::Null);
            print_json(serde_json::json!({ "success": true, "monitor": id, "width": img.width, "height": img.height, "saved": meta }));
        }
        "window" => {
            let id = positional_id();
            let img = be.capture_window(id).unwrap_or_else(|e| die(e));
            let meta = opt_out.map(|o| save(&img, &o, flag("--jpeg"))).unwrap_or(serde_json::Value::Null);
            print_json(serde_json::json!({ "success": true, "window": id, "width": img.width, "height": img.height, "saved": meta }));
        }
        other => die(format!("unknown command {other}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn body() {}

fn main() {
    if cfg!(target_os = "macos") { body(); } else { println!("{{\"success\":false,\"error\":\"macos-only\"}}"); }
}
