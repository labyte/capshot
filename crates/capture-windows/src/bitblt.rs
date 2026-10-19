//! GDI BitBlt 回退路径（WGC 不可用时）。顶层窗口（含硬件加速层）可能黑 —— 与文档一致。
//! 顶部 DIB（负 biHeight）+ CAPTUREBLT，BGRA→RGBA。对应参考的 fallback 链第二级。

use capture_core::error::{CaptureError, Result};
use capture_core::types::{Frame, PhysicalRect};
use std::ffi::c_void;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection, DeleteDC,
    DeleteObject, DIB_RGB_COLORS, GetDC, HBITMAP, HDC, HGDIOBJ, ReleaseDC, SRCCOPY,
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER,
};

fn dib_capture(x: i32, y: i32, w: u32, h: u32, blit_from: Option<(HDC, i32, i32)>) -> Result<Frame> {
    unsafe {
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32), // 顶行在前
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits: *mut c_void = std::ptr::null_mut();
    let hbmp: HBITMAP = CreateDIBSection(Some(mem), &bmi as *const _, DIB_RGB_COLORS, &mut bits, None, 0)
        .map_err(|e| CaptureError::Platform { api: "CreateDIBSection", os_status: format!("{e:?}") })?;
    let old: HGDIOBJ = select_object_into(mem, hbmp);
    let result = if let Some((src, sx, sy)) = blit_from {
        BitBlt(mem, 0, 0, w as i32, h as i32, Some(src), sx, sy, SRCCOPY | CAPTUREBLT)
    } else {
        BitBlt(mem, 0, 0, w as i32, h as i32, Some(screen), x, y, SRCCOPY | CAPTUREBLT)
    };
    let mut out = Err(CaptureError::Platform { api: "BitBlt", os_status: "failed".into() });
    if result.is_ok() {
        let row = w as usize * 4;
        let mut pixels = vec![0u8; row * h as usize];
        let src = bits as *const u8;
        for yy in 0..h as usize {
            let r = std::slice::from_raw_parts(src.add(yy * row), row);
            pixels[yy * row..(yy + 1) * row].copy_from_slice(r);
        }
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        out = Frame::new(w, h, row, pixels).ok_or(CaptureError::DegenerateGeometry("bitblt frame"));
    }
    select_object_into(mem, old);
    let _ = DeleteObject(hbmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    out
    }
}

// SelectObject 在 windows crate 返回 HGDIOBJ
fn select_object_into(hdc: HDC, obj: impl Into<HGDIOBJ>) -> HGDIOBJ {
    unsafe { windows::Win32::Graphics::Gdi::SelectObject(hdc, obj.into()) }
}

/// 任意虚拟屏物理矩形（冻结帧兜底、区域抓取的 Windows 等价物）。
pub fn capture_region(rect: &PhysicalRect) -> Result<Frame> {
    if rect.width < 1 || rect.height < 1 {
        return Err(CaptureError::DegenerateGeometry("capture screen frame invisible frame"));
    }
    dib_capture(rect.x, rect.y, rect.width, rect.height, None)
}

/// 单显示器（hmon bounds 已由调用方给出）——BitBlt 域即虚拟屏坐标。
pub fn capture_monitor_rect(bounds: &PhysicalRect) -> Result<Frame> {
    capture_region(bounds)
}

