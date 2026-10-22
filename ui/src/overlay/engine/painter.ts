//! 画布合成。命令式，每帧一次；React 不参与这里的绘制。

import { drawShapes, type RenderDeps } from "../../annotate/render";
import { shapeBounds, type Shape, type ShapeHandle } from "../../annotate/model";
import { handlePoints, type Handle, type Phase, type Rect } from "./types";

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
  /** 「刚画完那一支」的句柄（箭头两端 / 笔迹首末点 / 矩形·椭圆 8 向）；空数组 = 无可编辑图形 */
  editHandles: ShapeHandle[];
  /** 光标压着哪个句柄的 key；null 无 */
  hotEdit: string | null;
  accent: string;
  maskAlpha: number;
  handleSize: number;
  /** 自绘笔刷圈（物理 px，跟随光标；r=半径），null = 用系统光标 */
  brushCursor: { x: number; y: number; r: number } | null;
  /** 自绘细十字（arm=半长，物理 px）。系统 crosshair 太粗太大时用它，null = 不画 */
  cross: { x: number; y: number; arm: number } | null;
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

  /* 图形句柄不看 showHandles：刚画完那支时工具仍是开着的，这正是唯一能拖句柄的窗口。
     录屏实测：图形句柄是**白底深边的空心小方块**，而选区手柄是**蓝色实心圆点** ——
     Snipaste 刻意用两种形状区分"调图形"和"调选区"，所以这里不复用上面的 dot()。 */
  if (i.editHandles.length) {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "rgba(40,40,40,0.9)";
    ctx.lineWidth = Math.max(1, hs / 9);
    for (const h of i.editHandles) {
      const sz = i.hotEdit === h.k ? hs * 0.95 : hs * 0.75;
      ctx.fillRect(h.x - sz / 2, h.y - sz / 2, sz, sz);
      ctx.strokeRect(h.x - sz / 2, h.y - sz / 2, sz, sz);
    }
  }

  /* 自绘工具圈（此时系统光标被 controller 置成 none，见 brushRadius）：
     橡皮圆头 / 马赛克线条（环径=笔刷尺寸）+ 记号笔（固定 ~15px）。
     录屏实测 Snipaste 的环：半透明白填充（环内比环外亮）+ 深色描边，**圈内没有十字** ——
     原先那个"中心十字瞄准点"是我们自己加的，已去掉。
     白色下描边保留：实测底是粉色看不出深色环在深底上够不够，多一道白边稳一点。 */
  if (i.brushCursor) {
    const { x, y, r } = i.brushCursor;
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
  }

  /* 自绘细十字（取代系统 crosshair：那枚约 19px、2px 黑线，太粗太大）。
     录屏实测 Snipaste 是 15px / 1px —— 1px 黑线 + 白晕影，中心正落在指针热点上。
     坐标 +0.5 让 1px 线压在像素中心，否则会被抗锯齿糊成 2px 灰线。 */
  if (i.cross) {
    const { x, y, arm } = i.cross;
    const px = Math.round(x) + 0.5;
    const py = Math.round(y) + 0.5;
    ctx.save();
    ctx.lineCap = "butt";
    for (const [col, w] of [
      ["rgba(255,255,255,0.8)", 3],
      ["#000", 1],
    ] as const) {
      ctx.strokeStyle = col;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(px - arm, py);
      ctx.lineTo(px + arm, py);
      ctx.moveTo(px, py - arm);
      ctx.lineTo(px, py + arm);
      ctx.stroke();
    }
    ctx.restore();
  }
}
