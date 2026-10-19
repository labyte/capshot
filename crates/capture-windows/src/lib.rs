//! capture-windows —— Windows 截图后端（M3）。
//! 真实抓取代码全部 cfg(windows)：本 crate 可被 mac/Linux 的 workspace 编译（空实现）。

#[cfg(windows)]
pub mod backend;
#[cfg(windows)]
pub mod bitblt;
#[cfg(windows)]
pub mod enum_windows;
#[cfg(windows)]
pub mod monitors;
#[cfg(windows)]
pub mod print_window;
#[cfg(windows)]
pub mod wgc;

#[cfg(windows)]
pub use backend::WindowsBackend;

#[cfg(windows)]
pub fn make_backend() -> Option<WindowsBackend> {
    WindowsBackend::new()
}

#[cfg(not(windows))]
pub fn make_backend() -> Option<()> {
    None
}
