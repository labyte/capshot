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
    if (at) {
      ctrl.pendingTextValue = "";
      const el = inputRef.current;
      if (el) {
        el.value = "";
        el.focus();
      }
    }
  }, [at, ctrl]);

  if (!at) return null;

  const left = info.cssOrigin.x + at.x * info.cssScale;
  const top = info.cssOrigin.y + at.y * info.cssScale;
  const fontPx = Math.max(12, s.props.fontPx * info.cssScale);

  return (
    <div className="snip-textinput" style={{ left: `${left}px`, top: `${top}px`, fontSize: `${fontPx}px` }}>
      <input
        ref={inputRef}
        placeholder="输入文字，回车确认"
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
        onBlur={() => ctrl.commitText()}
      />
    </div>
  );
}
