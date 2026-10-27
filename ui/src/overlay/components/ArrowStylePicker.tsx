//! 箭头样式下拉（自绘，**不是原生 `<select>`**）。
//!
//! 为什么不用原生下拉：`<option>` 里只能放文字，装不下 SVG，而四档里的「楔形渐尖」
//! 用任何 Unicode 字形都表达不出来（用户要求：「箭头下拉框中最后一项的文字换成图形，
//! 和其他三个一致」）。自绘之后四档都是同一套 16 框 / 12 单位 / currentColor 的图标
//! （icons.tsx 的 IconArrowNone/Single/Double/Tapered），切样式时只看到"头"在变。
//!
//! 语义仍与老 select 一字不差：**四档 = 无头 / 单箭头(实心三角) / 双箭头(实心三角) /
//! 楔形渐尖**，前两档都是 `arrowHead:"solid"` 只差 `arrowDouble`；`hollow` 不再提供入口，
//! 但历史数据照常渲染（读回来会落到「单箭头」那一档，与老 select 的取值映射一致）。

import { useEffect, useRef, useState, type ComponentType } from "react";
import type { DrawProps } from "../../annotate/model";
import {
  IconArrowDouble,
  IconArrowNone,
  IconArrowSingle,
  IconArrowTapered,
} from "../../shared/icons";

/** 下拉里的四档（顺序 = 菜单里从上到下） */
export type ArrowStyle = "none" | "single" | "double" | "tapered";

const ITEMS: { v: ArrowStyle; name: string; Icon: ComponentType<{ size?: number }> }[] = [
  { v: "none", name: "无箭头直线", Icon: IconArrowNone },
  { v: "single", name: "单箭头（实心三角头）", Icon: IconArrowSingle },
  { v: "double", name: "双箭头（实心三角头）", Icon: IconArrowDouble },
  { v: "tapered", name: "楔形渐尖箭头（尾细头宽、末端尖）", Icon: IconArrowTapered },
];

/** 当前属性 → 下拉选中档（老 select 的 value 映射，原样搬过来） */
export function arrowStyleOf(p: Pick<DrawProps, "arrowHead" | "arrowDouble">): ArrowStyle {
  if (p.arrowHead === "none") return "none";
  if (p.arrowHead === "tapered") return "tapered";
  return p.arrowDouble ? "double" : "single";
}

/** 选中档 → 属性（老 select 的 onChange 映射：前两档都落回 solid 实心三角头） */
export function arrowStyleProps(v: ArrowStyle): Partial<DrawProps> {
  return v === "none"
    ? { arrowHead: "none", arrowDouble: false }
    : v === "double"
      ? { arrowHead: "solid", arrowDouble: true }
      : v === "tapered"
        ? { arrowHead: "tapered", arrowDouble: false }
        : { arrowHead: "solid", arrowDouble: false };
}

/** 菜单总高（4 行 × 26 + 上下 2px 内边距）= 展开方向的判据 */
const MENU_H = 4 * 26 + 4;

export default function ArrowStylePicker({
  value,
  onPick,
}: {
  value: ArrowStyle;
  onPick: (v: ArrowStyle) => void;
}) {
  const [open, setOpen] = useState(false);
  /** 工具栏贴在屏幕下缘时往上弹，否则菜单会被窗口底边切掉半截 */
  const [up, setUp] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const cur = ITEMS.find((i) => i.v === value) ?? ITEMS[1];

  useEffect(() => {
    if (!open) return;
    /* 点外面关菜单。用**捕获**阶段监听：画布的 pointerdown 监听挂在 canvas 上，
       它会把"点在别处"当成定稿当前图形；菜单自己也在 bar 里（bar 的 onPointerDown
       已 stopPropagation），所以只有真的点到 bar 外面才走这里。 */
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    /* Esc 只收菜单、不当"放弃本次截图"：必须捕获阶段 + stopPropagation，
       否则 controller 挂在 window 冒泡上的 Esc 会先收到（那是取消截图） */
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const toggle = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    setUp(!!r && r.bottom + MENU_H + 6 > window.innerHeight);
    setOpen((o) => !o);
  };

  return (
    <span className="snip-asel-wrap" ref={wrapRef}>
      <button
        className={"snip-asel" + (open ? " open" : "")}
        title={`箭头样式：${cur.name}`}
        onClick={toggle}
      >
        <cur.Icon />
        <i className="caret" />
      </button>
      {open && (
        <div className={"snip-amenu" + (up ? " up" : "")}>
          {ITEMS.map(({ v, name, Icon }) => (
            <button
              key={v}
              className={v === value ? "on" : ""}
              title={name}
              onClick={() => {
                onPick(v);
                setOpen(false);
              }}
            >
              <Icon />
            </button>
          ))}
        </div>
      )}
    </span>
  );
}