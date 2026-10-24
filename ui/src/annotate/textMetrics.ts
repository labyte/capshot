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

/** canvas 的 ctx.font 用的完整 shorthand。**字号不再取整**：canvas 接受小数字号，
 *  取整反而会在 1.25 这类分数 dpr 下与 DOM 差一档（18 CSS px = 22.5 物理，四舍五入
 *  到 23 后成品比打字时大 ~2%）。DOM 侧（TextInput）直接用 CSS px 整数字号，绘制/量宽
 *  两侧都走这一个函数拼字体串，同一 dpr 下天然同物理字号。 */
export function textFontCss(fontPx: number, o: TextFontOpts): string {
  return `${o.bold ? "bold " : ""}${o.italic ? "italic " : ""}${fontPx}px ${textFontFamily(o.family)}`;
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

/** 字体盒度量（与传入 fontPx 同单位制）：
 *  - ascent/descent = alphabetic 基线到字体盒顶/底（fontBoundingBox*）；
 *  - **top** = 画布 textBaseline:"top" 的顶线到 alphabetic 基线的真实距离。
 *    无头 Edge 像素标定（32px YaHei UI）：fA=33 而 T=24.39 —— Chromium 的 top 线
 *    **不是** alphabetic−fA，把 T 当 fA 用会让提交后的文字系统性上移 fA−T
 *    （32px 字上移 9px、18px 上移 ~5px，即用户报的"结束后文字上移"）。
 *    T 可无像素解出：top 模式 measureText 的 fontBoundingBoxAscent = fA − T。
 *  commitText 用三者把「Chrome 输入框居中的字体盒中心」换算成绘制端顶线 y。
 *  拿不到 fontBoundingBox*（极老内核）才退回典型值。 */
export function measureFontBox(
  fontPx: number,
  o: TextFontOpts,
): { ascent: number; descent: number; top: number } {
  const f = Math.round(fontPx);
  const fallback = { ascent: f * 0.8, descent: f * 0.2, top: f * 0.6 };
  if (!_ctx) {
    const c = document.createElement("canvas");
    _ctx = c.getContext("2d");
  }
  if (!_ctx) return fallback;
  const font = textFontCss(fontPx, o);
  if (font !== _font) {
    _ctx.font = font;
    _font = font;
  }
  _ctx.textBaseline = "alphabetic";
  const m = _ctx.measureText("M");
  const a = m.fontBoundingBoxAscent;
  const d = m.fontBoundingBoxDescent;
  if (typeof a !== "number" || typeof d !== "number" || !(a > 0) || d < 0) return fallback;
  // top 模式：fontBoundingBoxAscent = 顶线到字体盒顶 = fA − T
  _ctx.textBaseline = "top";
  const topFBA = _ctx.measureText("M").fontBoundingBoxAscent;
  _ctx.textBaseline = "alphabetic";
  const top = typeof topFBA === "number" ? a - topFBA : fallback.top;
  return { ascent: a, descent: d, top };
}
