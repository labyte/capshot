//! 放大镜：横长方形取样区 + 贯穿十字 + 中心像素框 + 下挂深色信息面板。
//! Alt 强制显示，C 复制，Shift 切 RGB/HEX。
//!
//! 视觉对齐参考图（深/浅两张底各一份）：
//! - 取样区无像素网格，只有贯穿全幅的十字线：半透明蓝（≈50% 不透明度），
//!   叠在深底上呈钢蓝、叠在浅底上呈浅蓝——一张图两种观感，同一个颜色。
//! - 中心像素方框与取样区外边框用**对比色**描边：采样点偏暗→白、偏亮→近黑，
//!   保证在任何底色上都看得见（参考图深底白框、浅底黑框）。
//! - 信息面板是无圆角、无内边距间隙的纯深灰块，与取样区同宽、紧贴其下。

import type { ChromeBag } from "./chrome";
import { LOUPE_CELL, LOUPE_H, LOUPE_NX, LOUPE_NY, LOUPE_W } from "./chrome";

export default function Magnifier({ chrome }: { chrome: ChromeBag }) {
  return (
    <div
      className="snip-loupe"
      ref={(el) => {
        chrome.current.loupe = el;
      }}
    >
      <canvas
        width={LOUPE_W}
        height={LOUPE_H}
        ref={(el) => {
          chrome.current.loupeCanvas = el;
        }}
      />
      <div className="snip-loupe-panel">
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
        <div className="snip-loupe-hint">
          按 <b>C</b> 复制颜色值
        </div>
        <div className="snip-loupe-hint">
          按 <b>Shift</b> 切换 RGB/HEX
        </div>
      </div>
    </div>
  );
}

/** 采样点亮度 → 描边对比色：暗底用白、亮底用近黑 */
function contrastStroke(rgb: readonly number[]): string {
  const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  return lum >= 128 ? "#1c1c1c" : "#ffffff";
}

/** 每帧由页面调用：按当前指针位置重画取样区 */
export function paintLoupe(
  canvas: HTMLCanvasElement,
  source: ImageBitmap,
  px: number,
  py: number,
  rgb: readonly number[],
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const sw = LOUPE_NX * 2 + 1;
  const sh = LOUPE_NY * 2 + 1;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, px - LOUPE_NX, py - LOUPE_NY, sw, sh, 0, 0, canvas.width, canvas.height);

  const cx = LOUPE_NX * LOUPE_CELL;
  const cy = LOUPE_NY * LOUPE_CELL;

  // 贯穿全幅的十字线：半透明蓝，深/浅底上自然呈现两种深浅（参考图同款）
  ctx.strokeStyle = "rgba(76, 159, 245, 0.55)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx + LOUPE_CELL / 2, 0);
  ctx.lineTo(cx + LOUPE_CELL / 2, canvas.height);
  ctx.moveTo(0, cy + LOUPE_CELL / 2);
  ctx.lineTo(canvas.width, cy + LOUPE_CELL / 2);
  ctx.stroke();

  // 中心像素方框 + 外边框：对比色描边
  const edge = contrastStroke(rgb);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 2;
  ctx.strokeRect(cx + 1, cy + 1, LOUPE_CELL - 2, LOUPE_CELL - 2);
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, canvas.width - 1, canvas.height - 1);
}
