//! 放大镜：像素网格 + 中心十字 + 色值。Alt 强制显示，C 复制，Shift+C 切 RGB/HEX。

import type { ChromeBag } from "./chrome";
import { LOUPE_CELL, LOUPE_N, LOUPE_SIZE } from "./chrome";

export default function Magnifier({ chrome }: { chrome: ChromeBag }) {
  return (
    <div
      className="snip-loupe"
      ref={(el) => {
        chrome.current.loupe = el;
      }}
    >
      <canvas
        width={LOUPE_SIZE}
        height={LOUPE_SIZE}
        ref={(el) => {
          chrome.current.loupeCanvas = el;
        }}
      />
      <div
        className="snip-loupe-coords"
        ref={(el) => {
          chrome.current.loupeCoords = el;
        }}
      />
      <div
        className="snip-loupe-info"
        ref={(el) => {
          chrome.current.loupeInfo = el;
        }}
      >
        <span className="snip-loupe-chip" />
        <span className="snip-loupe-text" />
      </div>
      <div className="snip-loupe-hint">按 C 复制颜色值</div>
      <div className="snip-loupe-hint">按 Shift 切换 RGB/HEX</div>
    </div>
  );
}

/** 每帧由页面调用：按当前指针位置重画取样区 */
export function paintLoupe(
  canvas: HTMLCanvasElement,
  source: ImageBitmap,
  px: number,
  py: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const side = LOUPE_N * 2 + 1;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, px - LOUPE_N, py - LOUPE_N, side, side, 0, 0, canvas.width, canvas.height);

  // 像素网格
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < side; i++) {
    const o = Math.round(i * LOUPE_CELL) + 0.5;
    ctx.moveTo(o, 0);
    ctx.lineTo(o, canvas.height);
    ctx.moveTo(0, o);
    ctx.lineTo(canvas.width, o);
  }
  ctx.stroke();

  // 中心像素十字（Snipaste 用细框标出当前像素）
  const c = LOUPE_N * LOUPE_CELL;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  ctx.strokeRect(c + 0.5, c + 0.5, LOUPE_CELL - 1, LOUPE_CELL - 1);
  ctx.strokeStyle = "rgba(76,159,245,.9)";
  ctx.beginPath();
  ctx.moveTo(c + LOUPE_CELL / 2, 0);
  ctx.lineTo(c + LOUPE_CELL / 2, canvas.height);
  ctx.moveTo(0, c + LOUPE_CELL / 2);
  ctx.lineTo(canvas.width, c + LOUPE_CELL / 2);
  ctx.stroke();
}
