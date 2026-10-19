//! CoreGraphics 直连层：窗口枚举、两级抓取、权限 preflight。
//! 实参与判定全部对齐已验证的参考实现（AppShotCaptureController）：
//! - 列表: (OnScreenOnly|ExcludeDesktopElements = 0x11, kCGNullWindowID) 前→后有序
//! - 窗口: CGWindowListCreateImage(.null, IncludingWindow(8), id, IgnoreFraming|BestResolution(9))
//! - 帧:   CGWindowListCreateImage(rect, OnScreenOnly(1), 0, BestResolution(8))

use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImage;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID,
    kCGWindowImageBoundsIgnoreFraming, kCGWindowImageBestResolution,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionIncludingWindow,
    kCGWindowListOptionOnScreenOnly, CGWindowID,
};
use core_graphics::window as cgwindow;

use capture_core::types::{WindowId, WindowInfo, WindowKind};

// crate 未包装的符号，自行声明（同 framework 静态链接；edition2024 要求 unsafe extern）
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFBooleanGetValue(b: core_foundation_sys::number::CFBooleanRef) -> u8; // C Boolean
}

pub const OPTION_LIST: u32 = kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements;
pub const IMAGE_OPTION_WINDOW: u32 = kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution;
pub const IMAGE_OPTION_FRAME: u32 = kCGWindowImageBestResolution;

/// 系统壳 bundle（观察 cstring 三件套）
pub const SYSTEM_SHELL_BUNDLES: [&str; 3] = [
    "com.apple.WindowManager",
    "com.apple.Spotlight",
    "com.apple.SpotlightDaemon",
];
pub const FINDER_BUNDLE: &str = "com.apple.finder";

fn key(p: core_foundation_sys::string::CFStringRef) -> CFString {
    unsafe { CFString::wrap_under_get_rule(p) }
}

fn dict_lookup_str(d: &CFDictionary, k: &CFString) -> Option<String> {
    let raw = *d.find::<*const std::ffi::c_void>(k.as_CFTypeRef())?;
    let v = unsafe { CFType::wrap_under_get_rule(raw) };
    Some(v.downcast::<CFString>()?.to_string())
}

fn dict_lookup_f64(d: &CFDictionary, k: &CFString) -> Option<f64> {
    let raw = *d.find::<*const std::ffi::c_void>(k.as_CFTypeRef())?;
    let v = unsafe { CFType::wrap_under_get_rule(raw) };
    v.downcast::<CFNumber>()?.to_f64()
}

fn dict_lookup_bool(d: &CFDictionary, k: &CFString) -> Option<bool> {
    let raw = *d.find::<*const std::ffi::c_void>(k.as_CFTypeRef())?;
    Some(unsafe { CFBooleanGetValue(raw as _) != 0 })
}

fn dict_lookup_i32(d: &CFDictionary, k: &CFString) -> Option<i32> {
    dict_lookup_f64(d, k).map(|x| x as i32)
}

fn dict_lookup_dict(d: &CFDictionary, k: &CFString) -> Option<CFDictionary> {
    let raw = *d.find::<*const std::ffi::c_void>(k.as_CFTypeRef())?;
    let v = unsafe { CFType::wrap_under_get_rule(raw) };
    v.downcast::<CFDictionary>()
}

