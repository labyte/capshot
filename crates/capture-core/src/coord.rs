//! 虚拟屏物理坐标 ↔ 单显示器帧内坐标。跨屏选择 = union 后按显示器拆矩形。
//! 全部 i64 中间量防溢出；负坐标（Windows 左/上副屏、macOS 副屏为常态）原生支持。

use crate::types::{MonitorInfo, PhysicalRect};

/// 虚拟屏 rect 换算到 monitor 帧内坐标（左上原点 0,0）；rect 与该显示器无交集 → None
pub fn virtual_to_monitor(v: &PhysicalRect, m: &MonitorInfo) -> Option<PhysicalRect> {
    let inter = v.intersection(&m.bounds)?;
    Some(PhysicalRect::new(
        (inter.min_x() - m.bounds.min_x()) as i32,
        (inter.min_y() - m.bounds.min_y()) as i32,
        inter.width,
        inter.height,
    ))
}

/// monitor 帧内 rect 换算回虚拟屏坐标
pub fn monitor_to_virtual(r: &PhysicalRect, m: &MonitorInfo) -> PhysicalRect {
    PhysicalRect::new(
        (m.bounds.min_x() + r.min_x()) as i32,
        (m.bounds.min_y() + r.min_y()) as i32,
        r.width,
        r.height,
    )
}

/// 若干矩形的并集包络（跨屏选择聚合用）；空输入 → None
pub fn union(rects: &[PhysicalRect]) -> Option<PhysicalRect> {
    let mut it = rects.iter();
    let first = it.next()?;
    let (mut x0, mut y0, mut x1, mut y1) =
        (first.min_x(), first.min_y(), first.max_x(), first.max_y());
    for r in it {
        x0 = x0.min(r.min_x());
        y0 = y0.min(r.min_y());
        x1 = x1.max(r.max_x());
        y1 = y1.max(r.max_y());
    }
    Some(PhysicalRect::new(
        x0.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        y0.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        (x1 - x0).max(0).min(u32::MAX as i64) as u32,
        (y1 - y0).max(0).min(u32::MAX as i64) as u32,
    ))
}

/// 把 rect 按各显示器 bounds 拆开（跨屏框选 → 每屏一段，overlay 分发用）
pub fn split_by_monitor(v: &PhysicalRect, monitors: &[MonitorInfo]) -> Vec<(crate::types::MonitorId, PhysicalRect)> {
    let mut out = Vec::new();
    for m in monitors {
        if let Some(local) = virtual_to_monitor(v, m) {
            out.push((m.id, local));
        }
    }
    out
}
