//! 文字标注输入框。Ctrl+C 等全局键位在这里必须 stopPropagation，
//! 否则输入 "copy" 会触发复制到剪贴板并退出截图（迁移前就是这个坑）。
//!
//! 宽度随内容伸缩（不再固定 140px / 20 字符固有宽）。注意**输入值不在 React 里**：
//! ctrl.pendingTextValue 是控制器的普通字段，onChange 只写它、不 setState，所以每键不重渲染，
//! 宽度只能在按键当下命令式改 DOM —— 别改成 useState，那会多出「组件 state」与「控制器字段」
//! 两份真相，还要重新处理失焦提交与它的抢顺序。

import { useEffect, useLayoutEffect, useRef } from "react";
import { useSyncExternalStore } from "react";
import type { OverlayController } from "../engine/controller";
import { measureTextWidth, textFontFamily } from "../../annotate/textMetrics";

/** 内容宽 → 边框宽的附加值。全局 `* { box-sizing: border-box }`，所以 = 右 padding 5
 *  + 左右各 1px 虚线边框 + 2 给末尾插入符和 italic 的右 overhang
 *  （内容盒恰好等于字形 advance 时，光标压在盒右缘基本看不见）。
 *  **左 padding 必须仍是 0**：那是为了让"框左边缘=点击点=成品文字起点"（见 theme.css）。 */
const PAD = 9;

/** 空框时量占位符：既当默认宽度，也当**地板**（clamp 不能没有地板，见 fit 里那段） */
const PLACEHOLDER = "输入";

export default function TextInput({ ctrl }: { ctrl: OverlayController }) {
  const s = useSyncExternalStore(ctrl.store.subscribe, ctrl.store.get);
  const inputRef = useRef<HTMLInputElement>(null);
  const at = s.pendingTextAt;
  const info = ctrl.chromeInfo;
  // 字号取整一次，DOM 与量宽共用：textFontCss 里对字号做了 Math.round，
  // 若 DOM 仍按 150% 缩放下的 13.333px 排版，两边就系统性差 2.5%，长句末尾的字会被框裁掉
  const fontPx = Math.round(Math.max(12, s.props.fontPx * info.cssScale));

  /** 按当前内容把框宽写进 DOM。一律**现读** ctrl.chromeInfo / ctrl.state：
   *  chromeInfo 是"上一帧的快照"（只在 draw() 末尾整体替换发布），闭包里的 info 更旧，
   *  窗口在打字途中被缩小时混用两者会算出负上限。 */
  const fit = () => {
    const el = inputRef.current;
    const st = ctrl.state;
    if (!el || !st.pendingTextAt) return;
    const i = ctrl.chromeInfo;
    const p = st.props;
    const f = Math.round(Math.max(12, p.fontPx * i.cssScale));
    const o = { bold: p.textBold, italic: p.textItalic, family: p.textFamily };
    const text = ctrl.pendingTextValue || PLACEHOLDER;
    const floor = Math.ceil(measureTextWidth(PLACEHOLDER, f, o)) + PAD;
    const want = Math.ceil(measureTextWidth(text, f, o)) + PAD;
    // 上限夹到**选区**右缘，不是窗口右缘：导出只取选区那块（render.ts 的 clip 语义），
    // 夹到窗口右缘的话，在选区右半边打长句会"提交后少半截字"
    const selRight = i.sel ? i.cssOrigin.x + (i.sel.x + i.sel.w) * i.cssScale : i.winW;
    const left = i.cssOrigin.x + st.pendingTextAt.x * i.cssScale;
    const cap = selRight - 8 - left;
    // **地板必不可少**：紧贴选区右缘点字时 cap 是负数，而 `style.width = "-3px"` 会被 CSSOM
    // 静默丢弃（不报错），框塌回 size=1 的一字符宽，比固定宽度更糟——打中文全在框外滚动看不见
    el.style.width = `${Math.max(floor, cap > floor ? Math.min(want, cap) : floor)}px`;
  };

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
    // 清完 value 再定宽。这个 effect 是 passive，跑在下面的 layout effect **之后**：
    // 若只在 layout 里 fit，一旦同一个 <input> 节点被复用（改成"点别处直接开下一条"就会），
    // 它会按上一条的文字量宽、随后 value 才被清空，框宽永久停在上一条。
    fit();
    return () => cancelAnimationFrame(raf);
  }, [at, ctrl]);

  // 首帧绘制前就把宽度定下来（否则先闪一下浏览器的 20 字符固有宽），
  // 并覆盖"边打字边在属性栏改字号/粗体/斜体/字体"——那些改动会让组件因 store 变更重渲染，
  // 但 onChange 不会触发。必须写在下面的 `if (!at) return null` **之前**：
  // 越过 early return 就是「Rendered more hooks」，而全仓没有 ErrorBoundary，
  // 一 throw 整个 root 卸载 = 透明窗一片空白且鼠标键盘全无反应，只能重开截图。
  useLayoutEffect(fit, [
    at,
    fontPx,
    s.props.textBold,
    s.props.textItalic,
    s.props.textFamily,
  ]);

  if (!at) return null;

  const left = info.cssOrigin.x + at.x * info.cssScale;
  const top = info.cssOrigin.y + at.y * info.cssScale;
  // 深色字配浅底、浅色字配深底：选中黑色时别让字在深半透明底上"隐身"
  const col = s.props.color;
  const lum =
    (0.299 * parseInt(col.slice(1, 3), 16) +
      0.587 * parseInt(col.slice(3, 5), 16) +
      0.114 * parseInt(col.slice(5, 7), 16)) /
    255;

  return (
    /* 输入框**左上角落在点击点**：左边缘对齐靠 padding-left:0（见 theme.css），
       垂直方向靠 translateY(-50%) —— 浏览器的输入框把文字按内容盒垂直居中，
       所以框中心线 = 文字中线 = 点击点那条横线，I 梁光标与框、文字三者同在一条线上。
       提交时 commitText 同样按半个字高补偿 at.y，成品文字才不会比打字时低半行。 */
    <div
      className="snip-textinput"
      style={{
        left: `${left}px`,
        top: `${top}px`,
        fontSize: `${fontPx}px`,
        transform: "translateY(-50%)",
      }}
    >
      <input
        ref={inputRef}
        placeholder={PLACEHOLDER}
        // 固有宽度从默认 20 字符降到 1 字符：万一 layout effect 晚一步，闪出来的是窄框不是宽框
        size={1}
        // 输入期就按当前属性（颜色/粗细/斜体/删除线/字体/字号）渲染，和提交后的图形一致
        style={{
          color: col,
          background: lum < 0.5 ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.55)",
          fontWeight: s.props.textBold ? 700 : 400,
          fontStyle: s.props.textItalic ? "italic" : "normal",
          textDecoration: s.props.textStrike ? "line-through" : "none",
          // 与 canvas 那串**同一条回退链**（textMetrics 导出），否则选的字体没装时
          // DOM 走 Arial、量宽走 Segoe UI，度量差 3–5%，长串必然超框
          fontFamily: textFontFamily(s.props.textFamily),
        }}
        onChange={(e) => {
          ctrl.pendingTextValue = e.target.value;
          fit();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          // 中文输入法组合期间不认 Enter/Escape：Chromium 上"从候选栏选词"那记 Enter 的
          // keydown 早于 compositionend 到达，isComposing 还是 true，不挡就会把拼音
          // （"nihao"）直接落图；Esc 同理本该只收候选词，不挡会连已打的字整框销毁。
          // stopPropagation 必须留在这道守卫**前面**，否则组合期的键会穿透到全局键位。
          if (e.nativeEvent.isComposing) return;
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
