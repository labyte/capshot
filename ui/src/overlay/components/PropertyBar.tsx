//! 二级属性栏：工具激活（或有选中图形）时出现。布局对齐 Snipaste 各工具的第二行：
//! 尺寸圆点（点击循环）→ 工具专属项（矩形/椭圆切换、箭头样式、半透明笔刷示意）→
//! 颜色选择器 + 色板。橡皮擦没有颜色；马赛克/序号保留自有项；文字保留 B/I/S/字体/字号。

import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { OverlayController } from "../engine/controller";
import type { ChromeBag } from "./chrome";
import { ERASER_SIZES, FONT_FAMILIES, FONT_SIZES, PALETTE, WIDTHS } from "../../annotate/model";
import { IconEllipse, IconRect } from "../../shared/icons";

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
  const t = s.tool;

  const stop = (e: ReactPointerEvent) => e.stopPropagation();

  // 单个圆点按钮点击循环档位（滚轮 / [ ] / 1 / 2 键位照常可用）
  const widthTool =
    t === "rect" || t === "ellipse" || t === "arrow" || t === "polyline" || t === "marker";
  const cycleWidth = () => {
    const i = WIDTHS.indexOf(Math.round(p.width));
    ctrl.setProps({ width: WIDTHS[(i + 1) % WIDTHS.length] });
  };
  const cycleEraser = () => {
    const i = ERASER_SIZES.indexOf(p.eraserRadius);
    ctrl.setProps({ eraserRadius: ERASER_SIZES[(i + 1) % ERASER_SIZES.length] });
  };

  return (
    <div
      className="snip-bar snip-props"
      ref={(el) => {
        chrome.current.propsBar = el;
      }}
      onPointerDown={stop}
      // 点色板/样式按钮会把焦点从文字输入框抢给按钮；这里立刻把焦点还回去，
      // 让"边输入边换色/换样式"成立（属性经 store 实时渲染进输入框）。
      // select 例外：它的原生下拉靠自身焦点存活，抢回来会在选中前把菜单关掉。
      onClickCapture={(e) => {
        if (!ctrl.state.pendingTextAt) return;
        if ((e.target as HTMLElement).tagName === "SELECT") return;
        (document.querySelector(".snip-textinput input") as HTMLInputElement | null)?.focus();
      }}
    >
      <div className="snip-bar-row">
        {/* 文字：样式/字体/字号排在颜色前，对齐 Snipaste 的文字属性栏 */}
        {t === "text" && (
          <>
            <button
              className={"snip-btn snip-tbtn b" + (p.textBold ? " on" : "")}
              title="加粗"
              onClick={() => ctrl.setProps({ textBold: !p.textBold })}
            >
              B
            </button>
            <button
              className={"snip-btn snip-tbtn i" + (p.textItalic ? " on" : "")}
              title="斜体"
              onClick={() => ctrl.setProps({ textItalic: !p.textItalic })}
            >
              I
            </button>
            <button
              className={"snip-btn snip-tbtn s" + (p.textStrike ? " on" : "")}
              title="删除线"
              onClick={() => ctrl.setProps({ textStrike: !p.textStrike })}
            >
              A
            </button>
            <select
              className="snip-select"
              title="字体"
              value={p.textFamily}
              onChange={(e) => ctrl.setProps({ textFamily: e.target.value })}
            >
              {FONT_FAMILIES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <select
              className="snip-select snip-size"
              title="字号"
              value={p.fontPx}
              onChange={(e) => ctrl.setProps({ fontPx: Number(e.target.value) })}
            >
              {FONT_SIZES.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </>
        )}

        {/* 尺寸圆点：橡皮擦用 eraserRadius，画线类用 width */}
        {t === "eraser" && (
          <button
            className="snip-btn snip-wdot on"
            title={`橡皮大小 ${p.eraserRadius}px（点击切换）`}
            onClick={cycleEraser}
          >
            <span style={{ width: 4 + p.eraserRadius / 3, height: 4 + p.eraserRadius / 3 }} />
          </button>
        )}
        {(widthTool || (!t && s.selectedId !== null)) && (
          <button
            className={"snip-btn snip-wdot" + (widthTool ? " on" : "")}
            title={`线宽 ${Math.round(p.width)}（点击 / 滚轮 / [ ] 调整）`}
            onClick={cycleWidth}
          >
            <span style={{ width: 2 + p.width, height: 2 + p.width }} />
          </button>
        )}

        {/* 框选：矩形 ⇄ 椭圆 直接在这排切换，不用回主工具条 */}
        {(t === "rect" || t === "ellipse") && (
          <>
            <button
              className={"snip-btn" + (t === "rect" ? " on" : "")}
              title="矩形 (V)"
              onClick={() => ctrl.setTool("rect")}
            >
              <IconRect />
            </button>
            <button
              className={"snip-btn" + (t === "ellipse" ? " on" : "")}
              title="椭圆 (O)"
              onClick={() => ctrl.setTool("ellipse")}
            >
              <IconEllipse />
            </button>
          </>
        )}

        {/* 箭头：单端 → / 双端 ↔ */}
        {t === "arrow" && (
          <select
            className="snip-select snip-astyle"
            title="箭头样式"
            value={p.arrowDouble ? "d" : "s"}
            onChange={(e) => ctrl.setProps({ arrowDouble: e.target.value === "d" })}
          >
            <option value="s">→ 单端</option>
            <option value="d">↔ 双端</option>
          </select>
        )}

        {/* 马克笔/橡皮的半透明笔刷示意（对齐参考图里的斜纹方块） */}
        {(t === "marker" || t === "eraser") && <span className="snip-hatch" title="半透明笔刷" />}

        {t !== "eraser" && (
          <>
            <span className="snip-sep" />
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
          </>
        )}

        {(t === "rect" || t === "ellipse") && (
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

        {t === "text" && (
          <>
            <span className="snip-sep" />
            <button
              className={"snip-chip" + (p.textBg ? " on" : "")}
              title="文字底色"
              onClick={() => ctrl.setProps({ textBg: !p.textBg })}
            >
              底
            </button>
          </>
        )}

        {t === "mosaic" && (
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

        {t === "step" && (
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
