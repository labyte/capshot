//! 工具条图标。统一规格（用户验收定死的三件事）：
//! · 大小：主形状占 16 viewBox 里的 ~12×12 视觉框（2..14），不再有的 8 有的 13
//! · 线：strokeWidth 1.33、round cap/join（lucide 量级，24 稿 ÷1.5 换算）
//! · 色：一律 currentColor，深浅完全跟随 CSS（.snip-btn / .card-acts button）
//! 参考稿（24 系）逐点 ÷1.5 落进 16 框；纯几何图形（马赛克格线等）按 12 框重排。
//!
//! **别在这里改尺寸找齐参照图**：截图层两条 bar 的图标实际渲染 18px
//! （theme.css `.snip-bar svg`），12 单位视觉框因此落到 13.5px，正是参照图实测的
//! 13–15px。图标自身仍按 16 viewBox / 12 单位画，改的是造型不是刻度。

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.33}
      strokeLinecap="round"
      strokeLinejoin="round"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 属性栏「矩形」项：参照图实测是**横向矩形**（16×12px），不是正方形 */
export const IconRect = (p: P) => (
  <Svg {...p}>
    <rect x="1.6" y="3" width="12.8" height="10" rx="1" ry="1" />
  </Svg>
);

/** 形状工具（主工具条合并按钮）：**横向矩形 + 椭圆压在右下角**。
    参照图实测两个都不是正方/正圆：矩形 13×11、椭圆 14×9 —— 之前我照"正方形+圆"画是错的。
    椭圆完整、矩形被遮的那段角不画（开口折线），不能用底色去遮：选中态整格变蓝，遮罩色对不上 */
export const IconShapes = (p: P) => (
  <Svg {...p}>
    <path d="M10 6.9V2.6H2.4v6.6h4.4" />
    <ellipse cx="10.5" cy="9.8" rx="3.6" ry="2.7" />
  </Svg>
);

export const IconEllipse = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
  </Svg>
);

/* 填充项图标不在这里：参照图实测它是**网点形状**（1px 点 / 2px 周期棋盘），
   由 theme.css 的 `.snip-dither` 用 conic-gradient 画，形状切换换 class 即可。
   与记号笔/橡皮擦/马赛克「矩形模式」的网点格共用同一套画法。 */

/* 以下 transform 是「实测包围盒校准」：getBBox 量出视觉尺寸后统一缩到 12–13 带，
   strokeWidth 反向补偿（1.33/scale）保持视觉线宽一致 */
/** 箭头工具：参照图放大看是**折线杆（上-下-上）+ 末端一个实心三角头**，
 *  不是直线双头箭。折线表达的是"箭头可以随手画弯"，杆末端藏进头部里 */
export const IconArrow = (p: P) => (
  <Svg {...p} strokeWidth={1.4}>
    <path d="M2.6 11.4 6.2 7.4 8.2 9.6 11.3 5.5" />
    <path d="M13.8 3 12.9 7 9.8 3.9Z" fill="currentColor" stroke="none" />
  </Svg>
);

/* 箭头样式的四个图标（属性栏那个下拉）：四档 = 无头直线 / 实心三角单端 / 实心三角双端 /
   楔形渐尖。**统一在 16 框里画 12 单位长的箭**（x 2→14、箭脊 y=8），四条同长同重，
   切样式时肉眼只看到"头"变了；单/双的头是**实心三角**、与画布上真画的那个头同形，
   楔形是单填充多边形（尾细头宽，照 render.ts 的 tapered 造型等比缩进 12 单位框）。
   为什么要有这套图标：原生 `<option>` 只能放文字，`楔形` 那档用任何 Unicode 字形都表达不出来
   （用户要求「最后一项的文字换成图形，和其他三个一致」）—— 所以那个下拉改自绘，见 ArrowStylePicker。 */
/** 头长（尖到等腰三角的底）、头半高：单/双的实心三角头 */
const AH_L = 3.2;
const AH_H = 2.1;
/** 单/双共用的实心三角头：`x` = 三角底所在横坐标，`dir` = 箭尖朝向（右 +1 / 左 -1） */
const ArrowHeadIcon = ({ x, dir }: { x: number; dir: 1 | -1 }) => (
  <path
    d={`M${x + dir * AH_L} 8 L${x} ${8 - AH_H} L${x} ${8 + AH_H} Z`}
    fill="currentColor"
    stroke="none"
  />
);

export const IconArrowNone = (p: P) => (
  <Svg {...p}>
    <path d="M2 8h12" />
  </Svg>
);

export const IconArrowSingle = (p: P) => (
  <Svg {...p}>
    {/* 杆一路画到 12（伸进三角头里）：平头杆若停在头的底面 x=10.8，抗锯齿会在接缝上
        留一道浅痕；伸进去那截被头盖住。与画布那套「杆缩到头部底面以内」同一处理 */}
    <path d="M2 8h10" />
    <ArrowHeadIcon x={14 - AH_L} dir={1} />
  </Svg>
);

