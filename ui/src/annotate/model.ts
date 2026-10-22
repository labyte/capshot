//! 标注图形数据模型（annotationJson v2）。
//! 坐标：绘制期为「本显示器物理 px」；导出时转成「选区相对 px」再序列化（见 serialize.ts）。

import { handlePoints, resizeRect, type Handle, type Point, type Rect } from "../overlay/engine/types";

export type ShapeKind =
  | "rect"
  | "ellipse"
  | "arrow"
  | "polyline"
  | "marker"
  | "text"
  | "mosaic"
  | "step"
  | "erase";

export interface BaseShape {
  id: number;
  color: string;
  width: number;
}

export interface RectShape extends BaseShape {
  kind: "rect" | "ellipse";
  r: Rect;
  filled: boolean;
  /** 记号笔矩形模式：半透明高亮框（无描边），区别于普通矩形 */
  marker?: boolean;
}

export type ArrowHead = "solid" | "hollow" | "none";

export interface ArrowShape extends BaseShape {
  kind: "arrow";
  a: Point;
  b: Point;
  /** 双向箭头（属性栏的 →/↔ 选择）。旧数据缺省 = 单向 */
  double?: boolean;
  /** 箭头头部样式：实心三角 / 空心 V / 无头直线。旧数据缺省 = solid */
  head?: ArrowHead;
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
  /** 文字样式（Snipaste 属性栏的 B/I/删除线/字体）。旧数据没有这些字段，一律按缺省渲染 */
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  family?: string;
}

export interface MosaicShape extends BaseShape {
  kind: "mosaic";
  /** 填充模式：矩形区域打码。线条模式改用 pts+brush，r 由 pts 推得 */
  r: Rect;
  /** 线条模式：沿折线笔刷打码（brush=笔刷直径物理px） */
  pts?: Point[];
  brush?: number;
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

/** 橡皮擦：不参与常规绘制，渲染时对标注层做 destination-out 打洞。
    mode=path 用 pts 折线擦除（width=笔刷直径），mode=rect 用 r 框选擦除 */
export interface EraseShape extends BaseShape {
  kind: "erase";
  mode: "path" | "rect";
  pts?: Point[];
  r?: Rect;
}

export type Shape =
  | RectShape
  | ArrowShape
  | PathShape
  | TextShape
  | MosaicShape
  | StepShape
  | EraseShape;

export interface DrawProps {
  color: string;
  width: number;
  filled: boolean;
  fontPx: number;
  textBg: boolean;
  textBold: boolean;
  textItalic: boolean;
  textStrike: boolean;
  textFamily: string;
  /** 箭头：true = 两端箭头（↔），false = 单端（→） */
  arrowDouble: boolean;
  /** 箭头头部样式（与单/双端正交） */
  arrowHead: ArrowHead;
  /** 记号笔：true = 矩形框选高亮，false = 手绘涂抹 */
  markerRect: boolean;
  /** 橡皮擦：true = 矩形框选擦除，false = 手绘擦除 */
  eraserRect: boolean;
  /** 马赛克：line=沿笔刷线条打码，fill=矩形框选打码 */
  mosaicMode: "line" | "fill";
  mosaicStyle: "pixel" | "blur";
  mosaicLevel: number;
  /** 线条模式的笔刷直径（CSS px）。刻意不复用 width：线宽上限 16，
   *  打码笔刷要粗得多，共用一个字段会让两处 clamp 互相打架。 */
  mosaicBrush: number;
  stepNo: number;
  stepRadius: number;
  /** 橡皮擦命中半径（CSS px，物理化在 controller 里乘 scale） */
  eraserRadius: number;
}

/** 字体下拉的候选（webview 里无法枚举系统字体，给一组 Windows 常见 + 兜底） */
export const FONT_FAMILIES = [
  "Microsoft YaHei UI",
  "Microsoft YaHei",
  "SimSun",
  "SimHei",
  "KaiTi",
  "Segoe UI",
  "Arial",
  "Consolas",
];

/** 字号下拉的候选（CSS px，物理像素在 controller 里乘 scale） */
export const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64];

export const DEFAULT_PROPS: DrawProps = {
  // 参照图当前色块实测值，落在 PALETTE 里（默认不显示"自选色"角标）
  color: "#ed1c24",
  width: 3,
  filled: false,
  fontPx: 18,
  textBg: false,
  textBold: false,
  textItalic: false,
  textStrike: false,
  textFamily: "Microsoft YaHei UI",
  arrowDouble: false,
  arrowHead: "solid",
  markerRect: false,
  eraserRect: false,
  mosaicMode: "fill",
  mosaicStyle: "pixel",
  mosaicLevel: 8,
  mosaicBrush: 24,
  stepNo: 1,
  stepRadius: 14,
  eraserRadius: 16,
};

/** Snipaste 预设色板，实测取自 docs/capshot-图/框选.png 的 2 行 × 10 列（PIL 逐格取样）。
 *  顺序是**行优先**（上排 10 色、下排 10 色），与 .snip-swatches 的 row-major grid 对应。 */
