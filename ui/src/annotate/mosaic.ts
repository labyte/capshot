//! 马赛克 / 模糊：全部**按图形局部**生成，不预先铺一张全屏图。
//! 迁移前 buildMosaic() 无条件为每个 overlay 窗建一张全屏 1/8→全幅的画布；
//! 局部做法在内存与首帧成本上都更省，且图形改尺寸时质量不丢。

import type { Rect } from "../overlay/engine/types";

/** 像素化：把 r 区域降到 1/level 再无平滑放大回来 */
export function drawBlocked(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  r: Rect,
  level: number,
  scratch: HTMLCanvasElement,
): void {
  const bs = Math.max(2, Math.round(level));
  const sw = Math.max(1, Math.floor(r.w / bs));
  const sh = Math.max(1, Math.floor(r.h / bs));
  scratch.width = sw;
  scratch.height = sh;
  const sc = scratch.getContext("2d");
  if (!sc) return;
  sc.imageSmoothingEnabled = true;
  sc.clearRect(0, 0, sw, sh);
  sc.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, sw, sh);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
  ctx.restore();
}

/** 模糊：区域外扩半径再裁回，避免边缘发虚露白 */
export function drawBlurred(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  r: Rect,
  radius: number,
): void {
  const pad = Math.max(2, Math.round(radius * 2));
  const ex = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.filter = `blur(${Math.round(radius)}px)`;
  ctx.drawImage(source, ex.x, ex.y, ex.w, ex.h, ex.x, ex.y, ex.w, ex.h);
  ctx.restore();
}

export function makeScratch(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  return c;
}