export const IconArrowDouble = (p: P) => (
  <Svg {...p}>
    <path d="M4 8h8" />
    <ArrowHeadIcon x={14 - AH_L} dir={1} />
    <ArrowHeadIcon x={2 + AH_L} dir={-1} />
  </Svg>
);

export const IconArrowTapered = (p: P) => (
  <Svg {...p}>
    {/* 尾端收成一点 → 杆线性渐宽到头的底面 → 再让开一个实心三角头。
        三处比例照画布那套：头/杆在底面处的半高比 = 2.1 / 0.7 = 3 (= 画布
        「头宽 = 杆头宽 3 倍」)，头本身与单/双同长同高（12 单位里再按真比例画会糊） */}
    <path
      d={`M2 8 L${14 - AH_L} ${8 - 0.7} L${14 - AH_L} ${8 - AH_H} L14 8 L${14 - AH_L} ${8 + AH_H} L${14 - AH_L} ${8 + 0.7} Z`}
      fill="currentColor"
      stroke="none"
    />
  </Svg>
);

/** 画笔：铅笔造型（lucide pencil，校准缩放 0.85） */
export const IconPen = (p: P) => (
  <Svg {...p} strokeWidth={1.56}>
    <g transform="translate(1.2 1.2) scale(0.85)">
      <path d="M11.33 2a1.9 1.89 0 1 1 2.67 2.67L5 13.67 1.33 14.67l1-3.67Z" />
      <path d="M10 3.33l2.67 2.67" />
    </g>
  </Svg>
);

/** 马克笔：荧光笔斜握 + 笔帽分离（lucide highlighter，校准缩放 0.9） */
export const IconMarker = (p: P) => (
  <Svg {...p} strokeWidth={1.48}>
    <g transform="translate(0.8 0.8) scale(0.9)">
      <path d="M6 7.33 2 11.33v2h6l2-2" />
      <path d="M14.67 8l-3.07 3.07a1.33 1.33 0 0 1-1.87 0L6.27 7.6a1.33 1.33 0 0 1 0-1.87l3.06-3.06" />
    </g>
  </Svg>
);

/** 文字：参照图实测就是最朴素的 T——顶横 12×2、竖干 2×13，无衬线无圆头 */
export const IconText = (p: P) => (
  <Svg {...p} strokeWidth={2}>
    <path d="M2.8 3.2h10.4M8 3.2v10.2" />
  </Svg>
);

/**
 * 打码样式的两个图标（马赛克属性栏里是**同一个按钮的两种态**，不是两个互斥按钮）：
 * 都吃 `level`，粒度一变图标本身就跟着变 —— 马赛克看格子粗细、模糊看波纹起伏。
 */
export const IconMosaic = ({ level = 8, ...p }: P & { level?: number }) => {
  // 参照图实测：方框内棋盘格。level 越大格越粗 → 每边格数递减
  const n = Math.max(2, Math.min(6, 7 - Math.round(level / 7)));
  const cell = 11.6 / n;
  const cells = [];
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++)
      if ((r + c) % 2 === 0)
        cells.push(
          <rect
            key={`${r}x${c}`}
            x={2.2 + c * cell}
            y={2.2 + r * cell}
            width={cell}
            height={cell}
            fill="currentColor"
            stroke="none"
          />,
        );
  return (
    <Svg {...p}>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="1" ry="1" />
      {cells}
    </Svg>
  );
};

export const IconBlur = ({ level = 8, ...p }: P & { level?: number }) => {
  // 波纹起伏与线宽随模糊半径变大，拖动滑块时"糊"的程度当场可见
  const a = Math.max(1, Math.min(2.8, 0.9 + level / 16));
  return (
    <Svg {...p} strokeWidth={1 + a * 0.25}>
      {[4.5, 8, 11.5].map((y) => (
        <path key={y} d={`M2.5 ${y} c1.8 ${-a} 3.7 ${a} 5.5 0 s3.7 ${a} 5.5 0`} />
      ))}
    </Svg>
  );
};

export const IconStep = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.4 5.5H8v5.1M6.2 10.6h3.6" strokeWidth={1.2} />
  </Svg>
);

/* 撤销/重做：参照图实测是**实心**弯箭头（14×15），所以头部用实心三角、
   尾巴用加粗描边；比工具图标浅一档的墨色由 .snip-btn.muted 给 */
