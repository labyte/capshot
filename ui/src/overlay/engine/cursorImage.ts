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

export type CursorKind = "cross" | "dotTicks" | "dot";

/** 光标图能容纳的最大半径（CSS px）。超过这个值就改走"十字光标 + 画布补圈"。 */
export const MAX_CURSOR_RADIUS = 15;

const CACHE = new Map<string, string>();
const S = 32; // 光标画布边长（CSS px），Windows 光标上限

/** 生成（并缓存）一个以中心为热点的 CSS cursor 值 */
export function cursorUrl(kind: CursorKind, rPx: number, color: string): string {
  const r = Math.max(1, Math.min(S / 2 - 1, rPx));
  // cross 的字形尺寸是写死的（15px / 1px），rPx 不参与 → 缓存键也不能带它，
  // 否则同一个十字会按传进来的半径存好几份
  const key = `${kind}|${kind === "cross" ? "-" : Math.round(r)}|${color}`;
  const hit = CACHE.get(key);
  if (hit) return hit;

  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const x = c.getContext("2d");
  if (!x) return "none";
  const m = S / 2 + 0.5; // 1px 线压在像素中心，避免抗锯齿糊化

  if (kind === "cross") {
    /* 十字 = **一个闭合的 12 点多边形**（加号形），整体 11×11、臂厚 3：
       中透明白填充 + 1px 黑描边。
       为什么不再是"两条线叠白边"：那样白边只剩 0.5px，被抗锯齿吃掉，
       黑底上整个光标等于不可见（实测）。闭合多边形有真正的填充面积，
       深底靠白填充、浅底靠黑描边，两头都在。
       坐标全部落在 .5 上（m=16），1px 描边才会压在像素中心而不糊。 */
    const c0 = S / 2; // 16：配上 .5 的偏移量后顶点落在像素半格上，1px 描边不糊
    const L = 5.5; // 半长 → 总 11px
    const t = 1.5; // 半臂厚 → 臂宽 3px，整体保持纤细
    const pts: [number, number][] = [
      [-t, -L], [t, -L], [t, -t], [L, -t], [L, t], [t, t],
      [t, L], [-t, L], [-t, t], [-L, t], [-L, -t], [-t, -t],
    ];
    x.beginPath();
    pts.forEach(([dx, dy], i) => {
      const px = c0 + dx;
      const py = c0 + dy;
      if (i === 0) x.moveTo(px, py);
      else x.lineTo(px, py);
    });
    x.closePath(); // 封口
    x.fillStyle = "rgba(255,255,255,0.5)"; // 中透明
    x.fill();
    x.strokeStyle = "#000";
    x.lineWidth = 1;
    x.lineJoin = "miter";
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
