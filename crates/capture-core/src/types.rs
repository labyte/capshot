//! 平台无关类型契约。坐标单一真源：**虚拟屏幕物理像素**（左上原点、y 向下，负坐标合法，
//! 对应 Windows 左/上副屏与 macOS 副屏排布）。前端换算 `logical = physical / scale_factor`。

use serde::{Deserialize, Serialize};

/// 物理像素矩形。z 序契约：`WindowInfo.z_index` 0 = 最前（前→后有序），
/// 对应逆向原理“CGWindowListCopyWindowInfo 前→后 / EnumWindows 顶→底”。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl PhysicalRect {
    pub const ZERO: Self = Self { x: 0, y: 0, width: 0, height: 0 };

    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Self { x, y, width, height }
    }

    pub fn min_x(&self) -> i64 { self.x as i64 }
    pub fn min_y(&self) -> i64 { self.y as i64 }
    pub fn max_x(&self) -> i64 { self.x as i64 + self.width as i64 }
    pub fn max_y(&self) -> i64 { self.y as i64 + self.height as i64 }
    pub fn mid_x(&self) -> i64 { self.min_x() + self.width as i64 / 2 }
    pub fn mid_y(&self) -> i64 { self.min_y() + self.height as i64 / 2 }

    pub fn area(&self) -> u64 { self.width as u64 * self.height as u64 }

    pub fn is_degenerate(&self) -> bool { self.width < 1 || self.height < 1 }

    pub fn contains(&self, x: i64, y: i64) -> bool {
        x >= self.min_x() && x < self.max_x() && y >= self.min_y() && y < self.max_y()
    }

    /// 交集；不相交/退化返回 None（规避 CGRectNull 语义陷阱，参考 Swift 版 Geo.overlap）。
    pub fn intersection(&self, other: &PhysicalRect) -> Option<PhysicalRect> {
        let x0 = self.min_x().max(other.min_x());
        let y0 = self.min_y().max(other.min_y());
        let x1 = self.max_x().min(other.max_x());
        let y1 = self.max_y().min(other.max_y());
        if x1 - x0 >= 1 && y1 - y0 >= 1 {
            Some(PhysicalRect {
                x: x0.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
                y: y0.clamp(i32::MIN as i64, i32::MAX as i64) as i32,
                width: (x1 - x0).min(u32::MAX as i64) as u32,
                height: (y1 - y0).min(u32::MAX as i64) as u32,
            })
        } else {
            None
        }
    }
}

pub type MonitorId = u64; // Windows: HMONITOR as u64；macOS: CGDirectDisplayID
pub type WindowId = u64;  // Windows: HWND as u64；macOS: CGWindowID as u64

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitorInfo {
    pub id: MonitorId,
    pub name: String,
    /// 物理像素、虚拟屏坐标（对应 displayBoundsForMouseOrMainScreen 的 bounds 语义）
    pub bounds: PhysicalRect,
    /// 物理px / 逻辑pt（Windows GetDpiForMonitor/100，macOS backingScaleFactor）
    pub scale_factor: f64,
    /// 去菜单栏/任务栏/Dock 的可用区（对应 desktopTarget 使用的 visible bounds）
    pub visible_bounds: PhysicalRect,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WindowKind {
    Normal,
    Desktop,   // 壁纸/图标层（com.apple.finder 桌面、Progman/WorkerW）
    Shell,     // 系统壳层（WindowManager/Spotlight/Shell_TrayWnd…）
    Tooltip,   // 悬停提示级浮窗
    OwnWindow, // 本产品自身窗口（永远排除，对应动态 excludedWindowIds）
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub id: WindowId,
    pub pid: u32,
    pub title: Option<String>,
    pub app_name: Option<String>,
    /// macOS bundleIdentifier / Windows exe 名（对应反射字段 bundleIdOrExe 的原料）
    pub app_id: Option<String>,
    /// Windows: DWMWA_EXTENDED_FRAME_BOUNDS（去阴影），macOS: kCGWindowBounds。物理、虚拟屏坐标。
    pub bounds: PhysicalRect,
    /// 0 = 最前。后端不得重排（原理 §1 的契约所在）。
    pub z_index: usize,
    /// macOS kCGWindowLayer；Windows 由 ex-style 映射（topmost=0，其余=5，桌面=10）
    pub layer: i32,
    pub is_on_screen: bool,
    /// Windows DWMWA_CLOAKED；macOS 恒 false
    pub cloaked: bool,
    pub kind: WindowKind,
}

/// 统一像素缓冲：RGBA8（非预乘 alpha），stride 允许 >= width*4。
/// 两侧原生（BGRA DIB / WGC B8G8R8A8）由后端负责就地换序。
#[derive(Debug, Clone)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub stride: usize,
    pub pixels: Vec<u8>,
}

