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

/** 放大镜取样半宽与每像素放大倍数（CSS px） */
export const LOUPE_N = 8;
export const LOUPE_CELL = 9;
export const LOUPE_SIZE = (LOUPE_N * 2 + 1) * LOUPE_CELL;
