//! 单测 fixture 直接复刻参考引擎案例（AppShotCapture.swift 判定链 + README 证据）。

use capture_core::*;
use std::collections::HashSet;

fn monitor(id: u64, w: u32, h: u32, menu: u32, task: u32, primary: bool) -> MonitorInfo {
    MonitorInfo {
        id,
        name: format!("m{id}"),
        bounds: PhysicalRect::new(0, 0, w, h),
        scale_factor: 2.0,
        visible_bounds: PhysicalRect::new(0, menu as i32, w, h - menu - task),
        is_primary: primary,
    }
}

fn win(id: u64, pid: u32, bounds: PhysicalRect, z: usize, kind: WindowKind) -> WindowInfo {
    WindowInfo {
        id,
        pid,
        title: Some(format!("w{id}")),
        app_name: Some("app".into()),
        app_id: Some("com.example.app".into()),
        bounds,
        z_index: z,
        layer: 0,
        is_on_screen: true,
        cloaked: false,
        kind,
    }
}

#[test]
fn snap_candidates_filters_reference_cases() {
    let _m = vec![monitor(0, 3024, 1964, 76, 0, true)];
    let mut ws = vec![
        win(1, 100, PhysicalRect::new(0, 0, 1200, 800), 0, WindowKind::Normal),
        win(2, 101, PhysicalRect::new(50, 50, 600, 400), 1, WindowKind::Normal),
        win(3, 102, PhysicalRect::new(0, 0, 3024, 1964), 2, WindowKind::Desktop), // 壁纸层
        win(4, 103, PhysicalRect::new(10, 10, 300, 300), 3, WindowKind::Shell),   // Spotlight
        win(5, 104, PhysicalRect::new(20, 20, 1, 300), 4, WindowKind::Normal),    // 极小窗
        win(6, 105, PhysicalRect::new(30, 30, 300, 300), 5, WindowKind::Tooltip), // 提示保留
        win(7, 106, PhysicalRect::new(40, 40, 300, 300), 6, WindowKind::Normal),  // 将进 excluded
        win(8, 107, PhysicalRect::new(50, 50, 300, 300), 7, WindowKind::OwnWindow),
    ];
    ws[4].is_on_screen = false; // 第二个极小窗外再叠加 off-screen 情形
    let mut excluded = HashSet::new();
    excluded.insert(7u64); // excludedWindowIds 原理
    let mut offscreen = win(9, 108, PhysicalRect::new(60, 60, 300, 300), 8, WindowKind::Normal);
    offscreen.is_on_screen = false;
    ws.push(offscreen);
    let mut cloaked = win(10, 109, PhysicalRect::new(70, 70, 300, 300), 9, WindowKind::Normal);
    cloaked.cloaked = true; // Windows 虚拟桌面挂起
    ws.push(cloaked);

    let cands = plan::snap_candidates(&ws, &excluded, 100); // my_pid=100 剔除自身 pid 窗口 1
    let ids: Vec<u64> = cands.iter().map(|w| w.id).collect();
    assert_eq!(ids, vec![2, 6]); // 只剩普通窗 + Tooltip，且顺序保持 z 前→后
}

#[test]
fn window_under_point_respects_z_order_and_effective_rect() {
    let m = vec![monitor(0, 1920, 1080, 38, 48, true)];
    let back = win(1, 10, PhysicalRect::new(0, 0, 800, 600), 1, WindowKind::Normal);
    let front = win(2, 11, PhysicalRect::new(200, 150, 400, 300), 0, WindowKind::Normal);
    let ws = vec![front.clone(), back.clone()];
    let cands = plan::snap_candidates(&ws, &HashSet::new(), 999);
    // 点在重叠区 → 取 z_index 更靠前者
    let hit = plan::window_under_point(&cands, &m, 300, 200).unwrap();
    assert_eq!(hit.id, 2);
    // 点只在后窗 → 后窗
    let hit = plan::window_under_point(&cands, &m, 50, 50).unwrap();
    assert_eq!(hit.id, 1);
    assert!(plan::window_under_point(&cands, &m, 1500, 1000).is_none());
}

