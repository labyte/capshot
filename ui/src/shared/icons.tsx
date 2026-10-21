//! 工具条图标。统一规格（用户验收定死的三件事）：
//! · 大小：主形状占 16 viewBox 里的 ~12×12 视觉框（2..14），不再有的 8 有的 13
//! · 线：strokeWidth 1.33、round cap/join（lucide 量级，24 稿 ÷1.5 换算）
//! · 色：一律 currentColor，深浅完全跟随 CSS（.snip-btn / .card-acts button）
//! 参考稿（24 系）逐点 ÷1.5 落进 16 框；纯几何图形（马赛克格线等）按 12 框重排。

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

export const IconRect = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="2" width="12" height="12" rx="1.33" ry="1.33" />
  </Svg>
);

/** 形状工具：圆角矩形 + 圆叠加（主工具条的合并按钮） */
export const IconShapes = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="5" width="8.5" height="8.5" rx="1.2" ry="1.2" />
    <circle cx="10.75" cy="6.25" r="3.25" />
  </Svg>
);

export const IconEllipse = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
  </Svg>
);

/* 以下 transform 是「实测包围盒校准」：getBBox 量出视觉尺寸后统一缩到 12–13 带，
   strokeWidth 反向补偿（1.33/scale）保持视觉线宽一致 */
export const IconArrow = (p: P) => (
  <Svg {...p} strokeWidth={1.4}>
    <g transform="translate(0.4 0.4) scale(0.95)">
      <path d="M3 13 13 3" />
      <path d="M7 3h6v6" />
    </g>
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

/** 文本：iconfont 的 T 字形（横杠 + 竖干，圆头实心）。1024 稿按内容包围盒
    (746×781) 居中留白压到 ~12 视觉框，实心走 currentColor */
export const IconText = (p: P) => (
  <Svg {...p} viewBox="-8.65 -9.15 1041.3 1041.3" fill="currentColor" stroke="none">
    <path d="M885.005342 152.185075c0 16.95823-13.750165 30.707372-30.709419 30.707372L169.703053 182.892447c-16.95823 0-30.708396-13.749142-30.708396-30.707372l0 0c0-16.959254 13.750165-30.708396 30.708396-30.708396l684.59287 0C871.255177 121.475656 885.005342 135.224798 885.005342 152.185075L885.005342 152.185075 885.005342 152.185075zM512.002047 902.523321c-16.963347 0-30.708396-13.745049-30.708396-30.707372L481.293651 153.189961c0-16.959254 13.746072-30.708396 30.708396-30.708396l0 0c16.95823 0 30.704302 13.749142 30.704302 30.708396l0 718.630081C542.706349 888.778272 528.960277 902.523321 512.002047 902.523321L512.002047 902.523321 512.002047 902.523321z" />
  </Svg>
);

/** 马赛克：用户指定的 iconfont 资产（1024 viewBox，圆角框 + 旋涡切块）。
    资产原稿 path 上写死的 #000000 已去掉，颜色统一走 currentColor */
export const IconMosaic = (p: P) => (
  /* viewBox 四周留白：原稿内容满幅 1024，直接渲染=16 单位，压到 12 */
  <Svg {...p} viewBox="-170.67 -170.67 1365.34 1365.34" fill="currentColor" stroke="none">
    <path d="M948.167111 0H75.207111C33.792 0 0 33.792 0 75.207111v873.585778C0 990.208 33.792 1024 75.207111 1024h873.585778c41.415111 0 75.207111-33.792 75.207111-75.207111V75.207111A76.288 76.288 0 0 0 948.167111 0z m24.234667 511.658667H511.658667v460.743111h-393.102223c-36.977778 0-67.584-30.606222-67.584-67.584v-393.102222h460.686223V50.915556h393.159111c36.977778 0 67.584 30.606222 67.584 67.527111v393.159111z" />
  </Svg>
);

export const IconStep = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.4 5.5H8v5.1M6.2 10.6h3.6" strokeWidth={1.2} />
  </Svg>
);

export const IconUndo = (p: P) => (
  <Svg {...p} strokeWidth={1.02}>
    <g transform="translate(-2.4 -2.37) scale(1.3)">
      <path d="M5.6 5.2h4.4a3 3 0 0 1 0 6H6.2" />
      <path d="M7.9 2.9 5.2 5.2l2.7 2.3" />
    </g>
  </Svg>
);

export const IconRedo = (p: P) => (
  <Svg {...p} strokeWidth={1.02}>
    <g transform="translate(-2.4 -2.37) scale(1.3)">
      <path d="M10.4 5.2H6a3 3 0 0 0 0 6h3.8" />
      <path d="M8.1 2.9l2.7 2.3-2.7 2.3" />
    </g>
  </Svg>
);

/** 图钉：实心 + 45° 斜插（钉尖朝左下）。旋转后包围盒达 16，再缩 0.78 压回 12.5 */
export const IconPin = (p: P) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <g transform="translate(8 8) scale(0.88) translate(-8 -8) rotate(45 8 8)">
      <path d="M5.33 1.33h5.34a1.33 1.33 0 0 1 0 2.67H10v3.18a1.33 1.33 0 0 0 .74 1.19l1.19.6a1.33 1.33 0 0 1 .74 1.19v1.17H3.33v-1.17a1.33 1.33 0 0 1 .74-1.19l1.19-.6a1.33 1.33 0 0 0 .74-1.19V4h-.67a1.33 1.33 0 0 1 0-2.67Z" />
      <path d="M7.35 11.33h1.3L8 14.8Z" />
    </g>
  </Svg>
);

/** 折角软盘（存盘） */
export const IconSave = (p: P) => (
  <Svg {...p}>
    <path d="M2.4 2.4h8.4l2.8 2.8v8.4H2.4z" />
    <path d="M5.2 2.4v3.6h5.2V2.4" opacity=".7" />
    <rect x="5.2" y="8.9" width="5.6" height="4.7" />
  </Svg>
);

/** 后方 L 形 + 前方空心框（复制） */
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.4" y="5.4" width="8.2" height="8.2" />
    <path d="M10.6 5.4V2.4H2.4v8.2h3" opacity=".8" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p} strokeWidth={1.23}>
    <g transform="translate(-0.64 -0.64) scale(1.08)">
      <path d="M2.9 2.9 13.1 13.1M13.1 2.9 2.9 13.1" />
    </g>
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
