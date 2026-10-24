//! 图形绘制。clip = 选区（标注只在选区内可见并参与导出），与迁移前 drawShapes 的裁剪语义一致。

import { drawBlocked, drawBlurred } from "./mosaic";
import { shapeBounds } from "./model";
import type { ArrowHead, EraseShape, Shape } from "./model";
import { textFontCss, textFontFamily } from "./textMetrics";
import type { Rect } from "../overlay/engine/types";

export interface RenderDeps {
  /** 冻结帧源图，马赛克/模糊从这里取样 */
  source: CanvasImageSource;
  scale: number;
  scratch: HTMLCanvasElement;
}

// 字体串与量宽统一在 textMetrics.ts（绘制 / 输入框 / 命中框三方共用同一口径），此处只 import。

export function drawShape(c: CanvasRenderingContext2D, s: Shape, deps: RenderDeps): void {
  switch (s.kind) {
    case "rect": {
      // 记号笔矩形：半透明高亮框，无描边
      if (s.marker) {
        c.save();
        c.globalAlpha = 0.35;
        c.fillStyle = s.color;
        c.fillRect(s.r.x, s.r.y, s.r.w, s.r.h);
        c.restore();
        break;
      }
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
      if (s.kind === "marker") {
        // 记号笔：直角 —— 平头端点 + 斜切转角，不再圆头圆角。
        // 转角用 bevel 不用 miter：记号笔线宽是 width×4，自由笔迹的回折角很急，
        // miter 会在外角拉出长尖刺（实测 width 12/16 时炸得很明显），bevel 是平切一角
        c.lineCap = "butt";
        c.lineJoin = "bevel";
        c.globalAlpha = 0.38;
        c.lineWidth = s.width * 4;
      } else {
        // 画笔仍要圆头：它画的是签字笔式细线，平头会在转折处露出缺口
        c.lineCap = c.lineJoin = "round";
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
      c.font = textFontCss(s.fontPx, s);
      c.textBaseline = "top";
      const m = c.measureText(s.text);
      if (s.rot) {
        /* 绕盒中心旋转：中心口径与 shapeBounds / hitShape 三方共用
           （w 含 bg 外扩、h = 1.25×字号），输入框旋转手柄的角度直接落在这里 */
        const w = m.width + (s.bg ? 4 : 0);
        const h = s.fontPx * 1.25;
        const cx = s.at.x + w / 2;
        const cy = s.at.y + h / 2;
        c.translate(cx, cy);
        c.rotate(s.rot);
        c.translate(-cx, -cy);
      }
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
      // 线条模式：先在离屏缓冲里把包围盒区域像素化/模糊，再 destination-in 笔刷路径，
      // 只保留沿轨迹刷过的马赛克，最后贴回目标层
      if (s.pts && s.pts.length) {
        const b = shapeBounds(s);
        if (b.w < 1 || b.h < 1) break;
        const bw = Math.ceil(b.w);
        const bh = Math.ceil(b.h);
        const buf = mosaicBuf(bw, bh);
        const bc = buf.getContext("2d")!;
        bc.clearRect(0, 0, bw, bh);
        bc.save();
        bc.translate(-b.x, -b.y);
        if (s.style === "blur") drawBlurred(bc, deps.source, b, s.level);
        else drawBlocked(bc, deps.source, b, s.level, deps.scratch);
        bc.restore();
        bc.save();
        bc.globalCompositeOperation = "destination-in";
        bc.strokeStyle = bc.fillStyle = "#000";
        bc.lineCap = "round";
        bc.lineJoin = "round";
        const brush = Math.max(1, s.brush ?? 8);
        bc.lineWidth = brush;
        const p0 = s.pts[0];
        if (s.pts.length === 1) {
          bc.beginPath();
          bc.arc(p0.x - b.x, p0.y - b.y, brush / 2, 0, Math.PI * 2);
          bc.fill();
        } else {
          bc.beginPath();
          bc.moveTo(p0.x - b.x, p0.y - b.y);
          for (let i = 1; i < s.pts.length; i++) bc.lineTo(s.pts[i].x - b.x, s.pts[i].y - b.y);
          bc.stroke();
        }
        bc.restore();
        c.drawImage(buf, b.x, b.y);
        break;
      }
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
      c.font = `bold ${Math.round(s.radius * 1.15)}px ${textFontFamily()}`;
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
  const len = Math.hypot(x2 - x1, y2 - y1);
  /* 楔形渐尖（参照图）：整支箭是一个填充多边形——尾端收成一个点、杆向头部线性
     渐宽、头部是比杆宽得多的实心三角。不画描边杆，lineWidth 只决定杆在头底的厚度。
     双端组合不产自属性栏（下拉四选一），此分支按单端画。 */
  if (headStyle === "tapered") {
    if (len < 1) return;
    const shaftHalf = Math.max(0.8, width * 0.4);
    // 头宽 = 杆头宽的 3 倍（地板 3.5 CSS px）；头长 = 头半宽 / 0.45（半角约 24°），
    // 短箭上头长夹到全长一半并按同比例收回头宽，避免头比箭还长
    let headHalf = Math.max(3.5 * scale, shaftHalf * 3);
    let hl = headHalf / 0.45;
    if (hl > len * 0.5) {
      hl = len * 0.5;
      headHalf = hl * 0.45;
    }
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    // 局部坐标：原点在箭尖、-x 朝尾；旋转平移到世界坐标
    const P = (lx: number, ly: number): [number, number] => [
      x2 + lx * cos - ly * sin,
      y2 + lx * sin + ly * cos,
    ];
    const pts: [number, number][] = [
      P(0, 0), // 箭尖
      P(-hl, -headHalf), // 头底外上
      P(-hl, -shaftHalf), // 头底内上（杆上缘起点）
      P(-len, 0), // 尾尖
      P(-hl, shaftHalf), // 头底内下
      P(-hl, headHalf), // 头底外下
    ];
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.closePath();
    c.fillStyle = color;
    c.fill();
    return;
  }
  // 头部随线宽长，但夹角别太窄：线宽大时太窄的镖形会被粗杆吃掉，看不出是箭头
  const head = Math.max(9 * scale, width * 3);
  const half = 0.42;
  /**
   * **杆必须缩进箭头底面以内**，否则线宽一大，端帽会顶过箭尖，
   * 肉眼看就是"箭头没长在末端"。缩多少看端帽形状：
   * 平头（butt）正好缩到头部底面；空心头仍走圆头描边，要多让半个线宽。
   */
  const capAllowance = headStyle === "hollow" ? width * 0.5 : 0;
  const back = Math.min(head * Math.cos(half) + capAllowance, len * 0.45);
  const ux = Math.cos(ang),
    uy = Math.sin(ang);
  const tip = (tx: number, ty: number, a: number) => {
    if (headStyle === "none") return;
    const lx = tx - head * Math.cos(a - half),
      ly = ty - head * Math.sin(a - half);
    const rx = tx - head * Math.cos(a + half),
      ry = ty - head * Math.sin(a + half);
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
  // 箭头一律直角：平头尾端 + 斜接头，不再圆头圆角（空心 V 是历史数据，仍走圆头出尖）
  c.lineCap = headStyle === "hollow" ? "round" : "butt";
  c.lineJoin = headStyle === "hollow" ? "round" : "miter";
  // 有头的那一端把杆缩 back；无头（— 样式）时端点就是端点，不缩
  const tailBack = double ? back : 0;
  const tipBack = headStyle === "none" ? 0 : back;
  c.beginPath();
  c.moveTo(x1 + ux * tailBack, y1 + uy * tailBack);
  c.lineTo(x2 - ux * tipBack, y2 - uy * tipBack);
  c.stroke();
  tip(x2, y2, ang);
  // ↔：起点补一个反向箭头
  if (double) tip(x1, y1, ang + Math.PI);
}

function applyClip(c: CanvasRenderingContext2D, clip: Rect | null): void {
  if (clip) {
    c.beginPath();
    c.rect(clip.x, clip.y, clip.w, clip.h);
    c.clip();
  }
}

/** 橡皮擦：destination-out 下只认 alpha，画纯黑笔刷/框即可在标注层打洞。
    path=圆头折线（width=笔刷直径），rect=实心框 */
function drawErase(c: CanvasRenderingContext2D, e: EraseShape): void {
  c.fillStyle = c.strokeStyle = "#000";
  if (e.mode === "rect" && e.r) {
    c.fillRect(e.r.x, e.r.y, e.r.w, e.r.h);
    return;
  }
  const pts = e.pts ?? [];
  if (!pts.length) return;
  const w = e.width || 1;
  if (pts.length === 1) {
    c.beginPath();
    c.arc(pts[0].x, pts[0].y, w / 2, 0, Math.PI * 2);
    c.fill();
    return;
  }
  c.lineCap = "round";
  c.lineJoin = "round";
  c.lineWidth = w;
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
  c.stroke();
}

// 线条马赛克的临时缓冲（包围盒大小）：像素化整块 → destination-in 笔刷路径
let _mbuf: HTMLCanvasElement | null = null;
function mosaicBuf(w: number, h: number): HTMLCanvasElement {
  if (!_mbuf) _mbuf = document.createElement("canvas");
  if (_mbuf.width !== w || _mbuf.height !== h) {
    _mbuf.width = w;
    _mbuf.height = h;
  }
  return _mbuf;
}

// 标注离屏层：仅当存在橡皮擦时启用（擦除要在标注像素上打洞，不能洞穿底图）
let _layer: HTMLCanvasElement | null = null;
function layerFor(w: number, h: number): CanvasRenderingContext2D {
  if (!_layer) _layer = document.createElement("canvas");
  if (_layer.width !== w || _layer.height !== h) {
    _layer.width = w;
    _layer.height = h;
  }
  const lc = _layer.getContext("2d")!;
  lc.clearRect(0, 0, w, h);
  return lc;
}

export function drawShapes(
  c: CanvasRenderingContext2D,
  shapes: Shape[],
  clip: Rect | null,
  deps: RenderDeps,
): void {
  const erases = shapes.filter((s) => s.kind === "erase");
  if (!erases.length) {
    for (const s of shapes) {
      c.save();
      applyClip(c, clip);
      drawShape(c, s, deps);
      c.restore();
    }
    return;
  }
  // 有橡皮擦：离屏层上**按绘制顺序**单遍合成——遇到 erase 就 destination-out 打洞，
  // 只擦掉它之前画的标注；之后新画的图形叠在洞上，擦过的区域因此可以再次绘制。
  const { width, height } = c.canvas;
  const lc = layerFor(width, height);
  for (const s of shapes) {
    lc.save();
    applyClip(lc, clip);
    if (s.kind === "erase") {
      lc.globalCompositeOperation = "destination-out";
      drawErase(lc, s as EraseShape);
    } else {
      drawShape(lc, s, deps);
    }
    lc.restore();
  }
  c.save();
  applyClip(c, clip);
  c.drawImage(_layer!, 0, 0);
  c.restore();
}
