//! 贴图几何：窗口矩形 = 图像矩形四周各扩 pad（物理 px，与 Rust 的 PIN_PAD 一致）。
//! 缩放必须锚在**图像**坐标系上而不是窗口坐标系 —— 否则光标下的像素会随留白偏移漂移，
//! 这正是迁移前那版「outer 比图像实际位置偏 8px」注释想绕开的问题。

export interface WinGeom {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface ImgRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const imgFromWin = (g: WinGeom, pad: number): ImgRect => ({
  x: g.x + pad,
  y: g.y + pad,
  w: g.width - pad * 2,
  h: g.height - pad * 2,
});

export const winFromImg = (r: ImgRect, pad: number) => ({
  x: Math.round(r.x - pad),
  y: Math.round(r.y - pad),
  width: Math.max(1, Math.round(r.w + pad * 2)),
  height: Math.max(1, Math.round(r.h + pad * 2)),
});

/**
 * 以光标为不动点缩放。
 * @param cur 光标的全屏物理坐标
 * @param factor 倍率（作用于当前图像尺寸）
 */
export function zoomAbout(
  img: ImgRect,
  cur: { x: number; y: number },
  factor: number,
  minW: number,
  maxW: number,
): ImgRect {
  const fx = img.w > 0 ? (cur.x - img.x) / img.w : 0.5;
  const fy = img.h > 0 ? (cur.y - img.y) / img.h : 0.5;
  const nw = Math.max(minW, Math.min(maxW, Math.round(img.w * factor)));
  const nh = Math.max(1, Math.round((img.h / img.w) * nw));
  return { x: Math.round(cur.x - fx * nw), y: Math.round(cur.y - fy * nh), w: nw, h: nh };
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
