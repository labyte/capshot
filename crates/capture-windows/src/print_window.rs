//! PrintWindow 最后兜底（WGC 与 BitBlt 区域都不适用时的干净窗口图）。
//! 已知限制：部分 Chromium/硬件加速窗口会黑/旧帧（PW_RENDERFULLCONTENT 仍不保证）——
//! 与参考引擎的窗口优先语义对齐：尺寸不符即由调用方继续回退屏幕帧。

use capture_core::error::{CaptureError, Result};
use capture_core::types::Frame;
use std::ffi::c_void;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject,
    DIB_RGB_COLORS, GetDC, HBITMAP, HGDIOBJ, ReleaseDC, BI_RGB, BITMAPINFO,
    BITMAPINFOHEADER,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{GetClientRect, PW_RENDERFULLCONTENT};

pub fn capture_window(hwnd: HWND) -> Result<Frame> {
    unsafe {
        let mut rc = windows::Win32::Foundation::RECT::default();
        let _ = GetClientRect(hwnd, &mut rc);
        let w = (rc.right - rc.left).max(0) as u32;
        let h = (rc.bottom - rc.top).max(0) as u32;
        if w < 1 || h < 1 {
            return Err(CaptureError::TargetNotFound);
        }
        let screen = GetDC(None);
        let mem = CreateCompatibleDC(Some(screen));
        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w as i32,
                biHeight: -(h as i32),
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
        let old: HGDIOBJ = windows::Win32::Graphics::Gdi::SelectObject(mem, hbmp.into());
        let ok = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT));
        let mut out = Err(CaptureError::Platform { api: "PrintWindow", os_status: "failed".into() });
        if ok.0 != 0 {
            let row = w as usize * 4;
            let mut pixels = vec![0u8; row * h as usize];
            let src = bits as *const u8;
            for y in 0..h as usize {
                let r = std::slice::from_raw_parts(src.add(y * row), row);
                pixels[y * row..(y + 1) * row].copy_from_slice(r);
            }
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2); // BGRA → RGBA
                px[3] = 255;   // 白底不透明化（对应 makeOpaqueAnimationImage 语义近似）
            }
            out = Frame::new(w, h, row, pixels).ok_or(CaptureError::DegenerateGeometry("pw frame"));
        }
        windows::Win32::Graphics::Gdi::SelectObject(mem, old);
        let _ = DeleteObject(hbmp.into());
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        out
    }
}
