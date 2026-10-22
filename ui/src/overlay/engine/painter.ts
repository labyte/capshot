//! 画布合成。命令式，每帧一次；React 不参与这里的绘制。

import { drawShapes, type RenderDeps } from "../../annotate/render";
import { shapeBounds, type Shape } from "../../annotate/model";
import { handlePoints, type Handle, type Phase, type Point, type Rect } from "./types";

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
  /** 光标下的已画图形（未点选）：画一层更淡的虚线 bbox 当悬停反馈；null 不画 */
  hoverId: number | null;
  /** 光标正压着的手柄：那一格放大一点，作为"可以朝这个方向拉"的反馈；null 无 */
  hotHandle: Handle | null;
  /** 「刚画完那一支」的端点句柄（箭头两端 / 笔迹首末点）；空数组 = 无可编辑图形 */
  editPoints: Point[];
  /** 光标压着第几个端点；-1 无 */
  hotEdit: number;
  accent: string;
  maskAlpha: number;
  handleSize: number;
  /** 笔刷圈（物理 px，跟随光标）：橡皮与马赛克线条模式共用；null 不画 */
  brushRing: { x: number; y: number; r: number } | null;
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

  /* 图形的虚线包围盒：选中态实色，悬停态压淡一档并细一点。
     两者同一套画法 —— 悬停只是"还没点下去的选中"，不该另发明一种视觉语言。 */
  const shapeBox = (id: number | null, faint: boolean) => {
    if (id === null) return;
    const s = i.shapes.find((sh) => sh.id === id);
    if (!s) return;
    const b = shapeBounds(s);
    ctx.save();
    if (faint) ctx.globalAlpha = 0.55;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = Math.max(1, i.handleSize / (faint ? 10 : 8));
    ctx.strokeStyle = i.accent;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.restore();
  };
  shapeBox(i.hoverId === i.selectedId ? null : i.hoverId, true);
  shapeBox(i.selectedId, false);

  /* 可拖的东西一律画成**圆点**：参照图实测选区手柄是 Ø≈9px 的白底蓝环圆，
     不是方块。选区八向手柄与图形端点共用这一个画法，
     免得出现"两种手柄长得不一样"。 */
  const hs = i.handleSize;
  const dot = (x: number, y: number, d: number) => {
    ctx.beginPath();
    ctx.arc(x, y, d / 2, 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = i.accent;
    ctx.lineWidth = Math.max(1, hs / 6);
    ctx.stroke();
  };

  if (i.showHandles) {
    for (const p of handlePoints(i.sel)) {
      // 光标压着的那一颗放大 25%，配合 *-resize 光标说明"就从这儿拉"
      dot(p.x, p.y, i.hotHandle === p.k ? hs * 1.25 : hs);
    }
  }

  // 端点句柄不看 showHandles：刚画完那支的持有工具仍是开着的，
  // 这时候正是唯一能拖端点的窗口
  i.editPoints.forEach((p, k) => dot(p.x, p.y, i.hotEdit === k ? hs * 1.25 : hs));

  // 笔刷圈（橡皮 / 马赛克线条模式）：白底 + 深色描边，任何背景都看得见。
  // 此时系统光标被隐藏（controller.updateCursor），所以必须补一个中心十字，
  // 否则只剩一个圈，小圈时看不出笔刷究竟落在哪个像素上。
  if (i.brushRing) {
    const { x, y, r } = i.brushRing;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r / 12);
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.stroke();

    const arm = Math.max(3, r * 0.35);
    for (const [dark, w] of [
      ["rgba(0,0,0,0.55)", 3],
      ["#fff", 1],
    ] as const) {
      ctx.strokeStyle = dark;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x - arm, y);
      ctx.lineTo(x + arm, y);
      ctx.moveTo(x, y - arm);
      ctx.lineTo(x, y + arm);
      ctx.stroke();
    }
  }
}
