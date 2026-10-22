//! 二级属性栏：工具激活（或有选中图形）时出现。布局对齐 Snipaste 各工具的第二行：
//! 尺寸圆点 → 工具专属项（描边/填充、矩形/椭圆切换、箭头样式、马赛克/模糊）→ 颜色选择器 + 色板。
//! 橡皮擦没有颜色；序号保留自有项；文字保留 B/I/S/字体/字号。
//!
//! **圆点的两副面孔**（界面设计 §3/§6/§9）：它先是尺寸读数（滚轮调 + 悬停浮标），
//! 在有「手绘 vs 矩形」「描边 vs 填充」之分的工具上，它同时是那一组的**描边/手绘单选项**——
//! 点击只切模式、不改数值。箭头/画笔没有对立体，圆点保持只读常亮。

import {
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { OverlayController } from "../engine/controller";
import type { ChromeBag } from "./chrome";
import { FONT_FAMILIES, FONT_SIZES, PALETTE } from "../../annotate/model";
import { IconBlur, IconEllipse, IconMosaic, IconRect } from "../../shared/icons";

/**
 * 圆点预览直径：把值线性映射后夹进按钮盒内（圆点盒 24×22）。
 * 不缩的话橡皮 80 半径→30px、马赛克 80 直径→42px，会撑破按钮。
 * 精确数值以悬停浮标为准，圆点只表意"粗 / 细"。
 */
const dotPx = (value: number, per: number) => Math.min(20, 2 + value / per);

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

  const widthTool =
    t === "rect" || t === "ellipse" || t === "arrow" || t === "polyline" || t === "marker";
  const fill = ctrl.fillState();

  /** 圆点当前表示的尺寸：橡皮是擦除半径，其余画线类是线宽（映射系数也不同） */
  const sizeVal = t === "eraser" ? p.eraserRadius : p.width;
  const sizeDot = dotPx(sizeVal, t === "eraser" ? 5 : 1);

  /**
   * 圆点作为「描边 / 手绘」单选项的工具。null=该工具的圆点只是只读读数（箭头、画笔、
   * 以及未选工具但点选了已画图形的场合）。
   */
  const dotMode =
    t === "rect" || t === "ellipse" || (!t && fill.visible)
      ? // !t && fill.visible：点选了已画的矩形/椭圆，圆点照样是这一组的描边项
        //（setTool 会清 selectedId，所以不会和箭头/画笔的常亮圆点撞车）
        { on: !fill.filled, name: "描边", pick: () => ctrl.setFill(false) }
      : t === "marker"
        ? { on: !p.markerRect, name: "手绘涂抹", pick: () => ctrl.setProps({ markerRect: false }) }
        : t === "eraser"
          ? { on: !p.eraserRect, name: "手绘擦除", pick: () => ctrl.setProps({ eraserRect: false }) }
          : null;

  /** 填充项/网点画哪个形状：ctrl.fillState().kind 已经排好优先级
   *  （点选的图形 > 刚画完带句柄的那支 > 当前工具），这里只照它渲染 */
  const fillEllipse = fill.kind === "ellipse";
  const fillName = fillEllipse ? "椭圆" : "矩形";

  /**
   * 尺寸圆点上的滚轮：绘图区之外唯一的调节入口。
   * 不 preventDefault —— React 在根容器上把 wheel 注册为 passive，调用无效；
   * 而 canvas 的 wheel 监听挂在 canvas 元素上，不是属性栏的祖先，事件不会冒泡过去，
   * 所以这里只需要改值，不必抢默认行为。
   */
  const sizeWheel = (e: ReactWheelEvent) => {
    ctrl.adjustSize(e.deltaY < 0 ? 1 : -1);
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

        {/* 尺寸圆点。有对立体时它是「描边/手绘」单选项（点击切模式，滚轮调数值）；
            其余工具退化为只读读数，箭头/画笔按设计常亮选中 */}
        {dotMode && (
          <button
            className={"snip-btn snip-wdot" + (dotMode.on ? " on" : "")}
            title={`${dotMode.name}（滚轮调${t === "eraser" ? "擦除半径" : "线宽"}）`}
            onClick={dotMode.pick}
            onWheel={sizeWheel}
          >
            <span style={{ width: sizeDot, height: sizeDot }} />
            <em className="val">{Math.round(sizeVal)} px</em>
          </button>
        )}
        {!dotMode && (widthTool || (!t && s.selectedId !== null)) && (
          <div
            className={"snip-wdot static" + (widthTool ? " on" : "")}
            title="线宽（仅滚轮调整）"
            onWheel={sizeWheel}
          >
            <span style={{ width: sizeDot, height: sizeDot }} />
            <em className="val">{Math.round(sizeVal)} px</em>
          </div>
        )}

        {/* 填充：与左边的描边圆点构成互斥单选组（点它=设为填充，点圆点=设回描边，
            点已选中的那一项原地不动，所以它不是复选框）。图标跟着形状走：
            椭圆态=网点椭圆，矩形态=网点矩形（参照图实测就是网点，不是实心）。
            可见性由 ctrl.fillState() 统一判定，不会出现"看得见却点不动"；
            F 键仍走 toggleFill 的切换语义 */}
        {fill.visible && (
          <button
            className={"snip-btn" + (fill.filled ? " on" : "")}
            title={fill.filled ? `已填充${fillName}（F 切回描边）` : `填充${fillName}（F）`}
            onClick={() => ctrl.setFill(true)}
          >
            {/* 网点形状（参照图实测），轮廓随矩形⇄椭圆换 class，与 .snip-rectbtn 同一画法 */}
            <span className={"snip-dither " + (fillEllipse ? "ellipse" : "rect")} />
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

        {/* 箭头样式：一个下拉三选项，纯符号无文字。选「无头/单/双」同时定死头部=实心
            （hollow 仍能被渲染，兼容历史数据，只是不再提供入口） */}
        {t === "arrow" && (
          <select
            className="snip-select snip-astyle"
            title="箭头样式"
            value={p.arrowHead === "none" ? "none" : p.arrowDouble ? "double" : "single"}
            onChange={(e) => {
              const v = e.target.value;
              ctrl.setProps(
                v === "none"
                  ? { arrowHead: "none", arrowDouble: false }
                  : v === "double"
                    ? { arrowHead: "solid", arrowDouble: true }
                    : { arrowHead: "solid", arrowDouble: false },
              );
            }}
          >
            <option value="none" title="无箭头直线">—</option>
            <option value="single" title="单箭头">→</option>
            <option value="double" title="双箭头">↔</option>
          </select>
        )}

        {/* 第二个子属性：矩形模式（对齐参考图的斜纹方块按钮）。
            记号笔=矩形高亮框选；橡皮擦=矩形框选擦除。
            与左边的手绘圆点是**互斥单选组**，所以这里设为 true 而非取反——
            再点一次已选中的矩形项应当原地不动，圆点那侧同理 */}
        {t === "marker" && (
          <button
            className={"snip-btn snip-rectbtn" + (p.markerRect ? " on" : "")}
            title="矩形标记模式（拖框高亮）"
            onClick={() => ctrl.setProps({ markerRect: true })}
          >
            <span />
          </button>
        )}
        {t === "eraser" && (
          <button
            className={"snip-btn snip-rectbtn" + (p.eraserRect ? " on" : "")}
            title="矩形擦除模式（框选擦除）"
            onClick={() => ctrl.setProps({ eraserRect: true })}
          >
            <span />
          </button>
        )}

        {t !== "eraser" && t !== "mosaic" && (
          <>
            <span className="snip-sep" />
            {/* 当前色块 24×24；不在预设色里时右下角亮一个小三角（参照图实测的"自选色"角标） */}
            <label
              className={"snip-color" + (PALETTE.includes(p.color.toLowerCase()) ? "" : " custom")}
              title="当前颜色（点击自选）"
            >
              <input
                type="color"
                value={p.color}
                onChange={(e) => ctrl.setProps({ color: e.target.value })}
              />
            </label>
            {/* 预设色 2 行 × 10 列（参照图实测），铺法交给 .snip-swatches 的 grid */}
            <div className="snip-swatches">
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className={"snip-swatch" + (p.color.toLowerCase() === c.toLowerCase() ? " on" : "")}
                  style={{ background: c }}
                  title={c}
                  onClick={() => ctrl.setProps({ color: c })}
                />
              ))}
            </div>
          </>
        )}

        {/* 马赛克四组（对齐参照图，无颜色板）：①线条模式（笔刷打码，滚轮调粗细）
            ②填充模式（矩形框选）—— ①②互斥；③马赛克/模糊样式 —— **一个按钮**，图标即当前样式、再点切换，
            不再是文字 chip；④大小滑块 + 数值读数 */}
        {t === "mosaic" && (
          <>
            <button
              className={"snip-btn snip-wdot" + (p.mosaicMode === "line" ? " on" : "")}
              title="线条模式（拖笔刷打码，粗细仅滚轮调整）"
              onClick={() => ctrl.setProps({ mosaicMode: "line" })}
              onWheel={sizeWheel}
            >
              <span style={{ width: dotPx(p.mosaicBrush, 6), height: dotPx(p.mosaicBrush, 6) }} />
              <em className="val">{Math.round(p.mosaicBrush)} px</em>
            </button>
            <button
              className={"snip-btn snip-rectbtn" + (p.mosaicMode === "fill" ? " on" : "")}
              title="填充模式（矩形框选打码）"
              onClick={() => ctrl.setProps({ mosaicMode: "fill" })}
            >
              <span />
            </button>
            <span className="snip-sep" />
            {/* 打码样式：**一个按钮**，图标就是当前样式，再点一下在马赛克⇄模糊之间切换
                （用户要求，也少一个元素）。图标本身吃 mosaicLevel ——
                拖粒度时格子粗细 / 波纹起伏当场跟着变，所以不加 .on 高亮。 */}
            <button
              className="snip-btn"
              title={`打码样式：${p.mosaicStyle === "pixel" ? "马赛克（像素方块化）" : "模糊（柔化）"}（点击切换）`}
              onClick={() =>
                ctrl.setProps({ mosaicStyle: p.mosaicStyle === "pixel" ? "blur" : "pixel" })
              }
            >
              {p.mosaicStyle === "pixel" ? (
                <IconMosaic level={p.mosaicLevel} />
              ) : (
                <IconBlur level={p.mosaicLevel} />
              )}
            </button>
            <input
              className="snip-range"
              type="range"
              min={2}
              max={40}
              step={2}
              value={p.mosaicLevel}
              title="大小（像素粒度 / 模糊半径）"
              onWheel={sizeWheel}
              onChange={(e) => ctrl.setProps({ mosaicLevel: Number(e.target.value) })}
            />
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
