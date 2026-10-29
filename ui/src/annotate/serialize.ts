//! annotationJson（v2 = 当前 Shape 判别联合）的写出侧。
//! 读回侧（parse + v1 迁移）随「重新编辑」功能一并移除：历史库里的 annotation_json
//! 仍在写（export_result → history.insert），只是暂时没有消费者。

import type { DrawProps, Shape } from "./model";

export interface AnnotationV2 {
  v: 2;
  shapes: Shape[];
}

export function serialize(shapes: Shape[]): string {
  return JSON.stringify({ v: 2, shapes } satisfies AnnotationV2);
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
      return { color: s.color, width: s.width, arrowDouble: s.double ?? false, arrowHead: s.head ?? "solid" };
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
