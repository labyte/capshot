//! 跟随光标的读数标签。迁移前尺寸读数被塞进 view.title，只能悬停看原生 tooltip ——
//! 屏幕上等于什么都没有。这里是真正的 Snipaste 风格浮标。
//!
//! 坐标浮标已移除：放大镜面板里本来就有 `(1352 , 843)` 一行，而它的显示条件
//! 与放大镜完全同步（loupeVisible），等于同一份坐标在光标旁和框内各写一遍。

import type { ChromeBag } from "./chrome";

export default function Readout({ chrome }: { chrome: ChromeBag }) {
  return (
    <>
      <div
        className="snip-label strong"
        ref={(el) => {
          chrome.current.sizeLabel = el;
        }}
      />
      <div
        className="snip-wintitle"
        ref={(el) => {
          chrome.current.winTitle = el;
        }}
      />
    </>
  );
}
