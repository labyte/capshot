//! 文字标注输入框。Ctrl+C 等全局键位在这里必须 stopPropagation，
//! 否则输入 "copy" 会触发复制到剪贴板并退出截图（迁移前就是这个坑）。
//!
//! **Enter 换行、Ctrl+Enter 提交**（用户要求，Snipaste 同）：多行靠 <textarea> 的默认
//! 换行行为，本组件只在 Ctrl+Enter 上 preventDefault 去 commitText；Escape 仍整框丢弃。
//! 多行意味着宽要按**最宽一行**量、高要按**行数 × 行高**写死（行高系数 textMetrics.TEXT_LINE_H，
//! 与绘制/命中框共用），详见 fit() 与两个盒模型常数（PAD / 上内边距+边框 = 3）。
//!
//! 宽度随内容伸缩（不再固定 140px / 20 字符固有宽）。注意**输入值不在 React 里**：
//! ctrl.pendingTextValue 是控制器的普通字段，onChange 只写它、不 setState，所以每键不重渲染，
//! 宽度/高度只能在按键当下命令式改 DOM —— 别改成 useState，那会多出「组件 state」与「控制器字段」
//! 两份真相，还要重新处理失焦提交与它的抢顺序。
//!
//! 手柄布局参照 Snipaste 录屏/截图：实线边框 + 四角手柄（左上/左下/右下 = 拉伸改字号，
//! 右上 = 关闭）+ 顶心旋转手柄；**整体拖动只在框边 8px 抓取带上**（.snip-ti-ring，
//! cursor:move），文本区是输入态——按下落插入符、I 梁光标（浏览器默认行为不拦）；
//! 滚轮（中键滚轮）调字号，与画布 onWheel 的输入态分支同一入口 ctrl.bumpFont。

import { useEffect, useLayoutEffect, useRef, type PointerEvent as RPointerEvent } from "react";
import { useSyncExternalStore } from "react";
import type { OverlayController } from "../engine/controller";
import { cursorUrl } from "../engine/cursorImage";
import { measureTextWidth, TEXT_LINE_H, textFontFamily } from "../../annotate/textMetrics";

/** 旋转手柄的 hover 光标：环形箭头（cursorImage 生成，白芯黑边任何底可读），
 *  CSS 没有原生 rotate 光标，grab 语义是"拖拽"而非"旋转" */
const ROTATE_CURSOR = cursorUrl("rotate", 0, "#fff");

/** 内容宽 → 边框宽的附加值。全局 `* { box-sizing: border-box }`，所以 = 右 padding 5
 *  + 左右各 1px 实线边框 + 2 给末尾插入符和 italic 的右 overhang
 *  （内容盒恰好等于字形 advance 时，光标压在盒右缘基本看不见）。
 *  **左 padding 必须仍是 0**：那是为了让"框左边缘=点击点=成品文字起点"（见 theme.css）。 */
const PAD = 9;

/** 空框时量占位符：既当默认宽度，也作为**地板**（clamp 不能没有地板，见 fit 里那段） */
const PLACEHOLDER = "输入";

/** 角拉伸图标：NW-SE 双头对角箭头（对角线 = 角↔对角连线）。不用 Unicode ⤢/⤡——
 *  那组字符在不同字体里渲染角度不可控（用户报"三个缩放图标角度错了"）；
 *  BL 角的对角线是 NE-SW，把基准图标转 90° 即可 */
