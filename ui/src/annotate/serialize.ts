//! annotationJson 的双向转换。
//! v2 = 当前 Shape 判别联合；v1 = 迁移前 overlay 写的扁平结构（字段名不同、只有四类图形）。
//! 历史库里已经有 v1 数据，重编辑器必须两种都读得回来，否则老截图一改就空。

import type { DrawProps, Shape, ShapeKind } from "./model";

let hydrateId = 1;

interface V1Shape {
  kind: string;
  x: number;
  y: number;
  w2?: number;
  h2?: number;
  x2?: number;
  y2?: number;
  color?: string;
  w?: number;
  text?: string;
  fontPx?: number;
}

export interface AnnotationV2 {
  v: 2;
  shapes: Shape[];
}

export function serialize(shapes: Shape[]): string {
  return JSON.stringify({ v: 2, shapes } satisfies AnnotationV2);
}

/**
 * 读回图形。坐标语义：v1/v2 都是「相对选区左上角」，
 * 而重编辑场景里整幅图就是选区，所以可以直接当绝对坐标用。
 */
export function parse(json: string | null | undefined): Shape[] {
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    console.warn("annotationJson 解析失败，按无标注处理");
    return [];
  }
  const obj = raw as { v?: number; shapes?: unknown[] };
  if (!Array.isArray(obj.shapes)) return [];
  return obj.v === 2 ? (obj.shapes as Shape[]) : obj.shapes.map(fromV1).filter(isShape);
}

function isShape(s: Shape | null): s is Shape {
  return s !== null;
}

const KIND_MAP: Record<string, ShapeKind> = {
  rect: "rect",
  arrow: "arrow",
  text: "text",
  mosaic: "mosaic",
};

function fromV1(input: unknown): Shape | null {
  const s = input as V1Shape;
  const kind = KIND_MAP[s.kind];
  const id = hydrateId++;
  const color = s.color ?? "#ff3b30";
  const width = s.w ?? 3;
  if (!kind) return null;
  switch (kind) {
    case "rect":
      return { id, kind: "rect", r: { x: s.x, y: s.y, w: s.w2 ?? 0, h: s.h2 ?? 0 }, color, width, filled: false };
    case "mosaic":
      return {
        id,
        kind: "mosaic",
        r: { x: s.x, y: s.y, w: s.w2 ?? 0, h: s.h2 ?? 0 },
        color,
        width,
        style: "pixel",
        level: 8,
      };
    case "arrow":
      return {
        id,
        kind: "arrow",
        a: { x: s.x, y: s.y },
        b: { x: s.x2 ?? s.x, y: s.y2 ?? s.y },
        color,
        width,
      };
    case "text":
      // v1 的 text 永远带黑底（旧代码硬编码），还原时保留这个观感
      return {
        id,
        kind: "text",
        at: { x: s.x, y: s.y },
        text: s.text ?? "",
        color,
        width,
        fontPx: s.fontPx ?? 16,
        bg: true,
      };
    default:
      return null;
  }
}

/** 属性栏当前选择 → 新图形的默认值（供 beginShape 用） */
export function propsOf(s: Shape): Partial<DrawProps> {
  switch (s.kind) {
    case "rect":
    case "ellipse":
      return { color: s.color, width: s.width, filled: s.filled };
    case "mosaic":
      return { mosaicStyle: s.style, mosaicLevel: s.level };
    case "arrow":
      return { color: s.color, width: s.width, arrowDouble: s.double ?? false };
    case "text":
      return {
        color: s.color,
        fontPx: s.fontPx,
        textBg: s.bg,
        textBold: s.bold ?? false,
        textItalic: s.italic ?? false,
        textStrike: s.strike ?? false,
        textFamily: s.family ?? "Microsoft YaHei UI",
      };
    default:
      return { color: s.color, width: s.width };
  }
}
