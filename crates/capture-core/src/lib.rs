//! capshot 截图核心（平台无关层）。
//!
//! 原理移植自千问 macOS "截屏提问" 的 Swift 实现 AppShotCaptureController
//! （依据：对 Qianwen.app v5.0.0.268 截屏层的静态分析记录）：
//! - z 序窗口枚举契约（types::WindowInfo.z_index）
//! - 系统壳/桌面层/极小窗/cloaked 过滤与吸附（plan::snap_candidates 等）
//! - 全屏窗口覆盖率 ≥0.98 → 改用显示器可见 bounds（plan::effective_capture_rect）
//! - 窗口优先 + 屏幕帧兜底的两级抓取判定（plan::window_image_too_small）
//! - 0.86 JPEG / 白底不透明化缩略图（encode）
//! - permission preflight 错误语义（error::CaptureError::PermissionDenied）
//! - requestId 幂等 —— 属应用层职责（apps/desktop state.rs），核心只定义错误与类型

pub mod backend;
pub mod coord;
pub mod encode;
pub mod error;
pub mod filename;
pub mod plan;
pub mod types;

pub use backend::{BackendCapabilities, CaptureBackend, PermissionOutcome};
pub use error::{ApiError, CaptureError, Result};
pub use types::{
    Frame, MonitorId, PermissionKind, PermissionStatus, PhysicalRect, WindowId, WindowInfo,
    WindowKind, MonitorInfo,
};