export const IconUndo = (p: P) => (
  <Svg {...p} strokeWidth={2.1}>
    <path d="M6.6 5.7h3.1a2.7 2.7 0 0 1 0 5.4H7.1" />
    <path d="M9.1 2.5 4.6 6.15 9.1 9.8Z" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconRedo = (p: P) => (
  <Svg {...p} strokeWidth={2.1}>
    <path d="M9.4 5.7H6.3a2.7 2.7 0 0 0 0 5.4h2.6" />
    <path d="M6.9 2.5 11.4 6.15 6.9 9.8Z" fill="currentColor" stroke="none" />
  </Svg>
);

/** 图钉：实心 + 45° 斜插（钉尖朝左下）。旋转后包围盒达 16，再缩 0.88 压回 12.5 */
export const IconPin = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <g transform="translate(8 8) scale(0.88) translate(-8 -8) rotate(45 8 8)">
      <path d="M5.33 1.33h5.34a1.33 1.33 0 0 1 0 2.67H10v3.18a1.33 1.33 0 0 0 .74 1.19l1.19.6a1.33 1.33 0 0 1 .74 1.19v1.17H3.33v-1.17a1.33 1.33 0 0 1 .74-1.19l1.19-.6a1.33 1.33 0 0 0 .74-1.19V4h-.67a1.33 1.33 0 0 1 0-2.67Z" />
      <path d="M7.35 11.33h1.3L8 14.8Z" />
    </g>
  </Svg>
);

/** 软盘（存盘）：参照图是**实心**盘体 + 两处白窗（上方快门槽、下方标签带），
 *  用 evenodd 把两个窗挖出来，选中蓝格上窗就是蓝的，不用为状态另写颜色 */
export const IconSave = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path
      fillRule="evenodd"
      d="M2.2 2.2h8.8l2.8 2.8v8.8H2.2Z M5.8 3h3.6v3.2H5.8Z M4.6 9.2h6.8v3.6H4.6Z"
    />
  </Svg>
);

/** 后方 L 形 + 前方空心框（复制） */
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.4" y="5.4" width="8.2" height="8.2" />
    <path d="M10.6 5.4V2.4H2.4v8.2h3" opacity=".8" />
  </Svg>
);

/** 关闭：参照图实测臂厚约 2px、X 本体 10×10 */
export const IconClose = (p: P) => (
  <Svg {...p} strokeWidth={1.9}>
    <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
  </Svg>
);

/** 橡皮擦：用户指定的 iconfont 资产，1024 viewBox 实心 path 原样呈现，
    fill=currentColor 保证颜色仍与其他图标一致 */
export const IconEraser = (p: P) => (
  /* viewBox 按内容包围盒(867×888 @1024)居中留白，渲染到 12.5 单位 */
  <Svg {...p} viewBox="-46.4 -52.6 1136.2 1136.2" fill="currentColor" stroke="none">
    <path d="M953.173333 259.413333l-187.733333-187.733333c-38.826667-38.826667-101.973333-38.826667-140.8 0L115.2 581.546667c-18.773333 18.773333-29.013333 43.946667-29.013333 70.4 0 26.453333 10.24 51.626667 29.013333 70.4l187.733333 187.733333c18.773333 18.773333 43.946667 29.013333 70.4 29.013333 26.453333 0 51.626667-10.24 70.4-29.013333L953.173333 400.213333a99.84 99.84 0 0 0 0-140.8zM383.573333 849.493333c-7.253333 7.253333-12.8 7.253333-20.053333 0l-187.733333-187.733333a14.805333 14.805333 0 0 1-4.266667-10.24c0-2.133333 0.426667-6.4 4.266667-10.24l180.906666-180.906667c2.56 4.266667 4.266667 8.533333 8.106667 11.946667l187.733333 187.733333c3.413333 3.413333 8.106667 5.546667 11.946667 8.106667l-180.906667 181.333333z" />
  </Svg>
);

export const IconThrough = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.875" />
    <path d="M4 12 12 4" />
  </Svg>
);

export const IconFolder = (p: P) => (
  <Svg {...p}>
    <path d="M2.4 4.4h3.6l1.2 1.6h6.4v7.2H2.4z" />
  </Svg>
);

export const IconTrash = (p: P) => (
  <Svg {...p}>
    <path d="M3.4 5h9.2" />
    <path d="M6.2 5V3.4h3.6V5" />
    <path d="M4.6 5l.6 9h5.6l.6-9" />
    <path d="M7 7.4v4.4M9 7.4v4.4" opacity=".6" />
  </Svg>
);

export const IconEdit = (p: P) => (
  <Svg {...p}>
    <path d="M2.6 13.4l.8-3 7.1-7.1 2.2 2.2-7.1 7.1z" />
    <path d="M11.4 2.4l2.2 2.2" />
  </Svg>
);

export const IconMore = (p: P) => (
  <Svg {...p}>
    <circle cx="3.5" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="12.5" cy="8" r="1" fill="currentColor" stroke="none" />
  </Svg>
);
