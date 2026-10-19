//! capture-macos —— macOS 截图后端。
//! 原理锚点：Qianwen.app v5.0.0.268 的 AppShotCaptureController（静态分析 + 原型实测验证）。
//! CGWindowListCreateImage 在 15+ SDK 被标 obsoleted，但 Rust 侧走 crate 手写的 extern 声明，
//! 与千问本体的动态符号链接等价；trait 可插拔，未来移除时以 ScreenCaptureKit 替换本 crate。

#[cfg(target_os = "macos")]
pub mod backend;
#[cfg(target_os = "macos")]
pub mod cg;
#[cfg(target_os = "macos")]
pub mod displays;
#[cfg(target_os = "macos")]
pub mod frame;

#[cfg(target_os = "macos")]
pub use backend::MacOsBackend;

/// 统一分发入口（apps/desktop 使用）
#[cfg(target_os = "macos")]
pub fn make_backend() -> Option<MacOsBackend> {
    MacOsBackend::new()
}

#[cfg(not(target_os = "macos"))]
pub fn make_backend() -> Option<()> {
    None
}
