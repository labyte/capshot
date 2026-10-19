//! 显示器枚举与 point↔physical 换算。
//! CG 全局域为 point（主屏左上原点）；本 crate 对外的 WindowInfo/MonitorInfo 统一为
//! **物理像素虚拟屏坐标**（capture-core 契约）。
//! 已知限制：单缩放/均匀缩放假设（primary scale 换算窗口原点）；混合 DPI 多屏列入手动验收。

use capture_core::types::{MonitorInfo, PhysicalRect};
use core_graphics::display::{CGDisplay, CGMainDisplayID};

/// CG point 域显示器信息（供后端换算），phys = 已换算的 MonitorInfo
#[derive(Clone)]
pub struct DisplayPt {
    pub id: u64,
    pub pt_x: f64,
    pub pt_y: f64,
    pub pt_w: f64,
    pub pt_h: f64,
    pub scale: f64,
    pub phys: MonitorInfo,
}

pub fn displays() -> Vec<DisplayPt> {
    // CGGetActiveDisplayList 在 CLI 进程中可能瞬时空 —— 主屏兜底，永不为空
    let ids = match CGDisplay::active_displays() {
        Ok(v) if !v.is_empty() => v,
        _ => vec![unsafe { CGMainDisplayID() }],
    };
    let main_id = unsafe { CGMainDisplayID() };
    ids.iter()
        .map(|id| {
            let d = CGDisplay::new(*id);
            let b = d.bounds();
            // CGDisplayPixelsWide 在 HiDPI 下返回 point 宽 —— 用 display mode 的像素尺寸
            let (pw, ph) = match d.display_mode() {
                Some(m) => (m.pixel_width().max(1) as f64, m.pixel_height().max(1) as f64),
                None => (d.pixels_wide().max(1) as f64, d.pixels_high().max(1) as f64),
            };
            let scale = if b.size.width > 0.0 { pw / b.size.width } else { 1.0 };
            let bounds = PhysicalRect::new(
                (b.origin.x * scale).round() as i32,
                (b.origin.y * scale).round() as i32,
                pw as u32,
                ph as u32,
            );
            let name = if d.is_main() { "main".to_string() } else { format!("display-{id}") };
            DisplayPt {
                id: *id as u64,
                pt_x: b.origin.x,
                pt_y: b.origin.y,
                pt_w: b.size.width,
                pt_h: b.size.height,
                scale,
                phys: MonitorInfo {
                    id: *id as u64,
                    name,
                    scale_factor: scale,
                    bounds,
                    visible_bounds: bounds, // TODO(host): NSScreen.visibleFrame 细化（菜单栏/Dock inset）
                    is_primary: *id == main_id,
                },
            }
        })
        .collect()
}

pub fn monitors() -> Vec<MonitorInfo> {
    displays().into_iter().map(|d| d.phys).collect()
}

/// 含窗口中心的显示器（point 域判定）
pub fn display_for_pt_rect(ds: &[DisplayPt], x: f64, y: f64) -> Option<&DisplayPt> {
    ds.iter().find(|d| x >= d.pt_x && x < d.pt_x + d.pt_w && y >= d.pt_y && y < d.pt_y + d.pt_h)
        .or_else(|| ds.iter().find(|d| d.phys.is_primary))
        .or_else(|| ds.first())
}

/// 显示器内 point rect → 物理虚拟屏 rect
pub fn point_to_physical(d: &DisplayPt, x: i32, y: i32, w: u32, h: u32) -> PhysicalRect {
    PhysicalRect::new(
        (d.phys.bounds.min_x() + ((x as f64 - d.pt_x) * d.scale).round() as i64) as i32,
        (d.phys.bounds.min_y() + ((y as f64 - d.pt_y) * d.scale).round() as i64) as i32,
        ((w as f64) * d.scale).round().max(0.0) as u32,
        ((h as f64) * d.scale).round().max(0.0) as u32,
    )
}

/// 物理虚拟屏 rect → point rect（按物理中心所在显示器换算）；无显示器时均匀兜底
pub fn physical_to_point(ds: &[DisplayPt], r: &PhysicalRect) -> (f64, f64, f64, f64) {
    let s = primary_scale(ds);
    let Some(d) = ds.iter().find(|d| d.phys.bounds.contains(r.mid_x(), r.mid_y())).or_else(|| ds.iter().find(|d| d.phys.is_primary)).or(ds.first()) else {
        return (r.min_x() as f64 / s, r.min_y() as f64 / s, r.width.max(1) as f64 / s, r.height.max(1) as f64 / s);
    };
    (
        d.pt_x + (r.min_x() - d.phys.bounds.min_x()) as f64 / d.scale,
        d.pt_y + (r.min_y() - d.phys.bounds.min_y()) as f64 / d.scale,
        r.width.max(1) as f64 / d.scale,
        r.height.max(1) as f64 / d.scale,
    )
}

pub fn primary_scale(ds: &[DisplayPt]) -> f64 {
    ds.iter().find(|d| d.phys.is_primary).map(|d| d.scale).or_else(|| ds.first().map(|d| d.scale)).unwrap_or(1.0)
}