export const PALETTE = [
  "#000000",
  "#7f7f7f",
  "#880015",
  "#ed1c24",
  "#ff7f27",
  "#fff200",
  "#22b14c",
  "#00a2e8",
  "#3f48cc",
  "#a349a4",
  "#ffffff",
  "#c3c3c3",
  "#b97a57",
  "#ffaec9",
  "#ffc90e",
  "#efe4b0",
  "#b5e61d",
  "#99d9ea",
  "#7092be",
  "#c8bfe7",
];

export function shapeBounds(s: Shape): Rect {
  switch (s.kind) {
    case "mosaic":
      // 线条模式：包围盒由 pts 推得（外扩半个笔刷）；填充模式：直接用 r
      if (s.pts && s.pts.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of s.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        const pad = (s.brush ?? 0) / 2;
        return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
      }
      return s.r;
    case "rect":
    case "ellipse":
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
    case "erase":
      if (s.mode === "rect" && s.r) return s.r;
      if (s.pts && s.pts.length) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of s.pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

/** 图形句柄：k 是身份（"a"/"b"/"first"/"last"，或选区那套 "nw"…"w"），x/y 为物理 px */
export interface ShapeHandle {
  k: string;
  x: number;
  y: number;
}

/** 画完之后能不能当场调形状（Snipaste：只有刚画完那一支给句柄，点别处即锁死） */
export function canEditShape(s: Shape): boolean {
  switch (s.kind) {
    case "arrow":
    case "polyline":
    case "marker":
      return true;
    // 矩形/椭圆 = 四角 + 四边中点共 8 向句柄；记号笔的矩形高亮框不算
    case "rect":
    case "ellipse":
      return !s.marker;
    default:
      return false;
  }
}

/**
 * 句柄位置。箭头 = 两端；画笔 / 记号笔 = 路径**首末点**（中间点不动 ——
 * 拉自由笔迹的中间点等于把笔迹重采样，那是重画不是调整）；
 * 矩形/椭圆 = 8 向，直接复用选区的 `handlePoints`，两处手柄几何保证一致。
 */
export function shapeHandles(s: Shape): ShapeHandle[] {
  switch (s.kind) {
    case "arrow":
      return [
        { k: "a", x: s.a.x, y: s.a.y },
        { k: "b", x: s.b.x, y: s.b.y },
      ];
    case "polyline":
    case "marker":
      if (s.pts.length < 2) return [];
      return [
        { k: "first", x: s.pts[0].x, y: s.pts[0].y },
        { k: "last", x: s.pts[s.pts.length - 1].x, y: s.pts[s.pts.length - 1].y },
      ];
    case "rect":
    case "ellipse":
      return s.marker ? [] : handlePoints(s.r).map((h) => ({ k: h.k, x: h.x, y: h.y }));
    default:
      return [];
  }
}

/**
 * 端点句柄的"可拉方向"：指向它的相邻点。用于挑一个方向缩放光标
 * （录屏实测箭头端点悬停是方向箭头，不是抓手）。8 向句柄返回 null —— 它们本身就是方向。
 */
export function shapeHandleDir(s: Shape, k: string): Point | null {
  if (s.kind === "arrow") {
    const [me, other] = k === "a" ? [s.a, s.b] : k === "b" ? [s.b, s.a] : [null, null];
    return me && other ? { x: other.x - me.x, y: other.y - me.y } : null;
  }
  if (s.kind === "polyline" || s.kind === "marker") {
    const n = s.pts.length;
    if (n < 2) return null;
    if (k === "first") return { x: s.pts[1].x - s.pts[0].x, y: s.pts[1].y - s.pts[0].y };
    if (k === "last")
      return { x: s.pts[n - 1].x - s.pts[n - 2].x, y: s.pts[n - 1].y - s.pts[n - 2].y };
  }
  return null;
}

/**
 * 拖某个句柄。点类（箭头端点、笔迹首末）直接把点落过去；矩形/椭圆走 `resizeRect` ——
 * 与选区缩放**同一份实现**，且从按下时的原矩形重算（不累加增量），
 * 免得一路拖下去越拖越漂。
 */
export function applyShapeHandle(s: Shape, k: string, p: Point, origin: Shape, start: Point): void {
  const np = { x: p.x, y: p.y };
  if (s.kind === "arrow") {
    if (k === "a") s.a = np;
    else if (k === "b") s.b = np;
  } else if (s.kind === "polyline" || s.kind === "marker") {
    if (k === "first") s.pts[0] = np;
    else if (k === "last") s.pts[s.pts.length - 1] = np;
  } else if ((s.kind === "rect" || s.kind === "ellipse") && origin.kind === s.kind) {
    s.r = resizeRect(origin.r, k as Handle, p.x - start.x, p.y - start.y);
  }
}

export function translate(s: Shape, dx: number, dy: number): void {
  const move = (p: Point) => {
    p.x += dx;
    p.y += dy;
  };
  switch (s.kind) {
    case "mosaic":
      s.r.x += dx;
      s.r.y += dy;
      s.pts?.forEach(move);
      break;
    case "rect":
    case "ellipse":
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
    case "erase":
      if (s.mode === "rect" && s.r) { s.r.x += dx; s.r.y += dy; }
      s.pts?.forEach(move);
      break;
  }
}