#[test]
fn fullscreen_window_switches_to_visible_bounds() {
    // 参考: shouldUseDisplayBoundsForFullScreen(≥0.98) → captureFrame = 显示器可见 bounds
    let m = vec![monitor(0, 1920, 1080, 38, 48, true)];
    let fs = win(1, 10, PhysicalRect::new(0, 0, 1920, 1080), 0, WindowKind::Normal);
    assert!(plan::is_fullscreen_window(&fs, &m));
    let r = plan::effective_capture_rect(&fs, &m);
    assert_eq!(r, PhysicalRect::new(0, 38, 1920, 994)); // visible_bounds ∩ bounds
    let normal = win(2, 11, PhysicalRect::new(100, 100, 400, 300), 0, WindowKind::Normal);
    assert!(!plan::is_fullscreen_window(&normal, &m));
    assert_eq!(plan::effective_capture_rect(&normal, &m), normal.bounds);
}

#[test]
fn visible_area_ratio_matches_reference() {
    let m = vec![monitor(0, 1000, 1000, 0, 0, true)];
    // 半屏出界: 面积比 = 交集/自身 = 0.5
    let w = win(1, 10, PhysicalRect::new(500, 0, 1000, 1000), 0, WindowKind::Normal);
    assert!((plan::visible_area_ratio(&w, &m) - 0.5).abs() < 1e-9);
    // 完全出界（负坐标副屏场景在单测里用第二显示器覆盖，见 coord 测试）
    let off = win(2, 11, PhysicalRect::new(2000, 0, 100, 100), 0, WindowKind::Normal);
    assert_eq!(plan::visible_area_ratio(&off, &m), 0.0);
}

#[test]
fn negative_coord_second_monitor_cases() {
    // Windows 左副屏：bounds 为负 x；中心不在 bounds 内的窗口应归属最大交集显示器
    let primary = monitor(0, 1920, 1080, 0, 48, true);
    let mut left = monitor(1, 1280, 1024, 0, 0, false);
    left.bounds = PhysicalRect::new(-1280, 0, 1280, 1024);
    left.visible_bounds = left.bounds;
    let ms = vec![primary.clone(), left];
    let w = win(9, 10, PhysicalRect::new(-600, 100, 400, 300), 0, WindowKind::Normal);
    let m = plan::monitor_of(&w.bounds, &ms).unwrap();
    assert_eq!(m.id, 1);
    let r = plan::effective_capture_rect(&w, &ms);
    assert_eq!(r, w.bounds);
    // 虚拟→左屏局部坐标
    let local = coord::virtual_to_monitor(&w.bounds, &ms[1]).unwrap();
    assert_eq!(local, PhysicalRect::new(680, 100, 400, 300));
    assert_eq!(coord::monitor_to_virtual(&local, &ms[1]), w.bounds);
    // union 包络（两显示器 bounds 的并）
    let u = coord::union(&ms.iter().map(|m| m.bounds).collect::<Vec<_>>()).unwrap();
    assert_eq!(u, PhysicalRect::new(-1280, 0, 3200, 1080));
    let parts = coord::split_by_monitor(&u, &ms);
    assert_eq!(parts.len(), 2);
    // 窗口与 union 的包络
    let wu = coord::union(&[w.bounds, primary.bounds]).unwrap();
    assert_eq!(wu, PhysicalRect::new(-600, 0, 2520, 1080));
}

#[test]
fn best_snap_target_prefers_normal_over_tooltip() {
    let m = vec![monitor(0, 1000, 1000, 0, 0, true)];
    let tip = win(1, 10, PhysicalRect::new(0, 0, 100, 40), 0, WindowKind::Tooltip); // 菜单栏浮层在最顶
    let normal = win(2, 11, PhysicalRect::new(10, 10, 400, 300), 1, WindowKind::Normal);
    let ws = vec![tip.clone(), normal.clone()];
    let cands = plan::snap_candidates(&ws, &HashSet::new(), 999);
    assert_eq!(plan::best_snap_target(&cands, None, &m).unwrap().id, 2);
    // 指定点在 tip 内 → 命中 tip（hover 语义仍按 z 序）
    assert_eq!(plan::best_snap_target(&cands, Some((5, 5)), &m).unwrap().id, 1);
}

#[test]
fn intersection_degenerate_is_none() {
    let a = PhysicalRect::new(0, 0, 100, 100);
    assert!(a.intersection(&PhysicalRect::new(100, 0, 50, 50)).is_none()); // 边贴边=无面积
    assert!(a.intersection(&PhysicalRect::new(50, 50, 1, 1)).is_some()); // 1px 相交
}

