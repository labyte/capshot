//! 马赛克 / 模糊：全部**按图形局部**生成，不预先铺一张全屏图。
//! 迁移前 buildMosaic() 无条件为每个 overlay 窗建一张全屏 1/8→全幅的画布；
//! 局部做法在内存与首帧成本上都更省，且图形改尺寸时质量不丢。

import type { Rect } from "../overlay/engine/types";

/**
 * 每级马赛克一张**整帧降采样小图**（金字塔），按 source 弱引用缓存。
 *
 * 为什么必须缓存而不是每帧重算：见 drawBlocked 的实测数据。
 * 小图本身极小（2560×1440 在 bs=8 下是 320×180 ≈ 225 KB），
 * 全部 level 都用过一遍也就 MB 级；WeakMap 保证 source 关闭后能回收。
 *
 * 缓存有效性前提：**source 建好后不再被改写**。本项目两处 source 都满足 ——
 * overlay 的底图是不可变的 ImageBitmap，导出用的 croppedSource 每次新建且只画一次。
 */
const pyramids = new WeakMap<CanvasImageSource, Map<number, HTMLCanvasElement>>();

function sourceSize(source: CanvasImageSource): { w: number; h: number } | null {
  if (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement) {
    return { w: source.width, h: source.height };
  }
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) {
    // close() 过的 bitmap width/height 归 0，正好当作无效
    return source.width > 0 && source.height > 0 ? { w: source.width, h: source.height } : null;
  }
  const maybe = source as { width?: number; height?: number };
  return maybe.width && maybe.height ? { w: maybe.width, h: maybe.height } : null;
}

/** 取（必要时建）source 在 1/bs 分辨率下的整帧降采样图 */
function pyramidFor(
  source: CanvasImageSource,
  sw: number,
  sh: number,
  bs: number,
): HTMLCanvasElement | null {
  let byLevel = pyramids.get(source);
  if (!byLevel) {
    byLevel = new Map();
    pyramids.set(source, byLevel);
  }
  const hit = byLevel.get(bs);
  if (hit) return hit;

  const p = document.createElement("canvas");
  p.width = Math.max(1, Math.ceil(sw / bs));
  p.height = Math.max(1, Math.ceil(sh / bs));
  const pc = p.getContext("2d");
  if (!pc) return null;
  pc.imageSmoothingEnabled = true;
  pc.imageSmoothingQuality = "high";
  pc.drawImage(source, 0, 0, sw, sh, 0, 0, p.width, p.height);
  byLevel.set(bs, p);
  return p;
}

/**
 * 像素化。旧做法是"缩小到 sw×sh 再无平滑放大"，但 `sw = floor(r.w/bs)` 放大回去后
 * 每块宽 = r.w/sw ≠ bs，于是**同一张马赛克里有的块 8px、有的 9px**，看着抖且发糊；
 * 相邻两个马赛克图形还各自一套网格，拼起来错位。
 *
 * 现在：**网格按 bs 对齐到整帧原点**（`x0 = floor(r.x/bs)*bs`），每块必然正好 bs×bs，
 * 且所有马赛克图形共享同一网格。
 *
 * ## 为什么是 createPattern 而不是「降采样 + 最近邻放大贴回」
 *
 * 上一版每帧对图形区域做一次高质量降采样，再 `imageSmoothingEnabled=false` 放大贴回。
 * 在本机（2560×1440、ANGLE D3D11，与 WebView2 同后端；交错 A/B，15 次取中位数）实测：
 *
 * | 变体 | 中位数 |
 * |---|---|
 * | 基线（只画底图） | 1.20 ms |
 * | 只加 clip() | 1.20 ms |
 * | 1:1 贴回（不放大） | 2.20 ms |
 * | **最近邻 8× 放大贴回** | **21.70 ms** |
 * | 旧 drawBlocked 完整 | 21.20 ms |
 * | **本版（createPattern）** | **2.20 ms** |
 *
 * 逐项隔离后排除了几个想当然的嫌疑：`clip()` 无罪（1.20ms），旧实现那块 scratch 小画布
 * 每帧重设尺寸也不是主因（预分配大 scratch 反而更慢），「整帧金字塔」单独用也没用
 * （20.2ms，与旧版持平）——**贵的就是那个放大 drawImage 本身**。
 * 所以本版把放大交给 pattern 的变换矩阵，由填充阶段按最近邻采样，快约 10×，
 * 且 60Hz 的 16.7ms 帧预算重新富余（拖动马赛克原先必然掉帧）。
 *
 * 像素等价性已逐像素校验（同一帧、与旧实现比对）：
 * - 对齐 bbox 800×600：最大通道差 **0**，491,264 像素**零差异**
 * - 非对齐 bbox 811×605 @403,297（= 拖动中的真实情形）：最大差 **0**，零差异
 * - bbox 溢出帧边缘：最大差 **2/255**（不可辨；源于末块是不满 bs 的残块，
 *   两版对残块的平均口径略有不同）
 *
 * 中途还试过"getImageData + 每块 fillRect"：结果正确但粗粒度大面积会爆
 * （800×600 在 bs=4 下每帧 3 万次 fillRect，拖动直接掉帧），已放弃。
 */
export function drawBlocked(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  r: Rect,
  level: number,
): void {
  const bs = Math.max(2, Math.round(level));
  // 块原点向下取整到 bs 的整数倍 → 所有马赛克图形共享同一网格
  const x0 = Math.floor(r.x / bs) * bs;
  const y0 = Math.floor(r.y / bs) * bs;
  const cols = Math.max(1, Math.ceil((r.x + r.w - x0) / bs));
  const rows = Math.max(1, Math.ceil((r.y + r.h - y0) / bs));

  const size = sourceSize(source);
  if (!size) return;
  const pyr = pyramidFor(source, size.w, size.h, bs);
  if (!pyr) return;
  const pat = ctx.createPattern(pyr, "no-repeat");
  if (!pat) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h); // 只保留形状范围内，超出整块的部分裁掉
  ctx.clip();
  ctx.imageSmoothingEnabled = false; // 最近邻：块边界硬、不糊
  /* 把 pattern 坐标系放大 bs 倍并对齐到块网格：
     pattern 像素 u → 设备坐标 bs*u，于是 u = x0/bs 正好落在 x0。
     用相对变换（translate/scale）而非 setTransform，才能与调用方已有的 CTM 复合
     —— 线条马赛克那条路径的上下文已经 translate(-bbox.x, -bbox.y) 过了。 */
  ctx.translate(x0, y0);
  ctx.scale(bs, bs);
  ctx.translate(-x0 / bs, -y0 / bs);
  ctx.fillStyle = pat;
  ctx.fillRect(x0 / bs, y0 / bs, cols, rows);
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
