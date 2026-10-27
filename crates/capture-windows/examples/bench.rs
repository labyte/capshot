//! 临时性能基准：量化截图链路各环节的真实耗时与内存放大倍数。
//! 用完即删，不进 release.yml。

#[cfg(windows)]
use capture_core::{encode, CaptureBackend};
#[cfg(windows)]
use capture_windows::WindowsBackend;
#[cfg(windows)]
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
#[cfg(windows)]
use image::ImageEncoder;
#[cfg(windows)]
use std::time::Instant;

#[cfg(windows)]
fn bench(label: &str, f: impl Fn() -> usize) {
    // 预热一次，之后取 3 次最小值（避开首次分配/D3D 初始化抖动）
    let _ = f();
    let mut best = u128::MAX;
    let mut bytes = 0usize;
    for _ in 0..3 {
        let t = Instant::now();
        bytes = f();
        let ms = t.elapsed().as_millis();
        if ms < best {
            best = ms;
        }
    }
    println!("{label:<42} {best:>6} ms   out={:>10} B", bytes);
}

#[cfg(windows)]
fn png_with(frame: &capture_core::Frame, c: CompressionType, ft: FilterType) -> Vec<u8> {
    let rgba = frame.densify();
    let mut out = Vec::new();
    let enc = PngEncoder::new_with_quality(&mut out, c, ft);
    enc.write_image(&rgba, frame.width, frame.height, image::ExtendedColorType::Rgba8)
        .unwrap();
    out
}

#[cfg(windows)]
fn thumb_with(frame: &capture_core::Frame, ft: image::imageops::FilterType) -> usize {
    let img = image::RgbaImage::from_raw(frame.width, frame.height, frame.densify()).unwrap();
    let (w, h) = (frame.width.max(1), frame.height.max(1));
    let s = (256f64 / w.max(h) as f64).min(1.0);
    let small = image::imageops::resize(
        &img,
        ((w as f64 * s).round().max(1.0)) as u32,
        ((h as f64 * s).round().max(1.0)) as u32,
        ft,
    );
    let rgb: Vec<u8> = small
        .pixels()
        .flat_map(|p| {
            let a = p[3] as u32;
            [
                ((p[0] as u32 * a + 255 * (255 - a)) / 255) as u8,
                ((p[1] as u32 * a + 255 * (255 - a)) / 255) as u8,
                ((p[2] as u32 * a + 255 * (255 - a)) / 255) as u8,
            ]
        })
        .collect();
    let img2 = image::RgbImage::from_raw(small.width(), small.height(), rgb).unwrap();
    let mut out = std::io::Cursor::new(Vec::new());
    img2.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner().len()
}

