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
  /**
   * 自绘工具光标（物理 px，跟随光标），null = 用系统光标。
   * ring = 笔刷圈（橡皮圆头 / 马赛克线条 / 记号笔）；
   * dotTicks = 圆点 + 四向短线（箭头），点用**当前标注色**、直径随线宽变。
   */
  toolCursor: { x: number; y: number; r: number; kind: "ring" | "dashDot"; color?: string } | null;
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

  /* 标注**不被选区裁剪**：在选区外（暗区）落的笔也画得出来，
     与"随时可调选区"配套 —— 把选区放大就能露出先前画在外面的部分。
     导出仍只取选区那块（renderFinalPng 的画布尺寸就是 sel.w×sel.h，天然裁掉）。
     顺序要紧：**先画标注，再压暗罩** —— 这样选区外的笔和底图一起被压暗（"在暗区里"的观感），
     选区内的笔保持原色。反过来（暗罩在先）会让暗区的笔浮在暗罩上，亮得突兀。 */
  drawShapes(ctx, i.shapes, null, i.deps);

  // 选区外压暗：上/下/左/右四条边带，避免四角矩形重叠导致 alpha 叠深
  ctx.fillStyle = `rgba(0,0,0,${i.maskAlpha})`;
  ctx.fillRect(0, 0, out.w, y);
  ctx.fillRect(0, y + h, out.w, out.h - y - h);
  ctx.fillRect(0, y, x, h);
  ctx.fillRect(x + w, y, out.w - x - w, h);

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

  // 场景层到此为止。光标层另起一个函数，由调用方在 paint() 之后画 ——
  // paint() 在 picking（取色）与"还没有选区"两种情况下要提前 return，
  // 光标若画在它后面就会被整层跳过：此时系统光标已被置成 none，指针就彻底消失了。
}

/**
 * 超大笔刷的尺寸预览圈（橡皮 4–80 / 马赛克 8–80 超过光标图 32px 上限时才用到）。
 * 其余光标（细十字、箭头/画笔圆点短线、记号笔实心圆）都是**真正的 CSS 光标图**
 * （见 cursorImage.ts），不在画布上画 —— 画布画光标那个方案已经被否掉：
 * WebView2 从具名光标切回 `cursor: none` 不生效，会留下双光标。
 */
export function paintCursor(ctx: CanvasRenderingContext2D, i: PaintInput): void {
  if (!i.toolCursor) return;
  const { x, y, r, kind, color } = i.toolCursor;
  if (kind === "dashDot") {
    /* 马赛克：实心 + 虚线边（用户指定）。打码不涉及颜色 → 中性灰实心 + 白晕深虚线双描边。 */
    const rr = Math.max(4, r);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, rr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(128,128,128,0.35)";
    ctx.fill();
    ctx.setLineDash([Math.max(2, rr * 0.35), Math.max(2, rr * 0.3)]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (kind === "ring" && color) {
    /* 记号笔超大笔刷（线宽 16 → 半径 32 CSS px，超过光标图上限）：
       用当前色画半透明实心圆 + 实边，与它涂出来的高亮同观感。 */
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  /* 橡皮圆头：录屏实测 Snipaste 的环是半透明白填充（环内比环外亮）+ 深色描边，
     圈内没有十字（中心定位交给光标的细十字）。 */
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
