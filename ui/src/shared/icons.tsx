//! 工具条图标。风格基准取自 Snipaste 官方 16×16 资产的**规格**（实测 www.snipaste.com/img/{copy,save,pin}16.svg）：
//! viewBox 0 0 16 16、线宽约 1.25–1.28（即 16/50=0.32 的 4 倍）、方角无圆头、构图几何化。
//! 这里只对齐规格与构图（图钉是斜插、复制是后 L 形 + 前空心框、存盘是折角软盘），
//! **没有搬运它们的 path 数据** —— 那是受版权的美术资产。

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
      strokeWidth={1.25}
      strokeLinecap="butt"
      strokeLinejoin="miter"
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
    <rect x="2.375" y="3.375" width="11.25" height="9.25" />
  </Svg>
);

export const IconEllipse = (p: P) => (
  <Svg {...p}>
    <ellipse cx="8" cy="8" rx="5.625" ry="4.625" />
  </Svg>
);

export const IconArrow = (p: P) => (
  <Svg {...p}>
    <path d="M3.3 12.7 11.4 4.6" />
    <path d="M6.6 3.9h5.5v5.5" />
  </Svg>
);

export const IconPolyline = (p: P) => (
  <Svg {...p}>
    <path d="M2.4 12.1 6 6.4 9.3 9.6 13.6 3.9" />
  </Svg>
);

export const IconMarker = (p: P) => (
  <Svg {...p}>
    <path d="M3 13.5h4.2" />
    <path d="M4.6 11.1 11.2 4.5l2.2 2.2-6.6 6.6z" />
    <path d="M9.6 6.1 11.9 8.4" opacity=".55" />
  </Svg>
);

export const IconText = (p: P) => (
  <Svg {...p}>
    <path d="M3.4 3.9h9.2" />
    <path d="M8 3.9v8.7" />
    <path d="M6.2 12.6h3.6" />
  </Svg>
);

export const IconMosaic = (p: P) => (
  <Svg {...p}>
    <rect x="2.375" y="2.375" width="11.25" height="11.25" />
    <path d="M6.125 2.375v11.25M9.875 2.375v11.25M2.375 6.125h11.25M2.375 9.875h11.25" opacity=".5" />
  </Svg>
);

export const IconStep = (p: P) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.875" />
    <path d="M6.5 5.7H8v4.4M6.3 10.1h3.4" strokeWidth={1.1} />
  </Svg>
);

export const IconUndo = (p: P) => (
  <Svg {...p}>
    <path d="M5.6 5.2h4.4a3 3 0 0 1 0 6H6.2" />
    <path d="M7.9 2.9 5.2 5.2l2.7 2.3" />
  </Svg>
);

export const IconRedo = (p: P) => (
  <Svg {...p}>
    <path d="M10.4 5.2H6a3 3 0 0 0 0 6h3.8" />
    <path d="M8.1 2.9l2.7 2.3-2.7 2.3" />
  </Svg>
);

/** 斜插图钉（对齐 Snipaste 的 pin16 构图，不是直立图钉） */
export const IconPin = (p: P) => (
  <Svg {...p}>
    <path d="M9.4 1.6 12 4.2" />
    <path d="M11.1 3.3 4.2 10.2" />
    <path d="M5.5 8.9l2.6 2.6" />
    <path d="M2.4 13.6 5.2 8.6" />
  </Svg>
);

/** 折角软盘 + 下方标签框（对齐 Snipaste 的 save16 构图） */
export const IconSave = (p: P) => (
  <Svg {...p}>
    <path d="M2.4 2.4h8.4l2.8 2.8v8.4H2.4z" />
    <path d="M5.2 2.4v3.6h5.2V2.4" opacity=".7" />
    <rect x="5.2" y="8.9" width="5.6" height="4.7" />
  </Svg>
);

/** 后方 L 形 + 前方空心框（对齐 Snipaste 的 copy16 构图） */
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="5.4" y="5.4" width="8.2" height="8.2" />
    <path d="M10.6 5.4V2.4H2.4v8.2h3" opacity=".8" />
  </Svg>
);

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
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
