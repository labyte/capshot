//! 画布合成。命令式，每帧一次；React 不参与这里的绘制。

import { drawShapes, type RenderDeps } from "../../annotate/render";
import { shapeBounds, type Shape } from "../../annotate/model";
import { handlePoints, type Phase, type Rect } from "./types";

export interface PaintInput {
  frame: ImageBitmap;
  phase: Phase;
  hover: Rect | null;
  sel: Rect | null;
  shapes: Shape[];
  deps: RenderDeps;
  /** 已定选区且工具条可见时才画 8 向手柄 */
  showHandles: boolean;
  selectedId: number | null;
  accent: string;
  maskAlpha: number;
  handleSize: number;
}

export function paint(
  ctx: CanvasRenderingContext2D,
  out: { w: number; h: number },
  i: PaintInput,
): void {
  ctx.clearRect(0, 0, out.w, out.h);
  ctx.drawImage(i.frame, 0, 0);

  if (i.phase === "picking" && i.hover) {
    ctx.strokeStyle = i.accent;
    ctx.lineWidth = Math.max(2, i.handleSize / 3);
    const r = i.hover;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    return;
  }

  if (!i.sel) return;
  const { x, y, w, h } = i.sel;

  // 选区外压暗：上/下/左/右四条边带，避免四角矩形重叠导致 alpha 叠深
  ctx.fillStyle = `rgba(0,0,0,${i.maskAlpha})`;
  ctx.fillRect(0, 0, out.w, y);
  ctx.fillRect(0, y + h, out.w, out.h - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, out.w - x - w, h);

  drawShapes(ctx, i.shapes, i.sel, i.deps);

  ctx.strokeStyle = i.accent;
  ctx.lineWidth = Math.max(1, i.handleSize / 6);
  ctx.strokeRect(x, y, w, h);

  if (i.selectedId !== null) {
    const s = i.shapes.find((sh) => sh.id === i.selectedId);
    if (s) {
      const b = shapeBounds(s);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = Math.max(1, i.handleSize / 8);
      ctx.strokeStyle = i.accent;
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.restore();
    }
  }

  if (i.showHandles) {
    const hs = i.handleSize;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = i.accent;
    ctx.lineWidth = Math.max(1, hs / 6);
    for (const p of handlePoints(i.sel)) {
      ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
      ctx.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
    }
  }
}
