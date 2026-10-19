//! CaptureBackend 的 macOS 实现（薄编排：preflight → 原生 API → 物理像素 Frame）。
//! 对外契约（capture-core）：坐标 = 物理像素虚拟屏；CG point 域换算集中在本模块。

use capture_core::backend::{BackendCapabilities, CaptureBackend, PermissionOutcome};
use capture_core::error::{CaptureError, Result};
use capture_core::types::{
    Frame, MonitorId, MonitorInfo, PermissionKind, PermissionStatus, WindowId, WindowInfo,
};

use crate::{cg, displays, frame};

pub struct MacOsBackend;

impl MacOsBackend {
    pub fn new() -> Option<Self> {
        Some(MacOsBackend)
    }

    fn preflight(&self) -> Result<()> {
        if cg::screen_capture_allowed() {
            Ok(())
        } else {
            Err(CaptureError::PermissionDenied(PermissionKind::ScreenRecording))
        }
    }

    /// 两级抓取的第二级按参考语义直接抓目标区域（物理 rect 入，内部换回 point 域）。
    pub fn capture_physical_rect(&self, rect: &capture_core::PhysicalRect) -> Result<Frame> {
        self.preflight()?;
        let ds = displays::displays();
        let (x, y, w, h) = displays::physical_to_point(&ds, rect);
        if !(w.is_finite() && h.is_finite()) || w < 1.0 || h < 1.0 {
            return Err(CaptureError::DegenerateGeometry("capture screen frame invisible frame"));
        }
        let img = cg::capture_screen_frame(x as i32, y as i32, w as u32, h as u32).ok_or(
            CaptureError::DegenerateGeometry("capture screen frame failed frame"),
        )?;
        frame::cgimage_to_frame(&img).ok_or(CaptureError::DegenerateGeometry("frame convert"))
    }
}

impl CaptureBackend for MacOsBackend {
    fn name(&self) -> &'static str {
        "macos"
    }

    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities { window_capture: true, per_monitor_native_capture: true }
    }

    fn monitors(&self) -> Result<Vec<MonitorInfo>> {
        Ok(displays::monitors())
    }

    /// 前→后有序；bounds 换算 point→physical（契约 §z_index + §坐标）。
    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        let ds = displays::displays();
        let mut ws = cg::list_windows();
        for w in &mut ws {
            let b = w.bounds;
            // CG point 域中心定显示器，再整体换算（point 值原样存于 PhysicalRect 前先转换）
            let d = displays::display_for_pt_rect(&ds, b.min_x() as f64, b.min_y() as f64);
            if let Some(d) = d {
                w.bounds = displays::point_to_physical(d, b.x, b.y, b.width, b.height);
            }
        }
        Ok(ws)
    }

    /// 冻结帧主路径：该显示器整幅（point bounds 抓取 → 物理 Frame 天然等尺寸）。
    fn capture_monitor(&self, id: MonitorId) -> Result<Frame> {
        self.preflight()?;
        let d = core_graphics::display::CGDisplay::new(id as core_graphics::display::CGDirectDisplayID);
        let b = d.bounds();
        let img = cg::capture_screen_frame(
            b.origin.x as i32,
            b.origin.y as i32,
            b.size.width.max(0.0) as u32,
            b.size.height.max(0.0) as u32,
        )
        .ok_or(CaptureError::DegenerateGeometry("capture screen frame failed display"))?;
        frame::cgimage_to_frame(&img).ok_or(CaptureError::DegenerateGeometry("frame convert"))
    }

    /// 两级抓取第一级原图（too-small 判定留给调用方 plan::window_image_too_small）。
    fn capture_window(&self, id: WindowId) -> Result<Frame> {
        self.preflight()?;
        let img = cg::capture_window_image(id).ok_or(CaptureError::TargetNotFound)?;
        frame::cgimage_to_frame(&img).ok_or(CaptureError::DegenerateGeometry("window frame convert"))
    }

    fn permission_status(&self) -> PermissionStatus {
        PermissionStatus {
            screen_recording: cg::screen_capture_allowed(),
            // 仅展示：global-shortcut 走 Carbon，不依赖 AX（与参考行为差异已在 README 记录）
            accessibility: unsafe { AXIsProcessTrusted() },
        }
    }

    fn request_permission(&self) -> PermissionOutcome {
        if cg::screen_capture_allowed() {
            return PermissionOutcome::Allowed;
        }
        if cg::request_screen_capture() {
            PermissionOutcome::Allowed
        } else {
            PermissionOutcome::Prompted // TCC 弹窗/列表加项已发生但尚未授权
        }
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}