#[cfg(windows)]
fn body() {
    let be = WindowsBackend::new().expect("backend");
    let ms = be.monitors().unwrap();
    println!("monitors:");
    for m in &ms {
        println!(
            "  id={} {}x{} @({},{}) scale={} primary={}",
            m.id, m.bounds.width, m.bounds.height, m.bounds.x, m.bounds.y, m.scale_factor, m.is_primary
        );
    }
    let primary = ms.iter().find(|m| m.is_primary).or(ms.first()).unwrap();

    println!("\n--- 抓屏（WGC 单帧，含 D3D 设备创建）---");
    bench("backend.capture_monitor(primary)", || {
        be.capture_monitor(primary.id).map(|f| f.pixels.len()).unwrap_or(0)
    });

    let frame = be.capture_monitor(primary.id).expect("frame");
    let raw = frame.pixels.len();
    println!(
        "\nframe {}x{} raw RGBA = {:.1} MB (stride={})",
        frame.width,
        frame.height,
        raw as f64 / 1048576.0,
        frame.stride
    );

    println!("\n--- 编码（overlay 底图 / 导出）---");
    bench("encode::to_png  (默认 Default+Adaptive)", || {
        encode::to_png(&frame).map(|v| v.len()).unwrap_or(0)
    });
    bench("png Fast + NoFilter", || {
        png_with(&frame, CompressionType::Fast, FilterType::NoFilter).len()
    });
    bench("png Fast + Sub", || {
        png_with(&frame, CompressionType::Fast, FilterType::Sub).len()
    });
    bench("png Best + Adaptive", || {
        png_with(&frame, CompressionType::Best, FilterType::Adaptive).len()
    });
    bench("jpeg q86 (encode::to_jpeg)", || {
        encode::to_jpeg(&frame, 0.86).map(|v| v.len()).unwrap_or(0)
    });
    bench("png 直写 Vec::with_capacity 预留", || {
        let rgba = frame.densify();
        let mut out = Vec::with_capacity(rgba.len() / 4);
        let enc = PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Sub);
        enc.write_image(&rgba, frame.width, frame.height, image::ExtendedColorType::Rgba8)
            .unwrap();
        out.len()
    });

    println!("\n--- PNG 解码（png_to_frame，导出回路里会做一次）---");
    let png_default = encode::to_png(&frame).unwrap();
    let png_fast = png_with(&frame, CompressionType::Fast, FilterType::NoFilter);
    bench("decode png(Default+Adaptive)", || {
        image::load_from_memory(&png_default)
            .map(|i| i.to_rgba8().into_raw().len())
            .unwrap_or(0)
    });
    bench("decode png(Fast+NoFilter)", || {
        image::load_from_memory(&png_fast)
            .map(|i| i.to_rgba8().into_raw().len())
            .unwrap_or(0)
    });

    println!("\n--- 缩略图（history insert 同步路径）---");
    bench("encode::to_thumbnail (Lanczos3, 现状)", || {
        encode::to_thumbnail(&frame).map(|v| v.len()).unwrap_or(0)
    });
    bench("thumbnail Triangle", || {
        thumb_with(&frame, image::imageops::FilterType::Triangle)
    });
    bench("thumbnail CatmullRom", || {
        thumb_with(&frame, image::imageops::FilterType::CatmullRom)
    });
    bench("thumbnail Nearest", || {
        thumb_with(&frame, image::imageops::FilterType::Nearest)
    });

    println!("\n--- 纯内存搬运（相对 raw {:.1} MB 的放大倍数）---", raw as f64 / 1048576.0);
    bench("Frame::densify()", || frame.densify().len());
    bench("Frame::crop(中心 1920x1080)", || {
        let cx = (frame.width.saturating_sub(1920) / 2) as i32;
        let cy = (frame.height.saturating_sub(1080) / 2) as i32;
        frame
            .crop(&capture_core::PhysicalRect::new(cx, cy, 1920, 1080))
            .map(|f| f.pixels.len())
            .unwrap_or(0)
    });
    bench("base64 encode(png_fast)", || {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .encode(&png_fast)
            .len()
    });

    println!("\n--- 窗口枚举 ---");
    bench("list_windows()", || be.list_windows().map(|w| w.len()).unwrap_or(0));
    bench("monitors()", || be.monitors().map(|m| m.len()).unwrap_or(0));

    println!("\n--- trigger_capture 冷路径全量（= 按 F1 到帧就绪）---");
    bench("monitors+list_windows+capture+png 全套", || {
        let ms = be.monitors().unwrap();
        let _ws = be.list_windows().unwrap();
        let mut total = 0usize;
        for m in &ms {
            let f = be.capture_monitor(m.id).unwrap();
            total += encode::to_png(&f).map(|v| v.len()).unwrap_or(0);
        }
        total
    });
    bench("  其中：仅 monitors+list_windows", || {
        let ms = be.monitors().unwrap();
        let ws = be.list_windows().unwrap();
        ms.len() + ws.len()
    });
}

#[cfg(not(windows))]
fn body() {}

fn main() {
    if cfg!(windows) {
        body();
    } else {
        println!("windows-only");
    }
}
