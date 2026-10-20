//! 跟随光标的读数标签。迁移前尺寸读数被塞进 view.title，只能悬停看原生 tooltip ——
//! 屏幕上等于什么都没有。这里是真正的 Snipaste 风格浮标。

import type { ChromeBag } from "./chrome";

export default function Readout({ chrome }: { chrome: ChromeBag }) {
  return (
    <>
      <div
        className="snip-label"
        ref={(el) => {
          chrome.current.posLabel = el;
        }}
      />
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
