//! CSS 自定义光标：把字形渲染成 data-URL PNG + 热点，交给 `cursor: url(...)`。
//!
//! **为什么不用 `cursor: none` + 画布自绘**：WebView2/Chromium 在从具名光标
//! （如 `nwse-resize`）切回 `none` 时并不立即生效，会保留上一个系统光标 ——
//! 于是出现「缩放光标与画布上画的标注光标同屏」（实测踩过）。
//! 只要系统里始终存在一个真实光标（哪怕是透明的），就不存在"该隐藏却没隐藏"这个状态。
//!
//! 尺寸一律用 **CSS px**（光标图不受 canvas 的物理像素换算影响），最大 32；
//! 超过 `MAX_CURSOR_RADIUS`（15 CSS px = 30px 直径）的笔刷（记号笔线宽 16 时
//! 半径 32px、橡皮 4–80、马赛克 8–80）仍由画布画圈当尺寸预览，
//! 光标本身只给一个精确定位的细十字。

export type CursorKind = "cross" | "dotTicks" | "dot" | "blank" | "rotate";

/** 光标图能容纳的最大半径（CSS px）。超过这个值就改走"十字光标 + 画布补圈"。 */
export const MAX_CURSOR_RADIUS = 15;

const CACHE = new Map<string, string>();
const S = 32; // 光标画布边长（CSS px），Windows 光标上限

/** 全透明 32×32 光标图（懒建一次）：给"圈由画布画"的工具当占位光标用 */
let BLANK_URL: string | null = null;
function blankUrl(): string {
  if (!BLANK_URL) {
    const c = document.createElement("canvas");
    c.width = S;
    c.height = S;
    BLANK_URL = c.toDataURL(); // 什么都没画 → 全透明
  }
  return `url(${BLANK_URL}) ${S / 2} ${S / 2}, none`;
}

/** 生成（并缓存）一个以中心为热点的 CSS cursor 值 */
export function cursorUrl(kind: CursorKind, rPx: number, color: string): string {
  const r = Math.max(1, Math.min(S / 2 - 1, rPx));
  // cross / blank / rotate 的字形尺寸与半径无关（各自写死在分支里），
  // 缓存键也不能带 rPx，否则同一个形状会按传进来的半径存好几份
  const keyed = kind === "cross" || kind === "blank" || kind === "rotate" ? "-" : String(Math.round(r));
  const key = `${kind}|${keyed}|${color}`;
  const hit = CACHE.get(key);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const x = c.getContext("2d");
  if (!x) return "none";
  const m = S / 2 + 0.5; // 1px 线压在像素中心，避免抗锯齿糊化

  if (kind === "blank") {
    /* 全透明光标：给"笔刷圈由画布画"的工具（橡皮圆头 / 马赛克线条）用。
       为什么不直接写 `cursor: none`：WebView2 从具名光标（如 nwse-resize）切回 none
       不生效，会留下上一个系统光标 → 双光标。给一张透明图，系统里始终有个真实光标，
       但看不见，画布上的圈就是唯一可见的光标。 */
    return blankUrl();
  }
  if (kind === "cross") {
    /* 整像素细十字：黑加号（臂宽 3px、长 22）上叠白加号（臂宽 1px、长 20），
       四周天然 1px 黑描边、内角四像素自动包黑，不经过抗锯齿（历史教训：
       多边形+0.5px 描边会让白芯被 AA 成灰色"畸形十字"；4px 臂版用户嫌粗）。
       白芯列 16 = 热点列，深底靠白芯、浅底靠黑边两头都读得出。 */
    x.fillStyle = "#000";
    x.fillRect(15, 5, 3, 22);
    x.fillRect(5, 15, 22, 3);
    x.fillStyle = "#fff";
    x.fillRect(16, 6, 1, 20);
    x.fillRect(6, 16, 20, 1);
  } else if (kind === "rotate") {
    /* 旋转光标：环形箭头（约 300° 圆弧 + 末端小箭头），白芯 + 黑描边（与 cross 同一
       可读性分工：深底靠白芯、浅底靠黑边）。给输入框的旋转手柄 hover 用。
       弧先画黑粗线再叠白细线出"描边"效果；箭头三角贴在弧终点的切线方向上。 */
    const rr = 8;
    const a0 = -0.6;
    const a1 = Math.PI * 1.55;
    const drawArc = (w: number, col: string) => {
      x.beginPath();
      x.arc(m, m, rr, a0, a1);
      x.strokeStyle = col;
      x.lineWidth = w;
      x.stroke();
    };
    drawArc(4.5, "#000");
    drawArc(3, "#fff");
    const ex = m + rr * Math.cos(a1);
    const ey = m + rr * Math.sin(a1);
    const tang = a1 + Math.PI / 2;
    const nx = Math.cos(tang);
    const ny = Math.sin(tang);
    const px = Math.cos(tang + Math.PI / 2);
    const py = Math.sin(tang + Math.PI / 2);
    const head = 4.5;
    x.beginPath();
    x.moveTo(ex - px * head * 0.8, ey - py * head * 0.8);
    x.lineTo(ex + nx * head * 0.9, ey + ny * head * 0.9);
    x.lineTo(ex + px * head * 0.8, ey + py * head * 0.8);
    x.closePath();
    x.fillStyle = "#fff";
    x.fill();
    x.strokeStyle = "#000";
    x.lineWidth = 0.6;
    x.stroke();
  } else if (kind === "dot") {
    // 记号笔：实心圆，半透明当前色 + 实边（与它涂出来的高亮同观感）
    x.globalAlpha = 0.55;
    x.fillStyle = color;
    x.beginPath();
    x.arc(m, m, r, 0, Math.PI * 2);
    x.fill();
    x.globalAlpha = 1;
    x.lineWidth = 1;
    x.strokeStyle = color;
    x.stroke();
  } else {
    // 箭头 / 画笔：圆点 + 四向短线，纯当前标注色（不加白描边，实测白晕在浅底上糊）
    x.fillStyle = color;
    x.beginPath();
    x.arc(m, m, r, 0, Math.PI * 2);
    x.fill();
    // 短线是装饰，不计入"光标大小"；但必须容得下 —— 圆点按工具条同径后可以长到
    // 半径 10，再按 r*0.9 画短线就会顶出 32 的画布，所以这里夹一下。
    const gap = r + 2.5;
    const tick = Math.max(2, Math.min(Math.max(3, r * 0.9), S / 2 - gap - 0.5));
    x.strokeStyle = color;
    x.lineWidth = Math.max(1.5, r * 0.3);
    x.lineCap = "round";
    x.beginPath();
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      x.moveTo(m + dx * gap, m + dy * gap);
      x.lineTo(m + dx * (gap + tick), m + dy * (gap + tick));
    }
    x.stroke();
  }

  const url = `url(${c.toDataURL()}) ${S / 2} ${S / 2}, none`;
  // 缓存要有上限：色板 20 色 × 线宽 16 档 × 3 种字形，正常用量很小，但防止极端情况无限涨
  if (CACHE.size > 400) CACHE.clear();
  CACHE.set(key, url);
  return url;
}
