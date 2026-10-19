//! 平台后端契约。apps/desktop 与 probe CLI 通过它分发到 capture-windows / capture-macos；
//! 未来加 capture-linux 只增实现，不动上层。

use crate::error::Result;
use crate::types::{Frame, MonitorId, PermissionStatus, MonitorInfo, WindowId, WindowInfo};

#[derive(Debug, Clone, Copy)]
pub struct BackendCapabilities {
    /// 原生单窗口抓取（WGC CreateForWindow / CGWindowListCreateImage IncludingWindow）
    pub window_capture: bool,
    /// 每显示器原生抓取（否则只能整虚拟屏抓 + crop）
    pub per_monitor_native_capture: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionOutcome {
    Allowed,
    /// 触发系统弹窗/列表加项（macOS CGRequestScreenCaptureAccess）
    Prompted,
    Denied,
}

pub trait CaptureBackend: Send + Sync + 'static {
    fn name(&self) -> &'static str; // "windows" | "macos" | "linux"
    fn capabilities(&self) -> BackendCapabilities;

    fn monitors(&self) -> Result<Vec<MonitorInfo>>;
    /// 前→后有序（z_index 契约）
    fn list_windows(&self) -> Result<Vec<WindowInfo>>;

    /// 冻结帧主路径：单显示器原生分辨率
    fn capture_monitor(&self, id: MonitorId) -> Result<Frame>;
    /// 干净窗口图（两级抓取第一级；too-small 由调用方用 plan::window_image_too_small 判定）
    fn capture_window(&self, id: WindowId) -> Result<Frame>;

    /// 对应参考的 permissionStatus：先 preflight 再决定是否调用 capture_*
    fn permission_status(&self) -> PermissionStatus;
    /// Windows 恒 Allowed；macOS 首弹可能 Prompted
    fn request_permission(&self) -> PermissionOutcome;
}
