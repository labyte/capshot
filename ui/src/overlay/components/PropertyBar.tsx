//! 二级属性栏：工具激活（或有选中图形）时出现。色板 / 线宽 / 填充 / 字号 / 马赛克 / 序号。

import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { OverlayController } from "../engine/controller";
import type { ChromeBag } from "./chrome";
import { PALETTE, WIDTHS } from "../../annotate/model";

export default function PropertyBar({
  ctrl,
  chrome,
}: {
  ctrl: OverlayController;
  chrome: ChromeBag;
}) {
  const s = useSyncExternalStore(ctrl.store.subscribe, ctrl.store.get);
  if (!s.sel || (!s.tool && s.selectedId === null)) return null;
  const p = s.props;

  const stop = (e: ReactPointerEvent) => e.stopPropagation();

  return (
    <div
      className="snip-bar snip-props"
      ref={(el) => {
        chrome.current.propsBar = el;
      }}
      onPointerDown={stop}
    >
      <div className="snip-bar-row">
        <label className="snip-color" title="当前颜色（点击自选）">
          <input
            type="color"
            value={p.color}
            onChange={(e) => ctrl.setProps({ color: e.target.value })}
          />
        </label>
        {PALETTE.map((c) => (
          <button
            key={c}
            className={"snip-swatch" + (p.color.toLowerCase() === c.toLowerCase() ? " on" : "")}
            style={{ background: c }}
            title={c}
            onClick={() => ctrl.setProps({ color: c })}
          />
        ))}

        <span className="snip-sep" />

        {WIDTHS.map((w) => (
          <button
            key={w}
            className={"snip-wbtn" + (Math.round(p.width) === w ? " on" : "")}
            title={`线宽 ${w}（滚轮 / 1 / 2 / [ ]）`}
            onClick={() => ctrl.setProps({ width: w })}
          >
            <span style={{ height: `${w + 2}px` }} />
          </button>
        ))}

        {(s.tool === "rect" || s.tool === "ellipse") && (
          <>
            <span className="snip-sep" />
            <button
              className={"snip-chip" + (p.filled ? " on" : "")}
              title="填充 / 描边"
              onClick={() => ctrl.setProps({ filled: !p.filled })}
            >
              {p.filled ? "实心" : "描边"}
            </button>
          </>
        )}

        {s.tool === "text" && (
          <>
            <span className="snip-sep" />
            {[14, 18, 24, 32].map((f) => (
              <button
                key={f}
                className={"snip-chip" + (p.fontPx === f ? " on" : "")}
                onClick={() => ctrl.setProps({ fontPx: f })}
              >
                {f}
              </button>
            ))}
            <button
              className={"snip-chip" + (p.textBg ? " on" : "")}
              title="文字底色"
              onClick={() => ctrl.setProps({ textBg: !p.textBg })}
            >
              底
            </button>
          </>
        )}

        {s.tool === "mosaic" && (
          <>
            <span className="snip-sep" />
            <button
              className="snip-chip"
              title="像素化 / 高斯模糊（滚轮调粒度）"
              onClick={() =>
                ctrl.setProps({ mosaicStyle: p.mosaicStyle === "pixel" ? "blur" : "pixel" })
              }
            >
              {p.mosaicStyle === "pixel" ? "马赛克" : "模糊"}
            </button>
            <span className="snip-level">{Math.round(p.mosaicLevel)}</span>
          </>
        )}

        {s.tool === "step" && (
          <>
            <span className="snip-sep" />
            <span className="snip-level">起始 {p.stepNo}</span>
            <button className="snip-chip" title="重置编号 (+/- 调整)" onClick={() => ctrl.setProps({ stepNo: 1 })}>
              重置
            </button>
          </>
        )}
      </div>
    </div>
  );
}
