// overlay 与 editor 共用的浮层定位：每帧由页面的 rAF 调用，直接写 DOM 样式，
// 绕开 React reconciliation —— 跟随光标的元素若走 setState，pointermove 就成了渲染风暴。

import { useSyncExternalStore } from "react";
import type { OverlayController } from "./engine/controller";
import type { ChromeRefs } from "./components/chrome";
import { px } from "./components/chrome";
import { paintLoupe } from "./components/Magnifier";

/** 工具条与选区下缘的间距（CSS px） */
const GAP = 8;

export function layoutChrome(ctrl: OverlayController, refs: ChromeRefs) {
  const i = ctrl.chromeInfo;
  const s = ctrl.state;
  const k = i.cssScale;
  const toCss = (p: { x: number; y: number }) => ({
    left: i.cssOrigin.x + p.x * k,
    top: i.cssOrigin.y + p.y * k,
  });

  // --- 读数标签 ---
  const pos = i.loupeVisible && i.virtualPointer && i.pointer ? toCss(i.pointer) : null;
  if (refs.posLabel) {
    if (pos && i.virtualPointer) {
      refs.posLabel.textContent = `${i.virtualPointer.x}, ${i.virtualPointer.y}`;
      refs.posLabel.style.left = px(pos.left + 14);
      refs.posLabel.style.top = px(pos.top - 26);
      refs.posLabel.style.display = "block";
    } else {
      refs.posLabel.style.display = "none";
    }
  }
  if (refs.sizeLabel) {
    const r = i.sel;
    if (r && (i.phase === "drawing" || i.phase === "adjusting")) {
      refs.sizeLabel.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
      const anchorP = i.phase === "drawing" && i.pointer ? toCss(i.pointer) : toCss({ x: r.x + r.w, y: r.y + r.h });
      refs.sizeLabel.style.left = px(anchorP.left + (i.phase === "drawing" ? 14 : -6));
      refs.sizeLabel.style.top = px(anchorP.top + (i.phase === "drawing" ? 12 : 6));
      refs.sizeLabel.style.display = "block";
    } else {
      refs.sizeLabel.style.display = "none";
    }
  }
  if (refs.winTitle) {
    const hover = i.phase === "picking" ? i.hover : null;
    const named = hover ? ctrl.windowTitleAt(hover) : null;
    if (hover && named) {
      refs.winTitle.textContent = named;
      const p = toCss({ x: hover.x, y: hover.y });
      refs.winTitle.style.left = px(p.left + 2);
      refs.winTitle.style.top = px(p.top - 22);
      refs.winTitle.style.display = "block";
    } else {
      refs.winTitle.style.display = "none";
    }
  }

  // --- 放大镜 ---
  if (refs.loupe) {
    if (i.loupeVisible && i.pointer && i.color) {
      const size = refs.loupe.offsetWidth || 170;
      const p = toCss(i.pointer);
      let left = p.left + 22;
      let top = p.top + 22;
      if (left + size > i.winW - 4) left = p.left - size - 22;
      if (top + size + 44 > i.winH - 4) top = p.top - size - 66;
      refs.loupe.style.left = px(Math.max(4, left));
      refs.loupe.style.top = px(Math.max(4, top));
      refs.loupe.style.display = "block";
      const frame = ctrl.frameImage;
      if (refs.loupeCanvas && frame) {
        paintLoupe(refs.loupeCanvas, frame, i.pointer.x, i.pointer.y);
      }
      const hex = i.hex;
      const rgb = `rgb(${i.color.join(",")})`;
      const text = s.loupeFormat === "hex" ? hex : rgb;
      if (refs.loupeInfo) {
        const chip = refs.loupeInfo.querySelector(".snip-loupe-chip") as HTMLElement | null;
        const label = refs.loupeInfo.querySelector(".snip-loupe-text") as HTMLElement | null;
        if (chip) chip.style.background = hex;
        if (label) label.textContent = `${text}  (${s.loupeFormat === "hex" ? "HEX" : "RGB"})`;
      }
    } else if (refs.loupe) {
      refs.loupe.style.display = "none";
    }
  }

  // --- 工具条（含属性栏）整体定位，放不下就翻到选区上方 ---
  const bar = refs.toolbar;
  if (bar && i.showToolbar && i.sel) {
    const propsEl = refs.propsBar;
    const r = i.sel;
    const selLeft = i.cssOrigin.x + r.x * k;
    const selRight = selLeft + r.w * k;
    const selTop = i.cssOrigin.y + r.y * k;
    const selBottom = selTop + r.h * k;
    const barW = bar.offsetWidth || 300;
    const totalH = (bar.offsetHeight || 34) + (propsEl ? (propsEl.offsetHeight || 30) + 4 : 0);

    let top = selBottom + GAP;
    if (top + totalH > i.winH - 4) top = Math.max(4, selTop - GAP - totalH);
    let left = selRight - barW;
    if (left < 4) left = 4;
    if (left + barW > i.winW - 4) left = Math.max(4, i.winW - barW - 4);

    bar.style.left = px(left);
    bar.style.top = px(top);
    bar.style.display = "flex";
    if (propsEl) {
      propsEl.style.left = px(left);
      propsEl.style.top = px(top + (bar.offsetHeight || 34) + 4);
      propsEl.style.display = propsEl.textContent ? "flex" : "none";
    }
  } else {
    if (bar) bar.style.display = "none";
    if (refs.propsBar) refs.propsBar.style.display = "none";
  }
}

export function StatusBar({ ctrl }: { ctrl: OverlayController }) {
  const s = useSyncExternalStore(ctrl.store.subscribe, ctrl.store.get);
  if (!s.error) return null;
  return <div className="snip-toast">{s.error}</div>;
}
