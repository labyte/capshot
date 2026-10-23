//! 马赛克 / 模糊：全部**按图形局部**生成，不预先铺一张全屏图。
//! 迁移前 buildMosaic() 无条件为每个 overlay 窗建一张全屏 1/8→全幅的画布；
//! 局部做法在内存与首帧成本上都更省，且图形改尺寸时质量不丢。

import type { Rect } from "../overlay/engine/types";

/**
 * 像素化。旧做法是"缩小到 sw×sh 再无平滑放大"，但 `sw = floor(r.w/bs)` 放大回去后
 * 每块宽 = r.w/sw ≠ bs，于是**同一张马赛克里有的块 8px、有的 9px**，看着抖且发糊；
 * 相邻两个马赛克图形还各自一套网格，拼起来错位。
 *
 * 现在：**网格按 bs 对齐到整帧原点**（`x0 = floor(r.x/bs)*bs`），取样矩形与目标尺寸都是
 * bs 的整数倍 → 一次面积平均 + 一次最近邻放大，每块必然正好 bs×bs。
 * 成本仍是两次 drawImage。中途试过"getImageData + 每块 fillRect"：结果正确但
 * 粗粒度大面积会爆（800×600 在 bs=4 下每帧 3 万次 fillRect，拖动直接掉帧），已放弃。
 */
export function drawBlocked(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  r: Rect,
  level: number,
  scratch: HTMLCanvasElement,
): void {
  const bs = Math.max(2, Math.round(level));
  // 块原点向下取整到 bs 的整数倍 → 所有马赛克图形共享同一网格
  const x0 = Math.floor(r.x / bs) * bs;
  const y0 = Math.floor(r.y / bs) * bs;
  const cols = Math.max(1, Math.ceil((r.x + r.w - x0) / bs));
  const rows = Math.max(1, Math.ceil((r.y + r.h - y0) / bs));
  scratch.width = cols;
  scratch.height = rows;
  const sc = scratch.getContext("2d");
  if (!sc) return;
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = "high";
  sc.clearRect(0, 0, cols, rows);
  // 取样矩形跨到整块边界：每个缩略像素正好等于一个 bs×bs 块的平均色
  sc.drawImage(source, x0, y0, cols * bs, rows * bs, 0, 0, cols, rows);
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h); // 只保留形状范围内，超出整块的部分裁掉
  ctx.clip();
  ctx.imageSmoothingEnabled = false; // 最近邻：块边界硬、不糊
  ctx.drawImage(scratch, 0, 0, cols, rows, x0, y0, cols * bs, rows * bs);
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
