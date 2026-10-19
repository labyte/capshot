//! 编码层。逆向原理对齐：内部工作缓冲一律无损 RGBA/PNG；
//! 只有缩略图与可选导出走 JPEG，质量默认 **0.86**（观察 double 0x3FEBB851EB851EB8）。

use crate::error::Result;
use crate::types::Frame;
use image::{ImageBuffer, Rgba, RgbaImage};

pub const DEFAULT_JPEG_QUALITY: f64 = 0.86;
pub const THUMB_MAX: u32 = 256;

fn to_image(frame: &Frame) -> Result<RgbaImage> {
    ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(frame.width, frame.height, frame.densify())
        .ok_or(crate::CaptureError::DegenerateGeometry("frame buffer size mismatch"))
}

pub fn to_png(frame: &Frame) -> Result<Vec<u8>> {
    let img = to_image(frame)?;
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png)
        .map_err(|e| crate::CaptureError::Platform { api: "png_encode", os_status: e.to_string() })?;
    Ok(out.into_inner())
}

/// quality: 0..=1（默认 0.86）
pub fn to_jpeg(frame: &Frame, quality: f64) -> Result<Vec<u8>> {
    let img = to_image(frame)?;
    let mut out = std::io::Cursor::new(Vec::new());
    // JPEG 无 alpha：抓取帧本身不透明，直接丢 alpha 转 RGB（缩略图另做白底合成）
    let rgb: Vec<u8> = img.into_raw().chunks_exact(4).flat_map(|c| [c[0], c[1], c[2]]).collect();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, (quality.clamp(0.01, 1.0) * 100.0).round() as u8);
    enc.encode(&rgb, frame.width, frame.height, image::ExtendedColorType::Rgb8)
        .map_err(|e| crate::CaptureError::Platform { api: "jpeg_encode", os_status: e.to_string() })?;
    Ok(out.into_inner())
}

/// 历史缩略图：等比缩到 THUMB_MAX 内 + JPEG(0.8)。含 alpha → 白底合成
/// （对应 makeOpaqueAnimationImage 的不透明化原理）。
pub fn to_thumbnail(frame: &Frame) -> Result<Vec<u8>> {
    let img = to_image(frame)?;
    let (w, h) = (frame.width.max(1), frame.height.max(1));
    let scale = (THUMB_MAX as f64 / w.max(h) as f64).min(1.0);
    let (tw, th) = (((w as f64) * scale).round().max(1.0) as u32, ((h as f64) * scale).round().max(1.0) as u32);
    let small = image::imageops::resize(&img, tw, th, image::imageops::FilterType::Lanczos3);
    // RGBA -> RGB（白底）
    let rgb: Vec<u8> = small.pixels().flat_map(|p| {
        let a = p[3] as u32;
        [
            ((p[0] as u32 * a + 255 * (255 - a)) / 255) as u8,
            ((p[1] as u32 * a + 255 * (255 - a)) / 255) as u8,
            ((p[2] as u32 * a + 255 * (255 - a)) / 255) as u8,
        ]
    }).collect();
    let img2 = ImageBuffer::<image::Rgb<u8>, Vec<u8>>::from_raw(tw, th, rgb)
        .ok_or(crate::CaptureError::DegenerateGeometry("thumb buffer"))?;
    let mut out = std::io::Cursor::new(Vec::new());
    img2.write_to(&mut out, image::ImageFormat::Jpeg)
        .map_err(|e| crate::CaptureError::Platform { api: "thumb_encode", os_status: e.to_string() })?;
    Ok(out.into_inner())
}
