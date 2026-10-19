use crate::types::{PermissionKind, WindowId};
use serde::Serialize;

/// 错误枚举刻意保留逆向日志链的语义变体（too-small / invisible / fallback），
/// 上层按 code 序列化为 {code, message} JSON（对齐参考引擎 errorCode 协议形）。
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    /// 权限未授予 —— UI 依据此弹引导（参考: errorCode=permission_denied）
    #[error("permission denied: {0:?}")]
    PermissionDenied(PermissionKind),

    /// 窗口已关闭/最小化/枚举后消失
    #[error("target not found")]
    TargetNotFound,

    /// rect 空/越界（参考: "capture screen frame invisible frame="）
    #[error("degenerate geometry: {0}")]
    DegenerateGeometry(&'static str),

    /// 窗口抓取尺寸与期望差 > 2pt*scale，应回退屏幕帧
    /// （参考: "capture window image too small window_id=…, fallback to frame"）
    #[error("window image too small: got {got:?} expect {expect:?} window={window}")]
    WindowImageTooSmall { window: WindowId, got: (u32, u32), expect: (u32, u32) },

    /// dlsym 失败 / WGC 初始化失败 / OS 版本不足
    #[error("backend unavailable: {0}")]
    BackendUnavailable(&'static str),

    /// 平台 API 原始失败
    #[error("platform api {api} failed: {os_status}")]
    Platform { api: &'static str, os_status: String },
}

impl CaptureError {
    /// 稳定 code 字符串（前端/日志匹配用，命名对齐参考引擎 errorCode）
    pub fn code(&self) -> &'static str {
        match self {
            CaptureError::PermissionDenied(_) => "permission_denied",
            CaptureError::TargetNotFound => "target_not_found",
            CaptureError::DegenerateGeometry(_) => "degenerate_geometry",
            CaptureError::WindowImageTooSmall { .. } => "window_image_too_small",
            CaptureError::BackendUnavailable(_) => "backend_unavailable",
            CaptureError::Platform { .. } => "platform_error",
        }
    }
}

/// Tauri/CLI 共用的可序列化错误形
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
}

impl From<CaptureError> for ApiError {
    fn from(e: CaptureError) -> Self {
        ApiError { code: e.code(), message: e.to_string() }
    }
}

pub type Result<T> = std::result::Result<T, CaptureError>;