/// 单行字典 → WindowInfo。参考 makeCGWindowInfo(from:) + isSystemShellWindow 判定。
fn row_to_window(item: *const std::ffi::c_void, z_index: usize) -> Option<WindowInfo> {
    let d = unsafe { CFDictionary::<CFType, CFType>::wrap_under_get_rule(item as _) };
    let d = d.to_untyped();
    let num = dict_lookup_i32(&d, &key(unsafe { cgwindow::kCGWindowNumber }))? as u32;
    let pid = dict_lookup_i32(&d, &key(unsafe { cgwindow::kCGWindowOwnerPID }))? as u32;
    let layer = dict_lookup_i32(&d, &key(unsafe { cgwindow::kCGWindowLayer })).unwrap_or(0);
    let title = dict_lookup_str(&d, &key(unsafe { cgwindow::kCGWindowName }));
    let owner = dict_lookup_str(&d, &key(unsafe { cgwindow::kCGWindowOwnerName }));
    let bundle = dict_lookup_str(&d, &CFString::new("kCGWindowOwnerBundleID"));
    let is_on_screen = dict_lookup_bool(&d, &key(unsafe { cgwindow::kCGWindowIsOnscreen })).unwrap_or(true);
    let bd = dict_lookup_dict(&d, &key(unsafe { cgwindow::kCGWindowBounds }))?;
    let x = dict_lookup_f64(&bd, &CFString::new("X"))? as i32;
    let y = dict_lookup_f64(&bd, &CFString::new("Y"))? as i32;
    let w = dict_lookup_f64(&bd, &CFString::new("Width"))?.max(0.0) as u32;
    let h = dict_lookup_f64(&bd, &CFString::new("Height"))?.max(0.0) as u32;

    // kind：layer<0 桌面族；壳 bundle；Finder 无题全幅桌面窗；layer>0 浮层
    let bid = bundle.as_deref().unwrap_or("");
    let kind = if SYSTEM_SHELL_BUNDLES.contains(&bid) {
        WindowKind::Shell
    } else if layer < 0 || (bid == FINDER_BUNDLE && title.as_deref().unwrap_or("").is_empty()) {
        WindowKind::Desktop
    } else if layer > 0 {
        WindowKind::Tooltip
    } else {
        WindowKind::Normal
    };

    Some(WindowInfo {
        id: num as WindowId,
        pid,
        title,
        app_name: owner,
        app_id: bundle,
        bounds: capture_core::types::PhysicalRect::new(x, y, w, h),
        z_index,
        layer,
        is_on_screen,
        cloaked: false,
        kind,
    })
}

/// 前→后有序（z_index 契约）。
pub fn list_windows() -> Vec<WindowInfo> {
    let Some(array) = copy_window_info(OPTION_LIST, kCGNullWindowID) else { return Vec::new() };
    let mut out = Vec::new();
    for i in 0..array.len() {
        if let Some(item) = array.get(i) {
            let ptr = *item;
            if let Some(w) = row_to_window(ptr, out.len()) {
                out.push(w);
            }
        }
    }
    out
}

fn create_image(rect: CGRect, option: u32, id: CGWindowID, img_opt: u32) -> Option<CGImage> {
    cgwindow::create_image(rect, option, id, img_opt)
}

/// 干净窗口图（第一级；观察 rect 全局量未证实 → 按惯例 .null，见 README“未证实项”）。
pub fn capture_window_image(id: WindowId) -> Option<CGImage> {
    // CGRectNull = {{inf, inf}, {0, 0}}（Apple 定义；Swift CGRect.null 同此）
    let null = CGRect::new(
        &CGPoint { x: f64::INFINITY, y: f64::INFINITY },
        &CGSize { width: 0.0, height: 0.0 },
    );
    create_image(null, kCGWindowListOptionIncludingWindow, id as CGWindowID, IMAGE_OPTION_WINDOW)
}

/// 屏幕帧兜底（第二级）。rect 为 CG point 全局域（左上原点 y 向下）。
pub fn capture_screen_frame(x: i32, y: i32, w: u32, h: u32) -> Option<CGImage> {
    let rect = CGRect::new(
        &CGPoint { x: x as f64, y: y as f64 },
        &CGSize { width: w as f64, height: h as f64 },
    );
    create_image(rect, kCGWindowListOptionOnScreenOnly, 0, IMAGE_OPTION_FRAME)
}

// ---- 权限 ----
pub fn screen_capture_allowed() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}
pub fn request_screen_capture() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}
