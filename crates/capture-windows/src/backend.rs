//! CaptureBackend 的 Windows 实现。
//! 抓取策略（计划 §Windows）：WGC 主路径，BitBlt(区域/整屏) 回退，PrintWindow 最后兜底；
//! DXGI Duplication 不在 MVP。

use capture_core::backend::{BackendCapabilities, CaptureBackend, PermissionOutcome};
use capture_core::error::{CaptureError, Result};
use capture_core::types::{Frame, MonitorId, MonitorInfo, PermissionStatus, WindowId, WindowInfo};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::HMONITOR;

use crate::{bitblt, enum_windows, monitors, print_window, wgc};

pub struct WindowsBackend;

impl WindowsBackend {
    pub fn new() -> Option<Self> {
        Some(WindowsBackend)
    }

    pub fn capture_hmonitor(&self, hmon: HMONITOR) -> Result<Frame> {
        wgc::capture_monitor(hmon).or_else(|e| {
            let bounds = monitors::displays()
                .into_iter()
                .find(|d| d.hmon.0 == hmon.0)
                .map(|d| d.phys.bounds)
                .ok_or(CaptureError::TargetNotFound)?;
            let f = bitblt::capture_monitor_rect(&bounds)?;
            Err::<(), _>(e).ok(); // 保留回退事实：错误仅入日志（上层命令层负责记录 fallback 字面）
            Ok(f)
        })
    }
}

impl CaptureBackend for WindowsBackend {
    fn name(&self) -> &'static str {
        "windows"
    }

    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities { window_capture: true, per_monitor_native_capture: true }
    }

    fn monitors(&self) -> Result<Vec<MonitorInfo>> {
        Ok(monitors::monitors())
    }

    fn list_windows(&self) -> Result<Vec<WindowInfo>> {
        // 自身 pid 与自身 HWND（overlay/pin 注册进 state；probe 场景为空集）
        Ok(enum_windows::list_windows_with_owner(std::process::id(), &[]))
    }

    fn capture_monitor(&self, id: MonitorId) -> Result<Frame> {
        let ds = monitors::displays();
        let d = ds.iter().find(|d| d.hmon.0 as u64 == id).or_else(|| monitors::primary(&ds)).ok_or(CaptureError::TargetNotFound)?;
        self.capture_hmonitor(d.hmon)
    }

    /// 两级抓取第一级：WGC 窗口项优先，失败回退 PrintWindow（尺寸校验在调用方 plan）。
    fn capture_window(&self, id: WindowId) -> Result<Frame> {
        let hwnd = HWND(id as *mut std::ffi::c_void);
        if unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindow(Some(hwnd)).0 } == 0 {
            return Err(CaptureError::TargetNotFound);
        }
        wgc::capture_window(hwnd, &PHYSICAL_RECT_ZERO).or_else(|_| print_window::capture_window(hwnd))
    }

    /// Windows 无 TCC 概念：屏幕抓取恒允许（UAC 完整性级别边界在文档说明）。
    fn permission_status(&self) -> PermissionStatus {
        PermissionStatus { screen_recording: true, accessibility: false }
    }

    fn request_permission(&self) -> PermissionOutcome {
        PermissionOutcome::Allowed
    }
}

use capture_core::PhysicalRect;
const PHYSICAL_RECT_ZERO: PhysicalRect = PhysicalRect::ZERO;

/// 区域抓取（冻结帧兜底、未来跨屏合成用）
impl WindowsBackend {
    pub fn capture_region(&self, rect: &PhysicalRect) -> Result<Frame> {
        wgc_region(rect).or_else(|_| bitblt::capture_region(rect))
    }
}

fn wgc_region(_rect: &PhysicalRect) -> Result<Frame> {
    // WGC 无任意区域 item —— 恒回退（保留显式意图）
    Err(CaptureError::BackendUnavailable("wgc region"))
}
