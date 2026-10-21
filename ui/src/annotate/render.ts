//! 图形绘制。clip = 选区（标注只在选区内可见并参与导出），与迁移前 drawShapes 的裁剪语义一致。

import { drawBlocked, drawBlurred } from "./mosaic";
import type { ArrowHead, Shape } from "./model";
import type { Rect } from "../overlay/engine/types";

export interface RenderDeps {
  /** 冻结帧源图，马赛克/模糊从这里取样 */
  source: CanvasImageSource;
  scale: number;
  scratch: HTMLCanvasElement;
}

const FONT_STACK = '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

export function drawShape(c: CanvasRenderingContext2D, s: Shape, deps: RenderDeps): void {
  switch (s.kind) {
    case "rect": {
      c.strokeStyle = c.fillStyle = s.color;
      c.lineWidth = s.width;
      if (s.filled) c.fillRect(s.r.x, s.r.y, s.r.w, s.r.h);
      else c.strokeRect(s.r.x, s.r.y, s.r.w, s.r.h);
      break;
    }
    case "ellipse": {
      c.beginPath();
      c.ellipse(
        s.r.x + s.r.w / 2,
        s.r.y + s.r.h / 2,
        Math.max(0.5, s.r.w / 2),
        Math.max(0.5, s.r.h / 2),
        0,
        0,
        Math.PI * 2,
      );
      c.strokeStyle = c.fillStyle = s.color;
      c.lineWidth = s.width;
      if (s.filled) c.fill();
      else c.stroke();
      break;
    }
    case "arrow": {
      drawArrow(c, s.a.x, s.a.y, s.b.x, s.b.y, s.color, s.width, deps.scale, s.double ?? false, s.head ?? "solid");
      break;
    }
    case "polyline":
    case "marker": {
      if (s.pts.length < 2) break;
      c.save();
      c.strokeStyle = s.color;
      c.lineCap = c.lineJoin = "round";
      if (s.kind === "marker") {
        c.globalAlpha = 0.38;
        c.lineWidth = s.width * 4;
      } else {
        c.lineWidth = s.width;
      }
      c.beginPath();
      c.moveTo(s.pts[0].x, s.pts[0].y);
      for (let i = 1; i < s.pts.length; i++) c.lineTo(s.pts[i].x, s.pts[i].y);
      c.stroke();
      c.restore();
      break;
    }
    case "text": {
      c.save();
      const style = `${s.bold ? "bold " : ""}${s.italic ? "italic " : ""}${Math.round(s.fontPx)}px ${
        s.family ? `"${s.family}", ` : ""
      }${FONT_STACK}`;
      c.font = style;
      c.textBaseline = "top";
      const m = c.measureText(s.text);
      if (s.bg) {
        c.fillStyle = "rgba(0,0,0,.45)";
        c.fillRect(s.at.x - 2, s.at.y - 2, m.width + 4, s.fontPx + 4);
      }
      c.fillStyle = s.color;
      c.fillText(s.text, s.at.x, s.at.y);
      if (s.strike) {
        // canvas 没有原生删除线：按字体度量手动画一道（基线 top，字面中部约 0.62em）
        c.fillRect(s.at.x, s.at.y + s.fontPx * 0.62, m.width, Math.max(1, s.fontPx * 0.07));
      }
      c.restore();
      break;
    }
    case "mosaic": {
      if (s.r.w < 1 || s.r.h < 1) break;
      if (s.style === "blur") drawBlurred(c, deps.source, s.r, s.level);
      else drawBlocked(c, deps.source, s.r, s.level, deps.scratch);
      break;
    }
    case "step": {
      c.save();
      c.fillStyle = s.color;
      c.beginPath();
      c.arc(s.at.x, s.at.y, s.radius, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = "rgba(255,255,255,.9)";
      c.lineWidth = Math.max(1, s.radius * 0.12);
      c.stroke();
      c.fillStyle = "#fff";
      c.font = `bold ${Math.round(s.radius * 1.15)}px ${FONT_STACK}`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(s.n), s.at.x, s.at.y + s.radius * 0.05);
      c.restore();
      break;
    }
  }
}

export function drawArrow(
  c: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width: number,
  scale: number,
  double = false,
  headStyle: ArrowHead = "solid",
): void {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10 * scale, width * 3);
  const tip = (tx: number, ty: number, a: number) => {
    if (headStyle === "none") return;
    const lx = tx - head * Math.cos(a - 0.5),
      ly = ty - head * Math.sin(a - 0.5);
    const rx = tx - head * Math.cos(a + 0.5),
      ry = ty - head * Math.sin(a + 0.5);
    if (headStyle === "hollow") {
      // 空心：只描两条边，靠 lineJoin 出尖角
      c.beginPath();
      c.moveTo(lx, ly);
      c.lineTo(tx, ty);
      c.lineTo(rx, ry);
      c.stroke();
      return;
    }
    c.beginPath();
    c.moveTo(tx, ty);
    c.lineTo(lx, ly);
    c.lineTo(rx, ry);
    c.closePath();
    c.fill();
  };
  c.strokeStyle = c.fillStyle = color;
  c.lineWidth = width;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.beginPath();
  c.moveTo(x1, y1);
  c.lineTo(x2, y2);
  c.stroke();
  tip(x2, y2, ang);
  // ↔：起点补一个反向箭头
  if (double) tip(x1, y1, ang + Math.PI);
}

export function drawShapes(
  c: CanvasRenderingContext2D,
  shapes: Shape[],
  clip: Rect | null,
  deps: RenderDeps,
): void {
  for (const s of shapes) {
    c.save();
    if (clip) {
      c.beginPath();
      c.rect(clip.x, clip.y, clip.w, clip.h);
      c.clip();
    }
    drawShape(c, s, deps);
    c.restore();
  }
}
