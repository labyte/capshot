//! 主工具条。静态 JSX + 内联 SVG，工具切换只翻 class ——
//! 迁移前是每次 showToolbar() 用 innerHTML 整条重建，切个工具就闪一下。

import { useSyncExternalStore, type MouseEvent as ReactMouseEvent } from "react";
import type { OverlayController } from "../engine/controller";
import type { ChromeBag } from "./chrome";
import type { ToolId } from "../engine/types";
import {
  IconArrow,
  IconClose,
  IconCopy,
  IconEraser,
  IconMarker,
  IconMosaic,
  IconPin,
  IconPen,
  IconRect,
  IconRedo,
  IconSave,
  IconShapes,
  IconStep,
  IconText,
  IconUndo,
} from "../../shared/icons";

/** soft = 激活时中性灰底（不带蓝色药丸）：画笔按需求去蓝 */
const TOOLS: { id: ToolId; label: string; key: string; Icon: typeof IconRect; soft?: boolean }[] = [
  { id: "rect", label: "形状", key: "V", Icon: IconShapes },
  { id: "arrow", label: "箭头", key: "P", Icon: IconArrow },
  { id: "polyline", label: "画笔", key: "L", Icon: IconPen, soft: true },
  { id: "marker", label: "记号笔", key: "M", Icon: IconMarker },
  // 顺序对齐参照图（docs/testing-windows.md 界面设计 §2）：马赛克在文字之前
  { id: "mosaic", label: "马赛克", key: "X", Icon: IconMosaic },
  { id: "text", label: "文字", key: "T", Icon: IconText },
  { id: "step", label: "序号", key: "N", Icon: IconStep },
  { id: "eraser", label: "橡皮擦", key: "E", Icon: IconEraser },
];

export default function Toolbar({
  ctrl,
  chrome,
}: {
  ctrl: OverlayController;
  chrome: ChromeBag;
}) {
  const s = useSyncExternalStore(ctrl.store.subscribe, ctrl.store.get);
  if (!s.sel) return null;

  const act = (fn: () => void) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  return (
    <div
      className="snip-bar"
      ref={(el) => {
        chrome.current.toolbar = el;
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="snip-bar-row">
        {TOOLS.map(({ id, label, key, Icon, soft }) => {
          // 形状按钮：矩形⇄椭圆合并为一个按钮（叠加图标），点击在两者间 toggle，
          // title 随当前子工具变化；具体选哪种在下方属性栏的 □ ○ 里切
          if (id === "rect") {
            const isEllipse = s.tool === "ellipse";
            const shapeLabel = isEllipse ? "椭圆" : "矩形";
            const shapeKey = isEllipse ? "O" : "V";
            return (
              <button
                key={id}
                className={"snip-btn" + (s.tool === "rect" || s.tool === "ellipse" ? " on" : "")}
                title={`${shapeLabel} (${shapeKey})`}
                onClick={act(() => ctrl.setTool(isEllipse ? "rect" : s.tool === "rect" ? "ellipse" : "rect"))}
              >
                <IconShapes />
              </button>
            );
          }
          return (
            <button
              key={id}
              className={"snip-btn" + (s.tool === id ? (soft ? " on-soft" : " on") : "")}
              title={`${label} (${key})`}
              onClick={act(() => ctrl.setTool(s.tool === id ? null : id))}
            >
              <Icon />
            </button>
          );
        })}
        <span className="snip-sep" />
        {/* 撤销/重做：参照图实测墨色比工具图标浅一档（#7b7b7b），走 .muted */}
        <button
          className="snip-btn muted"
          title="撤销 (Ctrl+Z)"
          disabled={!s.canUndo}
          onClick={act(() => ctrl.undo())}
        >
          <IconUndo />
        </button>
        <button
          className="snip-btn muted"
          title="重做 (Ctrl+Y)"
          disabled={!s.canRedo}
          onClick={act(() => ctrl.redo())}
        >
          <IconRedo />
        </button>
        <span className="snip-sep" />
        <button className="snip-btn" title="贴图 (Ctrl+T / 中键)" onClick={act(() => void ctrl.run("pin"))}>
          <IconPin />
        </button>
        <button className="snip-btn" title="保存 (Ctrl+S)" onClick={act(() => void ctrl.run("save"))}>
          <IconSave />
        </button>
        <button
          className="snip-btn"
          title="复制到剪贴板 (Enter / 双击 / Ctrl+C)"
          onClick={act(() => void ctrl.run("copy"))}
        >
          <IconCopy />
        </button>
        <button className="snip-btn danger" title="取消 (Esc)" onClick={act(() => void ctrl.cancel())}>
          <IconClose />
        </button>
      </div>
    </div>
  );
}
