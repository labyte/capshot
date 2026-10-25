//! 浮层 DOM 的句柄袋：页面在 rAF 里直接写 style/textContent，
//! 绕过 React reconciliation —— 每帧定位这些元素若走 setState，pointermove 就变成渲染风暴。

export interface ChromeRefs {
  toolbar: HTMLDivElement | null;
  propsBar: HTMLDivElement | null;
  loupe: HTMLDivElement | null;
  loupeCanvas: HTMLCanvasElement | null;
  loupeInfo: HTMLDivElement | null;
  loupeCoords: HTMLDivElement | null;
  sizeLabel: HTMLDivElement | null;
  winTitle: HTMLDivElement | null;
}

export function emptyChromeRefs(): ChromeRefs {
  return {
    toolbar: null,
    propsBar: null,
    loupe: null,
    loupeCanvas: null,
    loupeInfo: null,
    loupeCoords: null,
    sizeLabel: null,
    winTitle: null,
  };
}

/** 传给各浮层组件的句柄袋。用结构类型而非 React.MutableRefObject：
 *  React 19 的类型里后者已被 RefObject 取代，写死形状最省心 */
export type ChromeBag = { current: ChromeRefs };

export const px = (v: number) => `${Math.round(v)}px`;

/** 放大镜取样半径（源像素）与每像素放大倍数（CSS px）。
 *  取样区是横长方形 17×11 像素 → 153×99（对齐参考图比例，不是正方形）。 */
export const LOUPE_NX = 8;
export const LOUPE_NY = 5;
export const LOUPE_CELL = 9;
export const LOUPE_W = (LOUPE_NX * 2 + 1) * LOUPE_CELL;
export const LOUPE_H = (LOUPE_NY * 2 + 1) * LOUPE_CELL;
