//! 文字标注输入框。Ctrl+C 等全局键位在这里必须 stopPropagation，
//! 否则输入 "copy" 会触发复制到剪贴板并退出截图（迁移前就是这个坑）。

import { useEffect, useRef } from "react";
import { useSyncExternalStore } from "react";
import type { OverlayController } from "../engine/controller";

export default function TextInput({ ctrl }: { ctrl: OverlayController }) {
  const s = useSyncExternalStore(ctrl.store.subscribe, ctrl.store.get);
  const inputRef = useRef<HTMLInputElement>(null);
  const at = s.pendingTextAt;
  const info = ctrl.chromeInfo;

  useEffect(() => {
    if (!at) return;
    ctrl.pendingTextValue = "";
    const el = inputRef.current;
    if (!el) return;
    el.value = "";
    // 焦点必须等到 mousedown 的默认行为之后：canvas 上点下时事件顺序是
    // pointerdown(挂载+focus) → mousedown(浏览器把焦点抢回 body) → 立刻 blur，
    // 而同步 focus() 会被这记 blur 触发 onBlur→commitText 空提交，输入框一闪就没。
    // 挪到下一帧 focus，落点就在 mousedown 默认处理之后，抢不走了。
    const raf = requestAnimationFrame(() => el.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [at, ctrl]);

  if (!at) return null;

  const left = info.cssOrigin.x + at.x * info.cssScale;
  const top = info.cssOrigin.y + at.y * info.cssScale;
  const fontPx = Math.max(12, s.props.fontPx * info.cssScale);
  // 深色字配浅底、浅色字配深底：选中黑色时别让字在深半透明底上"隐身"
  const col = s.props.color;
  const lum =
    (0.299 * parseInt(col.slice(1, 3), 16) +
      0.587 * parseInt(col.slice(3, 5), 16) +
      0.114 * parseInt(col.slice(5, 7), 16)) /
    255;

  return (
    <div className="snip-textinput" style={{ left: `${left}px`, top: `${top}px`, fontSize: `${fontPx}px` }}>
      <input
        ref={inputRef}
        placeholder="输入文字，回车确认"
        // 输入期就按当前属性（颜色/粗细/斜体/删除线/字体/字号）渲染，和提交后的图形一致
        style={{
          color: col,
          background: lum < 0.5 ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.55)",
          fontWeight: s.props.textBold ? 700 : 400,
          fontStyle: s.props.textItalic ? "italic" : "normal",
          textDecoration: s.props.textStrike ? "line-through" : "none",
          fontFamily: `"${s.props.textFamily}", sans-serif`,
        }}
        onChange={(e) => {
          ctrl.pendingTextValue = e.target.value;
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            ctrl.commitText();
          } else if (e.key === "Escape") {
            e.preventDefault();
            ctrl.cancelText();
          }
        }}
      />
    </div>
  );
}