function StretchIcon({ deg }: { deg: number }) {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" style={{ transform: `rotate(${deg}deg)` }} aria-hidden>
      <path
        d="M3 3 L9 9 M3 3 L3 5.5 M3 3 L5.5 3 M9 9 L9 6.5 M9 9 L6.5 9"
        fill="none"
        stroke="#fff"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** 拖动的 8px 抓取带以框边线为中心（外 4 + 内 4），见 theme.css 的 .snip-ti-ring */

export default function TextInput({ ctrl }: { ctrl: OverlayController }) {
  const s = useSyncExternalStore(ctrl.store.subscribe, ctrl.store.get);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const at = s.pendingTextAt;
  const rot = s.pendingTextRot;
  const info = ctrl.chromeInfo;
  /* DOM 字号直接 = props.fontPx：它本来就是 CSS px（FONT_SIZES 的约定），canvas 绘制端
     按 fontPx × scale 物理落图，显示回来恰好就是 fontPx CSS px —— 两边在任何 dpr 下
     都是同一物理字号，不需要也不允许再乘 cssScale。
     旧式 round(fontPx × cssScale) 是把 CSS 值又除了一遍 dpr（cssScale = CSS/物理）：
     150% 缩放下 18px 的字打字时只按 12px 排版，提交后 canvas 按 18px 落图，字号瞬间
     放大 1.5 倍 —— 这才是"提交瞬间文字跳一下"的主成分；dpr=1 时两式巧合相等，
     所以这个错在浏览器 mock 里从来测不出来。 */
  const fontPx = s.props.fontPx;

  /** 按当前内容把框宽/框高写进 DOM。一律**现读** ctrl.chromeInfo / ctrl.state：
   *  chromeInfo 是"上一帧的快照"（只在 draw() 末尾整体替换发布），闭包里的 info 更旧，
   *  窗口在打字途中被缩小时混用两者会算出负上限。
   *  多行（Enter 换行）：宽取**最宽一行**、高 = 行数 × 行高（行高 = fontPx × TEXT_LINE_H，
   *  与绘制端同一系数，见 textMetrics）。 */
  const fit = () => {
    const el = inputRef.current;
    const st = ctrl.state;
    if (!el || !st.pendingTextAt) return;
    const i = ctrl.chromeInfo;
    const p = st.props;
    const f = p.fontPx; // CSS px，与 DOM fontSize 同值（见组件顶部注释）
    const o = { bold: p.textBold, italic: p.textItalic, family: p.textFamily };
    const lines = ctrl.pendingTextValue.split("\n");
    const widths = lines.map((l) => measureTextWidth(l, f, o));
    const floor = Math.ceil(measureTextWidth(PLACEHOLDER, f, o)) + PAD;
    const want = Math.ceil(Math.max(0, ...widths)) + PAD;
    // 上限夹到**选区**右缘，不是窗口右缘：导出只取选区那块（render.ts 的 clip 语义），
    // 夹到窗口右缘的话，在选区右半边打长句会"提交后少半截字"
    const selRight = i.sel ? i.cssOrigin.x + (i.sel.x + i.sel.w) * i.cssScale : i.winW;
    const left = i.cssOrigin.x + st.pendingTextAt.x * i.cssScale;
    const cap = selRight - 8 - left;
    // **地板必不可少**：紧贴选区右缘点字时 cap 是负数，而 `style.width = "-3px"` 会被 CSSOM
    // 静默丢弃（不报错），框塌回 size=1 的一字符宽，比固定宽度更糟——打中文全在框外滚动看不见
    el.style.width = `${Math.max(floor, cap > floor ? Math.min(want, cap) : floor)}px`;
    /* 高度按行数写死（行数不靠 `rows` 属性算：rows→高度的换算各内核口径不同，
        唯一可靠的是自己按 line-height 乘出来）。加 6 = 上下各 2px 内边距 + 1px 边框
        （全局 border-box），与 theme.css 的 `.snip-textinput textarea` padding 一处对齐 ——
        改那边必须回来改这里，否则框与文字会错位。 */
    el.style.height = `${lines.length * f * TEXT_LINE_H + 6}px`;
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
    // 依赖是**会话 id 而不是 at**：拖动框体每次都生成新的 at 引用，认 at 的话
    // 每挪一下这里就重跑、把已输入的内容清空（拖动后文字消失就是这个坑）
  }, [s.pendingTextId, ctrl]);

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

  /** 屏幕坐标下的未旋转盒角：wrapper 的 getBoundingClientRect 给的是旋转后 bbox，
   *  拉伸比例的锚点必须落在**真角**上，所以用中心 + R(rot)·(±w/2, ±h/2) 反算。
   *  旋转绕盒中心进行，中心在旋转前后不动 = bbox 中心。 */
  const corner = (sx: 1 | -1, sy: 1 | -1) => {
    const el = wrapRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const co = Math.cos(rot);
    const si = Math.sin(rot);
    const dx = (sx * el.offsetWidth) / 2;
    const dy = (sy * el.offsetHeight) / 2;
    return { x: cx + dx * co - dy * si, y: cy + dx * si + dy * co };
  };

  /** 给手柄 span 挂"捕获期间的 move/up"：pointer capture 让事件继续打在手柄上，
   *  拖出框外也不丢；preventDefault 保住 input 的焦点（手柄不该抢焦）。 */
  const dragOn = (el: HTMLElement, move: (ev: PointerEvent) => void) => {
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  /** 角拉伸：以对角为锚，距离比 = 字号比（框高本就正比于字号，拉框即改字） */
  const startStretch = (hx: 1 | -1, hy: 1 | -1) => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const font0 = ctrl.state.props.fontPx;
    const anchor = corner(-hx as 1 | -1, -hy as 1 | -1);
    const d0 = Math.max(8, Math.hypot(e.clientX - anchor.x, e.clientY - anchor.y));
    dragOn(el, (ev) => {
      const d = Math.max(8, Math.hypot(ev.clientX - anchor.x, ev.clientY - anchor.y));
      ctrl.setFontPx(font0 * (d / d0));
    });
  };

  /** 顶心旋转手柄：指针绕盒中心的角度增量叠加到当前 rot */
  const startRot = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
    const rot0 = ctrl.state.pendingTextRot;
    dragOn(el, (ev) => {
      ctrl.setPendingTextRot(rot0 + Math.atan2(ev.clientY - cy, ev.clientX - cx) - a0);
    });
  };

  /** **边缘带拖动**：只有框边（8px 抓取带）触发——文本区是输入态（按下落插入符，
   *  交给浏览器默认行为），拖框必须站到边上。preventDefault 保住 input 的焦点
   *  （ring 在 input 层叠之上，点它不该把焦点丢给 body）；增量按 cssScale 换物理 px。 */
  const onRingPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = inputRef.current;
    if (el && document.activeElement !== el) el.focus({ preventScroll: true });
    let lx = e.clientX;
    let ly = e.clientY;
    const move = (ev: PointerEvent) => {
      const k = ctrl.chromeInfo.cssScale || 1;
      ctrl.movePendingText((ev.clientX - lx) / k, (ev.clientY - ly) / k);
      lx = ev.clientX;
      ly = ev.clientY;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!at) return null;

  const left = info.cssOrigin.x + at.x * info.cssScale;
  /* 竖直锚点：**第一行的中线压在点击点那条横线上**（不是整框居中）。
     多行时框只往下长，首行不动 —— 否则每按一次 Enter 整框就向上跳半行。
     算式：内容盒顶 = 点击点 − 行高/2；再减去上边框 1 + 上内边距 2 才是盒顶
     （那两个数与 theme.css 的 `.snip-textinput textarea` 一处对齐，改那边要回来改这里）。
     提交端 commitText 的换算式仍按"首行字体盒中心 = 点击点"，所以第 k 行自然落在
     `at.y + k × 行高`（行高系数 TEXT_LINE_H 三方共用），打字与成品逐行对齐。 */
  const lineH = fontPx * TEXT_LINE_H;
  const top = info.cssOrigin.y + at.y * info.cssScale - lineH / 2 - 3;
  const col = s.props.color;

  return (
    /* 输入框**左上角落在点击点**：左边缘对齐靠 padding-left:0（见 theme.css），
       竖直方向见上面 lineH/top 的算式（首行中线 = 点击点）。
       提交时 commitText 按 fontBoundingBox 实测换算同一条中线（不是"半个字高"的
       猜式），并补回 1px 边框的横向差，成品字形与打字时逐像素对齐、不跳位。
       旋转：transform-origin 默认盒中心 = 多行时整块的盒中心，与绘制端
       （shapeBounds 的 at + (w/2, h/2)）同一中心，手柄随框一起转。 */
    <div
      ref={wrapRef}
      className="snip-textinput"
      onWheel={(e) => {
        // 滚轮（中键滚轮）在框上 = 调字号；画布那侧的输入态分支走同一入口
        e.stopPropagation();
        ctrl.bumpFont(e.deltaY < 0 ? 1 : -1);
      }}
      style={{
        left: `${left}px`,
        top: `${top}px`,
        fontSize: `${fontPx}px`,
        // 行高必须与绘制端同系数（TEXT_LINE_H）：DOM 每行多高 = canvas 每行下移多少
        lineHeight: `${lineH}px`,
        transform: rot ? `rotate(${rot}rad)` : undefined,
      }}
    >
      {/* 拖动抓取带（四条，合围框边、中间透空）：只有这里触发整体拖动；
          文本区归 input —— 按下落插入符是输入态。放在 input 之前渲染：
          绝对定位层叠天然盖住普通流的 input，但又被后面的角手柄盖住 */}
      <span className="snip-ti-ring snip-ti-ring-t" onPointerDown={onRingPointerDown} />
      <span className="snip-ti-ring snip-ti-ring-b" onPointerDown={onRingPointerDown} />
      <span className="snip-ti-ring snip-ti-ring-l" onPointerDown={onRingPointerDown} />
      <span className="snip-ti-ring snip-ti-ring-r" onPointerDown={onRingPointerDown} />
      <textarea
        ref={inputRef}
        placeholder={PLACEHOLDER}
        // 固有宽度从默认 20 字符降到 1 字符：万一 layout effect 晚一步，闪出来的是窄框不是宽框
        cols={1}
        rows={1}
        /* wrap="off"：**不做软换行**。行数只能由显式换行决定，浏览器再软折一行就与
           canvas 画的行数对不上（高度、命中框全乱）。超宽的行走横向滚动，
           与旧 <input> 的行为一致。 */
        wrap="off"
        spellCheck={false}
        // 输入期就按当前属性（颜色/粗细/斜体/删除线/字体/字号）渲染，和提交后的图形一致
        style={{
          color: col,
          // 背景不设内联值：全透明基底在 theme.css（.snip-textinput textarea），
          // 输入框只靠实线边框示意，打字时不遮挡底下的截图内容
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
          // keydown 早于 compositionend 到达，isComposing 还是 true，不拦会连 Ctrl+Enter
          // 一起当提交；Esc 同理本该只收候选词，不拦会连已打的字整框销毁。
          // stopPropagation 必须留在这道守卫**前面**，否则组合期的键会穿透到全局键位。
          if (e.nativeEvent.isComposing) return;
          /* **Enter = 换行**（用户要求，Snipaste 同）：交给 textarea 的默认行为，
             不 preventDefault，onChange 会跟着重算宽高。提交改到 Ctrl+Enter，
             另外点框外/切工具/导出前的快捷键也都会先 commitText（那条链路没变）。 */
          if (e.key === "Enter") {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              ctrl.commitText();
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            ctrl.cancelText();
          }
        }}
      />
      {/* 四角手柄：左上/左下/右下拉伸（同时改字号），右上关闭（丢弃本条输入）。
          拉伸图标自绘 SVG（NW-SE 双头对角箭头），不用 Unicode ⤢/⤡ —— 那组字符在
          常见字体里渲染角度不可控；BL 角的对角线是 NE-SW，转 90° 得到 */}
      <span className="snip-ti-h snip-ti-tl" title="拉伸（改字号）" onPointerDown={startStretch(-1, -1)}>
        <StretchIcon deg={0} />
      </span>
      <span className="snip-ti-h snip-ti-bl" title="拉伸（改字号）" onPointerDown={startStretch(-1, 1)}>
        <StretchIcon deg={90} />
      </span>
      <span className="snip-ti-h snip-ti-br" title="拉伸（改字号）" onPointerDown={startStretch(1, 1)}>
        <StretchIcon deg={0} />
      </span>
      <span
        className="snip-ti-h snip-ti-close"
        title="关闭（丢弃本条输入）"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          ctrl.cancelText();
        }}
      >
        ✕
      </span>
      <span
        className="snip-ti-h snip-ti-rot"
        title="旋转"
        style={{ cursor: ROTATE_CURSOR }}
        onPointerDown={startRot}
      >
        ⟳
      </span>
    </div>
  );
}
