//! 文字度量的唯一口径。
//!
//! 为什么单独成模块而不是留在 render.ts：render.ts 运行时 import 了 model.ts 的 shapeBounds，
//! 而 model/controller 反过来要用量宽来算文字的 bounds 与命中框 —— 放 render.ts 就是循环依赖。
//!
//! 三处必须共用这一份：绘制（render.ts 的 text 分支）、输入框宽度（overlay/editor 共用的
//! TextInput）、命中框（shapeBounds / hitShape）。任何一方自己拼字体串，就会冒出
//! 「打字看得见、提交后点不中」「框宽比实际排版窄一截」这类对不上号的毛病。

const FONT_STACK = '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

export interface TextFontOpts {
  bold?: boolean;
  italic?: boolean;
  family?: string;
}

/** canvas 的 ctx.font 用的完整 shorthand。**字号在这里取整**，所以 DOM 那边也必须
 *  用同一个已取整的值当 font-size，否则 150% 缩放下一边按 13px 量、一边按 13.333px 排版，
 *  系统性窄 2.5%，长句末尾的字会被框裁掉。 */
export function textFontCss(fontPx: number, o: TextFontOpts): string {
  return `${o.bold ? "bold " : ""}${o.italic ? "italic " : ""}${Math.round(fontPx)}px ${textFontFamily(o.family)}`;
}

/** 给 DOM 的 `style.fontFamily` 用的**纯 family list**（不含 bold/italic/字号——那三段
 *  塞进 fontFamily 是无效声明，浏览器会整条丢弃，输入框就退回继承 body 的字体）。
 *  必须与 canvas 那串的回退链一字不差：TextInput 原先写的是 `"${family}", sans-serif`，
 *  而选的字体族（KaiTi/SimSun 之类）在英文版/精简版 Windows 上可能没装，
 *  此时 Arial 与 Segoe UI 的拉丁字形度量差 3–5%，量出来的宽度就靠不住。 */
export function textFontFamily(family?: string): string {
  return `${family ? `"${family}", ` : ""}${FONT_STACK}`;
}

/** 懒建的游离 canvas：只为拿一个 2d context 来 measureText。
 *  每次按键都 createElement 一次是白扔一帧（照 cursorImage.ts 的 BLANK_URL 那套「只建一次」） */
let _ctx: CanvasRenderingContext2D | null = null;
let _font = "";

/** 量的宽度与传进去的 fontPx **同单位制**：DOM 侧传 CSS px，命中框侧传设备 px，各自都对。
 *  单位换算不该在这里做，谁调用谁负责喂自己坐标系里的字号。 */
export function measureTextWidth(text: string, fontPx: number, o: TextFontOpts): number {
  if (!text) return 0;
  if (!_ctx) {
    const c = document.createElement("canvas");
    _ctx = c.getContext("2d");
    if (!_ctx) return text.length * Math.round(fontPx) * 0.6; // 拿不到 2d（异常环境）才退回老的猜式
  }
  const font = textFontCss(fontPx, o);
  if (font !== _font) {
    _ctx.font = font;
    _font = font;
  }
  return _ctx.measureText(text).width;
}