impl Frame {
    pub fn new(width: u32, height: u32, stride: usize, pixels: Vec<u8>) -> Option<Self> {
        if pixels.len() >= stride * height as usize {
            Some(Self { width, height, stride, pixels })
        } else {
            None
        }
    }

    /// 帧自身坐标（左上原点）
    pub fn rect(&self) -> PhysicalRect {
        PhysicalRect::new(0, 0, self.width, self.height)
    }

    /// 裁剪：rect 须位于帧内（上层先用 coord::virtual_to_monitor 换算并 clamp）。
    pub fn crop(&self, rect: &PhysicalRect) -> Result<Frame, crate::CaptureError> {
        let fr = self.rect();
        let r = fr
            .intersection(rect)
            .ok_or(crate::CaptureError::DegenerateGeometry("crop rect outside frame"))?;
        if r.width < 1 || r.height < 1 {
            return Err(crate::CaptureError::DegenerateGeometry("empty crop"));
        }
        let mut out = Vec::with_capacity((r.width * r.height * 4) as usize);
        for y in 0..r.height {
            let sy = (r.y as u32 + y) as usize;
            let row = &self.pixels[sy * self.stride
                + (r.x as u32 as usize * 4)..sy * self.stride + ((r.x as u32 + r.width) as usize * 4)];
            out.extend_from_slice(row);
        }
        Ok(Frame { width: r.width, height: r.height, stride: r.width as usize * 4, pixels: out })
    }

    /// 单像素读取（放大镜）。越界返回全 0。
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        if x >= self.width || y >= self.height {
            return [0; 4];
        }
        let i = y as usize * self.stride + x as usize * 4;
        [self.pixels[i], self.pixels[i + 1], self.pixels[i + 2], self.pixels[i + 3]]
    }

    /// stride 展平为稠密缓冲（供 image crate / webview 上传）。
    pub fn densify(&self) -> Vec<u8> {
        let row = self.width as usize * 4;
        if self.stride == row {
            return self.pixels.iter().take(row * self.height as usize).cloned().collect();
        }
        let mut out = Vec::with_capacity(row * self.height as usize);
        for y in 0..self.height as usize {
            out.extend_from_slice(&self.pixels[y * self.stride..y * self.stride + row]);
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionKind {
    ScreenRecording,
    Accessibility,
}

/// 权限状态。`None` = **这个平台根本没有这项权限概念**（Windows 无 TCC），不是「未授权」。
/// 前端据此显示「不适用」并收起授权按钮：硬编码 `true` 等于谎称查过，硬编码 `false`
/// 会把人赶去系统设置里白找一通（本机就是这样：设置页永远显示「未授权」）。
///
/// `rename_all = "camelCase"` 是**契约**，别删：`ui/src/shared/types.ts` 读的是
/// `screenRecording`，serde 默认的 snake_case 会让它取到 undefined，于是 `? :` 恒走
/// 「未授权」分支 —— 类型是 `boolean` 而非 `boolean | null`，tsc 也拦不住。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub screen_recording: Option<bool>,
    pub accessibility: Option<bool>,
}

impl PermissionStatus {
    /// 本平台不检测权限（Windows）
    pub const NOT_APPLICABLE: Self = Self { screen_recording: None, accessibility: None };
    /// macOS 上两项都没拿到
    pub const NONE: Self = Self { screen_recording: Some(false), accessibility: Some(false) };
}