#[test]
fn frame_crop_and_pixel() {
    let (w, h) = (4u32, 3u32);
    let mut px = vec![0u8; (w as usize * h as usize * 4)];
    // (2,1) 处红色
    let i = (1 * w as usize + 2) * 4;
    px[i] = 255; px[i + 3] = 255;
    let f = Frame::new(w, h, w as usize * 4, px).unwrap();
    assert_eq!(f.pixel(2, 1), [255, 0, 0, 255]);
    let c = f.crop(&PhysicalRect::new(1, 0, 3, 3)).unwrap();
    assert_eq!((c.width, c.height), (3, 3));
    assert_eq!(c.pixel(1, 1), [255, 0, 0, 255]); // 局部 (2,1)->(1,1)
    assert!(matches!(f.crop(&PhysicalRect::new(4, 0, 10, 10)), Err(CaptureError::DegenerateGeometry(_))));
    // 越界 pixel 不 panic
    assert_eq!(f.pixel(99, 99), [0; 4]);
}

#[test]
fn encode_roundtrip() {
    let f = Frame::new(8, 8, 32, vec![42u8; 8 * 8 * 4]).unwrap();
    let png = encode::to_png(&f).unwrap();
    let img = image::load_from_memory(&png).unwrap();
    assert_eq!(img.width(), 8);
    let jpg = encode::to_jpeg(&f, encode::DEFAULT_JPEG_QUALITY).unwrap();
    let img2 = image::load_from_memory(&jpg).unwrap();
    assert_eq!(img2.height(), 8);
    let thumb = encode::to_thumbnail(&f).unwrap();
    image::load_from_memory(&thumb).unwrap();
}

#[test]
fn too_small_threshold_reference() {
    // 期望 600x400pt @2x = 1200x800px；差 > 2pt*2=4px 判 too-small
    let expect = PhysicalRect::new(0, 0, 600, 400);
    assert!(!plan::window_image_too_small((1200, 800), &expect, 2.0)); // 完全一致
    assert!(!plan::window_image_too_small((1202, 798), &expect, 2.0)); // |2|+|2| = 4，不 ">4" 不判小
    assert!(plan::window_image_too_small((1204, 796), &expect, 2.0)); // 8 > 4 → too small
    // 非 Retina（scale=1）阈值即参考原样的 2.0
    let e1 = PhysicalRect::new(0, 0, 1200, 800);
    assert!(plan::window_image_too_small((1197, 800), &e1, 1.0)); // |3|+|0| > 2
    assert!(!plan::window_image_too_small((1198, 800), &e1, 1.0)); // |2|+|0| = 2
}

#[test]
fn filename_render_and_sanitize() {
    let s = filename::Stamp {
        yyyy: 2026, mm: 10, dd: 19, hh: 9, min: 5, sec: 3, seq: 12,
        app: Some("My:App/<>"), title: Some("doc.. "),
    };
    let name = filename::render(filename::DEFAULT_TEMPLATE, &s);
    assert_eq!(name, "2026-10-19_09.05.03.0012.My_App___");
    assert_eq!(filename::sanitize("a b  "), "a b");
    assert_eq!(filename::sanitize("***"), "___");
    assert_eq!(filename::sanitize(""), "capture");
    let (y, d) = filename::date_dirs(&s);
    assert_eq!((y.as_str(), d.as_str()), ("2026", "20261019"));
}

/// 锁住权限 DTO 的**线上形状**。这里出过真事故：serde 默认 snake_case（`screen_recording`），
/// 而 `ui/src/shared/types.ts` 读 `screenRecording` → 取到 undefined → falsy，
/// 设置页永远显示「未授权」；TS 字段类型是非空 `boolean`，tsc 完全拦不住。
/// 另一个必须锁的是 `None → null`：前端靠它把「本平台不适用」和「未授权」分开。
#[test]
fn permission_status_wire_shape_is_camel_case_with_null() {
    let na = serde_json::to_value(PermissionStatus::NOT_APPLICABLE).unwrap();
    assert_eq!(na, serde_json::json!({ "screenRecording": null, "accessibility": null }));

    let mac = serde_json::to_value(PermissionStatus {
        screen_recording: Some(false),
        accessibility: Some(true),
    })
    .unwrap();
    assert_eq!(mac, serde_json::json!({ "screenRecording": false, "accessibility": true }));

    // 回读走同一套字段名（probe CLI 与前端 mock 都依赖它）
    let back: PermissionStatus = serde_json::from_value(mac).unwrap();
    assert_eq!(back, PermissionStatus { screen_recording: Some(false), accessibility: Some(true) });
}
