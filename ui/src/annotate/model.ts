//! 标注图形数据模型（annotationJson v2）。
//! 坐标：绘制期为「本显示器物理 px」；导出时转成「选区相对 px」再序列化（见 serialize.ts）。

import type { Point, Rect } from "../overlay/engine/types";

export type ShapeKind =
  | "rect"
  | "ellipse"
  | "arrow"
  | "polyline"
  | "marker"
  | "text"
  | "mosaic"
  | "step";

export interface BaseShape {
  id: number;
  color: string;
  width: number;
}

export interface RectShape extends BaseShape {
  kind: "rect" | "ellipse";
  r: Rect;
  filled: boolean;
}

export interface ArrowShape extends BaseShape {
  kind: "arrow";
  a: Point;
  b: Point;
}

export interface PathShape extends BaseShape {
  kind: "polyline" | "marker";
  pts: Point[];
}

export interface TextShape extends BaseShape {
  kind: "text";
  at: Point;
  text: string;
  fontPx: number;
  bg: boolean;
}

export interface MosaicShape extends BaseShape {
  kind: "mosaic";
  r: Rect;
  style: "pixel" | "blur";
  /** 像素化粒度（1/blocked 缩放），模糊时为模糊半径 px */
  level: number;
}

export interface StepShape extends BaseShape {
  kind: "step";
  at: Point;
  n: number;
  radius: number;
}

export type Shape =
  | RectShape
  | ArrowShape
  | PathShape
  | TextShape
  | MosaicShape
  | StepShape;

export interface DrawProps {
  color: string;
  width: number;
  filled: boolean;
  fontPx: number;
  textBg: boolean;
  mosaicStyle: "pixel" | "blur";
  mosaicLevel: number;
  stepNo: number;
  stepRadius: number;
}

export const DEFAULT_PROPS: DrawProps = {
  color: "#ff3b30",
  width: 3,
  filled: false,
  fontPx: 18,
  textBg: false,
  mosaicStyle: "pixel",
  mosaicLevel: 8,
  stepNo: 1,
  stepRadius: 14,
};

/** Snipaste 调色板量级的一排预设 */
export const PALETTE = [
  "#ff3b30",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#00c7be",
  "#0a84ff",
  "#5e5ce6",
  "#af52de",
  "#ff2d55",
  "#ffffff",
  "#8e8e93",
  "#000000",
];

export const WIDTHS = [2, 3, 6];

export function shapeBounds(s: Shape): Rect {
  switch (s.kind) {
    case "rect":
    case "ellipse":
    case "mosaic":
      return s.r;
    case "arrow":
      return {
        x: Math.min(s.a.x, s.b.x),
        y: Math.min(s.a.y, s.b.y),
        w: Math.abs(s.b.x - s.a.x),
        h: Math.abs(s.b.y - s.a.y),
      };
    case "polyline":
    case "marker": {
      if (!s.pts.length) return { x: 0, y: 0, w: 0, h: 0 };
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const p of s.pts) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    case "step":
      return { x: s.at.x - s.radius, y: s.at.y - s.radius, w: s.radius * 2, h: s.radius * 2 };
    case "text":
      return { x: s.at.x, y: s.at.y, w: s.text.length * s.fontPx * 0.6, h: s.fontPx * 1.25 };
  }
}

export function translate(s: Shape, dx: number, dy: number): void {
  const move = (p: Point) => {
    p.x += dx;
    p.y += dy;
  };
  switch (s.kind) {
    case "rect":
    case "ellipse":
    case "mosaic":
      s.r.x += dx;
      s.r.y += dy;
      break;
    case "arrow":
      move(s.a);
      move(s.b);
      break;
    case "polyline":
    case "marker":
      s.pts.forEach(move);
      break;
    case "text":
    case "step":
      move(s.at);
      break;
  }
}
