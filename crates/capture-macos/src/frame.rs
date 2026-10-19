//! CGImage → RGBA8 Frame：经 premultipliedLast 位图上下文归一化通道顺序，
//! 再垂直翻转回顶行在前（CG 上下文是左下原点，capture 图像语义是左上原点）。

use capture_core::types::Frame;
use core_graphics::base::kCGImageAlphaPremultipliedLast;
use core_graphics::color_space::CGColorSpace;
use core_graphics::context::CGContext;
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::image::CGImage;

pub fn cgimage_to_frame(img: &CGImage) -> Option<Frame> {
    let w = img.width() as u32;
    let h = img.height() as u32;
    if w == 0 || h == 0 {
        return None;
    }
    let cs = CGColorSpace::create_device_rgb();
    let mut ctx = CGContext::create_bitmap_context(
        None,
        w as usize,
        h as usize,
        8,
        (w as usize) * 4,
        &cs,
        kCGImageAlphaPremultipliedLast,
    );
    ctx.draw_image(
        CGRect::new(&CGPoint { x: 0.0, y: 0.0 }, &CGSize { width: w as f64, height: h as f64 }),
        img,
    );
    let bpr = ctx.bytes_per_row();
    let mut data = ctx.data().to_vec();
    data.resize(bpr * h as usize, 0);
    // 行翻转：上下文首行 = 图像底部
    if bpr == (w as usize) * 4 {
        let rows: Vec<Vec<u8>> = data.chunks_exact(bpr).map(|r| r.to_vec()).collect();
        let mut out = Vec::with_capacity(data.len());
        for row in rows.into_iter().rev() {
            out.extend_from_slice(&row);
        }
        data = out;
    }
    Frame::new(w, h, bpr, data)
}
