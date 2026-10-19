//! 平台无关的窗口过滤/吸附/全屏判定 —— 逆向原理的直接移植点，全部纯函数可单测。
//!
//! 案例来源：参考实现 AppShotCaptureController（Qianwen.app 静态分析）
//! （findTopmostVisibleAppTarget / makeTarget / shouldUseDisplayBoundsForFullScreen /
//!  visibleAreaRatio / copyOnscreenWindows 过滤链）

use std::collections::HashSet;

use crate::types::{MonitorInfo, PhysicalRect, WindowId, WindowInfo, WindowKind};

/// 极小窗口阈值（参考: isSystemShellWindow 的 w<2||h<2）
pub const MIN_WINDOW_PX: u32 = 2;
/// 全屏覆盖率阈值（参考: shouldUseDisplayBoundsForFullScreen ≥0.98）
pub const FULLSCREEN_RATIO: f64 = 0.98;
/// 窗口抓取 too-small 容差（点数，参考: 差值>2.0 判定；实际比较用 2.0*scale 物理像素）
pub const TOO_SMALL_TOLERANCE_PT: f64 = 2.0;

/// 吸附候选过滤（对应 resolve/fallback 链剔除）：
/// - 剔除 excludedWindowIds（含本产品自身窗口）
/// - 剔除 Desktop/Shell/OwnWindow（Tooltip 保留，可手动框到）
/// - 剔除 off-screen / cloaked / <2px / 自身 pid
pub fn snap_candidates<'a>(
    windows: &'a [WindowInfo],
    excluded: &HashSet<WindowId>,
    my_pid: u32,
) -> Vec<&'a WindowInfo> {
    windows
        .iter()
        .filter(|w| {
            !excluded.contains(&w.id)
                && w.pid != my_pid
                && w.kind != WindowKind::Desktop
                && w.kind != WindowKind::Shell
                && w.kind != WindowKind::OwnWindow
                && w.is_on_screen
                && !w.cloaked
                && w.bounds.width >= MIN_WINDOW_PX
                && w.bounds.height >= MIN_WINDOW_PX
        })
        .collect()
}

/// 窗口面积 / 显示器面积 覆盖率（跨所有显示器的交集和）
pub fn visible_area_ratio(w: &WindowInfo, monitors: &[MonitorInfo]) -> f64 {
    let area = w.bounds.area() as f64;
    if area <= 0.0 {
        return 0.0;
    }
    let inter: f64 = monitors
        .iter()
        .filter_map(|m| w.bounds.intersection(&m.bounds))
        .map(|r| r.area() as f64)
        .sum();
    (inter / area).clamp(0.0, 1.0)
}

/// 是否“全屏窗口”：对任一显示器覆盖率 ≥ FULLSCREEN_RATIO
pub fn is_fullscreen_window(w: &WindowInfo, monitors: &[MonitorInfo]) -> bool {
    monitors.iter().any(|m| {
        let m_area = m.bounds.area() as f64;
        if m_area <= 0.0 {
            return false;
        }
        w.bounds
            .intersection(&m.bounds)
            .map(|i| i.area() as f64 / m_area)
            .unwrap_or(0.0)
            >= FULLSCREEN_RATIO
    })
}

/// 包含窗口中心的显示器；无则取交集面积最大的；再无则 primary/首个
pub fn monitor_of<'a>(w: &PhysicalRect, monitors: &'a [MonitorInfo]) -> Option<&'a MonitorInfo> {
    let cx = w.mid_x();
    let cy = w.mid_y();
    if let Some(m) = monitors.iter().find(|m| m.bounds.contains(cx, cy)) {
        return Some(m);
    }
    monitors
        .iter()
        .filter_map(|m| w.intersection(&m.bounds).map(|i| (m, i.area())))
        .max_by_key(|(_, a)| *a)
        .map(|(m, _)| m)
        .or_else(|| monitors.iter().find(|m| m.is_primary).or(monitors.first()))
}

/// 吸附/干净窗口用的有效抓取矩形（对应 makeTarget 的 captureFrame 选择）：
/// - 全屏窗口 → 所在显示器 **visible_bounds** 交集（参考: useDisplay → visibleFrameOf）
/// - 否则 → bounds ∩ 所在显示器 bounds（参考: captureFrame/visibleFrame 对）
pub fn effective_capture_rect(w: &WindowInfo, monitors: &[MonitorInfo]) -> PhysicalRect {
    let Some(m) = monitor_of(&w.bounds, monitors) else {
        return w.bounds;
    };
    if is_fullscreen_window(w, monitors) {
        m.visible_bounds
            .intersection(&w.bounds)
            .unwrap_or(m.visible_bounds)
    } else {
        m.bounds.intersection(&w.bounds).unwrap_or(w.bounds)
    }
}

/// 鼠标点下最顶候选窗口（hover 吸附）——依赖 z_index 前→后有序契约
pub fn window_under_point<'a>(
    candidates: &[&'a WindowInfo],
    monitors: &[MonitorInfo],
    x: i64,
    y: i64,
) -> Option<&'a WindowInfo> {
    candidates.iter().copied().find(|w| {
        let r = effective_capture_rect(w, monitors);
        r.contains(x, y)
    })
}

/// 两级抓取的尺寸校验（参考: 图像像素 vs 期望 pt×scale 各维绝对差 > 2pt*scale 判 too-small）。
/// 返回 true = 需要回退屏幕帧。
pub fn window_image_too_small(
    img: (u32, u32),
    expect_frame: &PhysicalRect,
    scale: f64,
) -> bool {
    let ew = expect_frame.width as f64 * scale;
    let eh = expect_frame.height as f64 * scale;
    let diff = (img.0 as f64 - ew).abs() + (img.1 as f64 - eh).abs();
    diff > TOO_SMALL_TOLERANCE_PT * scale
}

/// 默认目标（无鼠标点时）：吸附候选里第一个 Normal 窗（对齐参考的前台 app 优先语义），
/// 全为浮层时退化取队首。z 序契约保证“最顶”。
pub fn best_snap_target<'a>(
    candidates: &[&'a WindowInfo],
    mouse: Option<(i64, i64)>,
    monitors: &[MonitorInfo],
) -> Option<&'a WindowInfo> {
    if let Some((x, y)) = mouse {
        return window_under_point(candidates, monitors, x, y);
    }
    candidates
        .iter()
        .copied()
        .find(|w| w.kind == WindowKind::Normal)
        .or_else(|| candidates.first().copied())
}
