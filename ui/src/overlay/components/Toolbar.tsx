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
  IconEllipse,
  IconMarker,
  IconMosaic,
  IconPin,
  IconPolyline,
  IconRect,
  IconRedo,
  IconSave,
  IconStep,
  IconText,
  IconUndo,
} from "../../shared/icons";

const TOOLS: { id: ToolId; label: string; key: string; Icon: typeof IconRect }[] = [
  { id: "rect", label: "矩形", key: "V", Icon: IconRect },
  { id: "ellipse", label: "椭圆", key: "O", Icon: IconEllipse },
  { id: "arrow", label: "箭头", key: "P", Icon: IconArrow },
  { id: "polyline", label: "折线", key: "L", Icon: IconPolyline },
  { id: "marker", label: "马克笔", key: "M", Icon: IconMarker },
  { id: "text", label: "文字", key: "T", Icon: IconText },
  { id: "mosaic", label: "马赛克", key: "X", Icon: IconMosaic },
  { id: "step", label: "序号", key: "N", Icon: IconStep },
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
        {TOOLS.map(({ id, label, key, Icon }) => (
          <button
            key={id}
            className={"snip-btn" + (s.tool === id ? " on" : "")}
            title={`${label} (${key})`}
            onClick={act(() => ctrl.setTool(s.tool === id ? null : id))}
          >
            <Icon />
          </button>
        ))}
        <span className="snip-sep" />
        <button
          className="snip-btn"
          title="撤销 (Ctrl+Z)"
          disabled={!s.canUndo}
          onClick={act(() => ctrl.undo())}
        >
          <IconUndo />
        </button>
        <button
          className="snip-btn"
          title="重做 (Ctrl+Y)"
          disabled={!s.canRedo}
          onClick={act(() => ctrl.redo())}
        >
          <IconRedo />
        </button>
        <span className="snip-sep" />
        <button className="snip-btn accent" title="贴图 (Ctrl+T / 中键)" onClick={act(() => void ctrl.run("pin"))}>
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
        <button className="snip-chip" title="复制到剪贴板并保存" onClick={act(() => void ctrl.run("copySave"))}>
          复制+存
        </button>
        <button className="snip-btn danger" title="取消 (Esc)" onClick={act(() => void ctrl.cancel())}>
          <IconClose />
        </button>
      </div>
    </div>
  );
}
