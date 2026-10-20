//! overlay 内部几何一律**物理像素、本显示器局部**；提交时换算虚拟屏（capture-core 契约）。

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export type ToolId = "rect" | "ellipse" | "arrow" | "polyline" | "marker" | "text" | "mosaic" | "step";

/** 交互阶段：悬停检测 → 拖框 → 已定选区 → 画图中 → 拖拽已有图形 */
export type Phase = "picking" | "drawing" | "adjusting" | "tool-drawing" | "shape-drag";

export const norm = (x0: number, y0: number, dx: number, dy: number): Rect => ({
  x: dx < 0 ? x0 + dx : x0,
  y: dy < 0 ? y0 + dy : y0,
  w: Math.abs(dx),
  h: Math.abs(dy),
});

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export const rectEq = (a: Rect | null, b: Rect | null) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

export function moveRect(r: Rect, dx: number, dy: number, bound: Size): Rect {
  return {
    x: clamp(r.x + dx, 0, bound.w - r.w),
    y: clamp(r.y + dy, 0, bound.h - r.h),
    w: r.w,
    h: r.h,
  };
}

export interface Size {
  w: number;
  h: number;
}

/** 8 向手柄位置与对应光标 */
export function handlePoints(r: Rect): { k: Handle; x: number; y: number }[] {
  return [
    { k: "nw", x: r.x, y: r.y },
    { k: "n", x: r.x + r.w / 2, y: r.y },
    { k: "ne", x: r.x + r.w, y: r.y },
    { k: "e", x: r.x + r.w, y: r.y + r.h / 2 },
    { k: "se", x: r.x + r.w, y: r.y + r.h },
    { k: "s", x: r.x + r.w / 2, y: r.y + r.h },
    { k: "sw", x: r.x, y: r.y + r.h },
    { k: "w", x: r.x, y: r.y + r.h / 2 },
  ];
}

export const CURSOR_FOR_HANDLE: Record<Handle, string> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};
