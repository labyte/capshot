//! overlay 命令式引擎：事件、rAF 绘制趟、状态机、IPC。
//! React 只在**交互边界**读 store；每帧连续数据走 ref，不进 store、不触发渲染。

import { invoke, u8ToB64 } from "../../shared/ipc";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { createStore } from "./store";
import { paint } from "./painter";
import { PixelReader } from "./pixelReader";
import { makeScratch } from "../../annotate/mosaic";
import { drawShapes } from "../../annotate/render";
import {
  applyShapeHandle,
  canEditShape,
  DEFAULT_PROPS,
  type DrawProps,
  type Shape,
  shapeHandles,
} from "../../annotate/model";
import { parse as parseAnnotation } from "../../annotate/serialize";
import {
  clamp,
  CURSOR_FOR_HANDLE,
  handlePoints,
  moveRect,
  norm,
  rectEq,
  resizeRect,
  type Handle,
  type Phase,
  type Point,
  type Rect,
  type ToolId,
} from "./types";
import type { BootCtx, BootOverlay, SnapshotDto } from "../../shared/types";

export const ACCENT = "#4c9ff5";
const MASK_ALPHA = 0.5;
/** 画笔/马克笔的落点抽稀阈值（物理 px），不抽稀一次拖拽会攒几千个点 */
const MIN_POINT_DIST = 3;

export type Op = "copy" | "save" | "pin" | "copySave";

export interface OverlayState {
  phase: Phase;
  hover: Rect | null;
  sel: Rect | null;
  tool: ToolId | null;
  props: DrawProps;
  shapes: Shape[];
  selectedId: number | null;
  toolbarVisible: boolean;
  loupeForced: boolean;
  loupeFormat: "rgb" | "hex";
  canUndo: boolean;
  canRedo: boolean;
  /** 文字输入态：非 null 时页面在 at 处显示输入框 */
  pendingTextAt: Point | null;
  busy: boolean;
  error: string | null;
}

type Anchor =
  | { mode: "draw"; start: Point; moved: boolean; spaceFromRect: Rect | null }
  | { mode: "resize"; handle: Handle; rect0: Rect; start: Point }
  | { mode: "move"; rect0: Rect; start: Point }
  | { mode: "shape-new"; start: Point; id: number }
  | { mode: "shape-move"; start: Point; id: number; origin: Shape }
  /** 拖「刚画完那一支」的句柄：key 对应 shapeHandles 的 k（点类 a/b/first/last，矩形类 nw..w） */
  | { mode: "shape-edit"; start: Point; id: number; key: string; origin: Shape }
  | null;

export interface FrameInfo {
  pointer: Point | null;
  virtualPointer: Point | null;
  sel: Rect | null;
  hover: Rect | null;
  color: [number, number, number] | null;
  hex: string;
  /** 物理 px → CSS px 的比值（canvas 的 CSS 宽 / 物理宽），DOM 浮层定位用 */
  cssScale: number;
  /** canvas 在窗口中的 CSS 偏移，通常是 0 */
  cssOrigin: Point;
  loupeVisible: boolean;
  showToolbar: boolean;
  phase: Phase;
  winW: number;
  winH: number;
}

/** 线宽的逻辑 px 上下限（滚轮范围，也是属性栏圆点预览的读数上限） */
const MIN_WIDTH = 1;
const MAX_WIDTH = 16;

/** 笔刷类的逻辑 px 上下限：马赛克线条是笔刷直径，橡皮是命中半径。
 *  比线宽宽得多 —— 打码/擦除要盖住成片像素，16px 根本不够用。 */
const MIN_MOSAIC_BRUSH = 8;
const MAX_MOSAIC_BRUSH = 80;
const MIN_ERASER = 4;
const MAX_ERASER = 80;

/** 工具单键。R 让给「恢复上次选区」（与 Snipaste 一致），矩形改用 V（设计工具惯例）。
 *  表内字母与 WASD 的 w/a/s/d 不重叠，所以走键不会抢方向微调。 */
const TOOL_KEYS: Record<string, ToolId> = {
  v: "rect",
  o: "ellipse",
  p: "arrow",
  l: "polyline",
  m: "marker",
  t: "text",
  x: "mosaic",
  n: "step",
  e: "eraser",
};

const WASD: Record<string, [number, number]> = {
  w: [0, -1],
  a: [-1, 0],
  s: [0, 1],
  d: [1, 0],
};

export class OverlayController {
  readonly store: ReturnType<typeof createStore<OverlayState>>;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private frame: ImageBitmap | null = null;
  private reader: PixelReader | null = null;
  private readonly scratch = makeScratch();
  private anchor: Anchor = null;
  private pointer: Point | null = null;
  /** 悬停反馈：光标正压着的手柄 / 光标下的已画图形（不进 store，只影响画布与光标） */
  private hotHandle: Handle | null = null;
  private hoverShapeId: number | null = null;
  /**
   * 「刚画完、还能拖端点」的那支图形。对齐 Snipaste：**只在绘制后当场存活** ——
   * 起笔画下一支、切工具、右键退回、撤销重做，都会把它交出去（置 null）。
   * 不进 store：它是纯交互态，撤销快照里不该有它，画布那一趟直接读字段。
   */
  private editId: number | null = null;
  /** 光标当前压着 editId 那支的哪个句柄（"a"/"b"/"first"/"last"/"nw"…"w"）；null = 没压着 */
  private hotEdit: string | null = null;
  /** store 订阅里挂 updateCursor —— 见 bind() 的注释 */
  private unsubCursor: (() => void) | null = null;
  private spaceHeld = false;
  private altHeld = false;
  private chain: SnapshotDto[] = [];
  private chainIdx = 0;
  private dirty = false;
  private raf = 0;
  private past: string[] = [];
  private future: string[] = [];
  private committedRect: Rect | null = null;
  private committedSelId: number | null = null;
  private nextShapeId = 1;
  private disposed = false;
  /** 几何缓存：pointermove 里不重复 query 布局 */
  private layout = { cssScale: 1, originX: 0, originY: 0, physW: 1, physH: 1 };

  constructor(
    private readonly boot: BootCtx,
    canvas: HTMLCanvasElement,
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    this.ctx = ctx;
    // 重编辑场景：底图即选区，选区不可改，直接进 adjusting，并把已存标注还原成可编辑图形
    const editor = this.boot.kind === "editor";
    this.store = createStore<OverlayState>({
      phase: editor ? "adjusting" : "picking",
      hover: null,
      sel: editor
        ? { x: 0, y: 0, w: this.boot.bounds.width, h: this.boot.bounds.height }
        : null,
      tool: null,
      props: { ...DEFAULT_PROPS },
      shapes: [],
      selectedId: null,
      toolbarVisible: true,
      loupeForced: false,
      loupeFormat: "rgb",
      canUndo: false,
      canRedo: false,
      pendingTextAt: null,
      busy: false,
      error: null,
    });
  }

  private get scale() {
    return this.boot.scale || 1;
  }
  private get handleSize() {
    return Math.round(9 * this.scale);
  }
  get state() {
    return this.store.get();
  }

  /** 放大镜按区域放大取样用 */
  get frameImage(): ImageBitmap | null {
    return this.frame;
  }

  /** 重编辑模式：底图是一张已有的 sel，没有会话、没有吸附候选、选区不可改 */
  get isEditor(): boolean {
    return this.boot.kind === "editor";
  }

  private get overlay(): BootOverlay | null {
    return this.boot.kind === "overlay" ? this.boot : null;
  }

  /** 高亮框左上角显示的窗口标识（应用名 + 标题截断），对齐 Snipaste 的悬浮提示 */
  windowTitleAt(r: Rect): string | null {
    const w = this.chain.find((c) => {
      const lr = this.localRect(c);
      return !!lr && lr.x === r.x && lr.y === r.y && lr.w === r.w && lr.h === r.h;
    });
    if (!w) return null;
    const app = w.appName ?? w.bundleId ?? "";
    const title = (w.title ?? "").trim();
    const text = app && title && !title.startsWith(app) ? `${app} · ${title}` : app || title;
    if (!text) return null;
    return text.length > 42 ? text.slice(0, 42) + "…" : text;
  }

  // ---------- 装载 ----------

  /** 加载底图。overlay = 会话冻结帧；editor = 既有 sel 的 PNG。失败返回 false */
  async loadFrame(): Promise<boolean> {
    this.canvas.width = this.boot.bounds.width;
    this.canvas.height = this.boot.bounds.height;
    try {
      const buf = this.isEditor
        ? await invoke<ArrayBuffer>("get_selection_png", { sel: (this.boot as { sel: number }).sel })
        : await invoke<ArrayBuffer>("get_monitor_frame", {
            token: this.overlay!.token,
            monitor: this.overlay!.monitor,
          });
      this.frame = await createImageBitmap(new Blob([buf], { type: "image/png" }));
    } catch (e) {
      console.error("底图加载失败", e);
      return false;
    }
    if (this.isEditor) {
      const ann = (this.boot as { annotation?: string | null }).annotation;
      const shapes = parseAnnotation(ann);
      if (shapes.length) {
        this.store.set({ shapes });
        this.nextShapeId = Math.max(...shapes.map((s) => s.id), 0) + 1;
      }
      // 编辑器没有"未定选区"这一步，直接交还给导出路径
      this.committedSelId = (this.boot as { sel: number }).sel;
    }
    this.measureLayout();
    this.bind();
    // 首帧也走一次状态判定：恢复出带刷圈的工具时，不等鼠标动就该是圈而不是十字
    this.updateCursor();
    // 关键：loadFrame 必须自己置 dirty。loop() 是 `if (dirty) draw`，
    // 而 dirty 初始为 false、只有指针/键盘事件才 mark() —— 不补这一下，
    // reveal() 会在"一帧都没画"的画布上执行，首帧之前什么都看不见。
    this.mark();
    this.loop();
    return true;
  }

  /** 等到第一帧真正画上再 reveal；页面用它替代"猜一个 rAF" */
  firstFrame(): Promise<void> {
    if (this.paintedOnce) return Promise.resolve();
    return new Promise((res) => this.paintWaiters.push(res));
  }

  private paintedOnce = false;
  private paintWaiters: Array<() => void> = [];

  private measureLayout(): void {
    const r = this.canvas.getBoundingClientRect();
    this.layout = {
      cssScale: r.width > 0 ? r.width / this.canvas.width : 1 / this.scale,
      originX: r.left,
      originY: r.top,
      physW: this.canvas.width,
      physH: this.canvas.height,
    };
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", this.onPointerDown);
    c.addEventListener("pointermove", this.onPointerMove);
    // 移到工具条/属性栏上时画布收不到 pointermove，悬停高亮会赖在最后一帧上 —— 离开即清
    c.addEventListener("pointerleave", this.onPointerLeave);
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("dblclick", this.onDblClick);
    c.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onResize);
    /* 光标跟着状态走，而不是跟着"某个记得调 updateCursor 的调用点"走。
       以前只在 onPointerMove / setTool 里调，于是右键裸 store.set 清工具、
       属性栏点「矩形模式」改 eraserRect/mosaicMode 这些路径都漏了 ——
       表现是刷圈已经没了但 cursor 还停在 none，指针直接隐形。
       store.set 自带同值去重，updateCursor 又只在值变化时写 style，代价是一次比较。 */
    this.unsubCursor?.(); // bind() 理论上每实例一次，重复调用也不该叠订阅
    this.unsubCursor = this.store.subscribe(() => this.updateCursor());
  }

  dispose(): void {
    this.disposed = true;
    this.unsubCursor?.();
    this.unsubCursor = null;
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
    c.removeEventListener("pointerleave", this.onPointerLeave);
    c.removeEventListener("pointerup", this.onPointerUp);
    c.removeEventListener("pointercancel", this.onPointerUp);
    c.removeEventListener("wheel", this.onWheel);
    c.removeEventListener("dblclick", this.onDblClick);
    c.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("resize", this.onResize);
    this.frame?.close();
    this.frame = null;
  }

  private onResize = () => {
    this.measureLayout();
    this.mark();
  };

  // ---------- 绘制趟 ----------

  private mark(): void {
    this.dirty = true;
  }

  /**
   * 必须是箭头属性而不是普通方法：`requestAnimationFrame(this.loop)` 传的是未绑定的
   * 方法引用，ESM 严格模式里回调的 this 是 undefined，第一跳就在 this.disposed 上抛，
   * 而重新排帧那一行永远执行不到 —— 绘制循环一帧都没画就死掉。
   * try/catch 同理：draw() 抛异常不能带走整个循环。
   */
  private loop = (): void => {
    if (this.disposed) return;
    if (this.dirty) {
      this.dirty = false;
      try {
        this.draw();
      } catch (e) {
        console.error("overlay draw failed", e);
        this.store.set({ error: "绘制失败：" + String((e as Error)?.message ?? e) });
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  /**
   * 该工具要不要**自绘笔刷圈**，要则返回半径（物理 px），不要则返回 null（用系统光标）。
   * 圈可见时系统光标必须隐藏（见 updateCursor 的 `none` 分支），否则会两个光标叠着。
   *
   * 依据 = 逐帧分析一段 Snipaste 真实录屏（1920×1080@60fps，相邻帧差分定位光标 +
   * 模板匹配认字形），不是猜的：
   *
   * - **橡皮圆头 / 马赛克线条**：环径 = 实际笔刷尺寸，滚轮即时变
   *   （官方 changelog #1310「cursor shape not updated when adjusting the pen size
   *   with mouse wheeling」背书这一条）
   * - **记号笔**：**固定 ~15px 直径**的细圆环，**不随线宽变** ——
   *   录屏 t=185→196 环径恒为 14–15px，而同帧粉色高亮笔迹宽 32–37px，
   *   两者无关，所以它只是个"这是记号笔"的工具圈，不是笔刷预览
   * - **画笔（polyline）不在此列**：录屏 t=141 那段红色自由笔迹上量到的是**纯十字**，
   *   上一轮我给它加环是错的，已撤
   * - **箭头也不在此列**：t=83 量到的是十字；文档 §4「圆点 + 四个方向短线」
   *   查无实据（官方包里无任何光标图资源），已撤回
   * - 矩形模式（markerRect / eraserRect）与形状类工具一律系统十字
   */
  private brushRadius(): number | null {
    const s = this.state;
    if (s.phase !== "adjusting" && s.phase !== "tool-drawing") return null;
    const sc = this.scale;
    const p = s.props;
    if (s.tool === "eraser" && !p.eraserRect) return p.eraserRadius * sc;
    if (s.tool === "mosaic" && p.mosaicMode === "line") return (p.mosaicBrush * sc) / 2;
    // 记号笔：固定工具圈（录屏实测直径 ~15px @100%，与线宽无关）
    if (s.tool === "marker" && !p.markerRect) return 7.5 * sc;
    return null;
  }

  private draw(): void {
    if (!this.frame) return;
    const s = this.state;
    const ring = this.brushRadius();
    const editable = this.editableShape();
    if (!this.reader) {
      // 懒建：放大镜真要读像素才铺一张全幅 CPU 后端画布
      this.reader = new PixelReader(this.frame, this.frame.width, this.frame.height);
    }
    paint(
      this.ctx,
      { w: this.layout.physW, h: this.layout.physH },
      {
        frame: this.frame,
        phase: s.phase,
        hover: s.hover,
        sel: s.sel,
        shapes: s.shapes,
        deps: { source: this.frame, scale: this.scale, scratch: this.scratch },
        // 重编辑里选区就是整幅图，画 8 向手柄只会沿图片边缘一圈噪声
        showHandles: s.phase === "adjusting" && s.toolbarVisible && !s.tool && !this.isEditor,
        selectedId: s.selectedId,
        hoverId: this.hoverShapeId,
        hotHandle: this.hotHandle,
        // 刚画完那支的句柄（空数组 = 没有可编辑的图形）
        editHandles: editable ? shapeHandles(editable) : [],
        hotEdit: this.hotEdit,
        accent: ACCENT,
        maskAlpha: MASK_ALPHA,
        handleSize: this.handleSize,
        brushCursor:
          ring !== null && this.pointer
            ? { x: this.pointer.x, y: this.pointer.y, r: ring }
            : null,
      },
    );
    this.publishFrameInfo();
    if (!this.paintedOnce) {
      this.paintedOnce = true;
      const waiting = this.paintWaiters;
      this.paintWaiters = [];
      waiting.forEach((res) => res());
    }
  }

  private publishFrameInfo(): void {
    const s = this.state;
    const p = this.pointer;
    const b = this.boot.bounds;
    const showLoupe =
      !s.pendingTextAt &&
      (this.altHeld ||
        s.loupeForced ||
        s.phase === "picking" ||
        s.phase === "drawing" ||
        (s.phase === "adjusting" && !s.sel));
    let color: [number, number, number] | null = null;
    let hex = "";
    if (p && showLoupe && this.reader) {
      color = this.reader.at(p.x, p.y);
      hex = this.reader.hex(p.x, p.y);
    }
    this.chromeInfo = {
      pointer: p,
      virtualPointer: p ? { x: b.x + p.x, y: b.y + p.y } : null,
      sel: s.sel,
      hover: s.hover,
      color,
      hex,
      cssScale: this.layout.cssScale,
      cssOrigin: { x: this.layout.originX, y: this.layout.originY },
      loupeVisible: !!showLoupe && !!p,
      showToolbar: !!s.sel && s.toolbarVisible && s.phase !== "drawing",
      phase: s.phase,
      winW: this.canvas.clientWidth || this.layout.physW * this.layout.cssScale,
      winH: this.canvas.clientHeight || this.layout.physH * this.layout.cssScale,
    };
  }

  /** 页面在 rAF 里取最新浮层信息（不进 React 状态，直接写 DOM） */
  chromeInfo: FrameInfo = {
    pointer: null,
    virtualPointer: null,
    sel: null,
    hover: null,
    color: null,
    hex: "",
    cssScale: 1,
    cssOrigin: { x: 0, y: 0 },
    loupeVisible: false,
    showToolbar: false,
    phase: "picking",
    winW: 0,
    winH: 0,
  };

  // ---------- 坐标与命中 ----------

  private evPos(e: { clientX: number; clientY: number }): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - r.left) * (this.canvas.width / Math.max(1, r.width))),
      y: Math.round((e.clientY - r.top) * (this.canvas.height / Math.max(1, r.height))),
    };
  }

  /** 候选窗口裁剪到本屏后的局部矩形；完全不在本屏 → null */
  private localRect(w: SnapshotDto): Rect | null {
    const b = this.boot.bounds;
    const x0 = Math.max(w.x, b.x);
    const y0 = Math.max(w.y, b.y);
    const x1 = Math.min(w.x + w.width, b.x + b.width);
    const y1 = Math.min(w.y + w.height, b.y + b.height);
    if (x1 - x0 < 2 || y1 - y0 < 2) return null;
    return { x: x0 - b.x, y: y0 - b.y, w: x1 - x0, h: y1 - y0 };
  }

  private hitChain(p: Point): SnapshotDto[] {
    const out: SnapshotDto[] = [];
    for (const w of this.overlay?.windows ?? []) {
      const r = this.localRect(w);
      if (r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) out.push(w);
    }
    return out;
  }

  /** 更新命中链并取当前层级的矩形（Tab / 滚轮沿链前进后退） */
  private hoverFor(p: Point): Rect | null {
    const top = this.hitChain(p);
    const sameTop = top[0]?.windowId === this.chain[0]?.windowId;
    if (!sameTop || top.length !== this.chain.length) {
      this.chain = top;
      this.chainIdx = 0;
    }
    if (!top.length) return null;
    this.chainIdx = clamp(this.chainIdx, 0, top.length - 1);
    return this.localRect(top[this.chainIdx]);
  }

  private cycleChain(dir: number): void {
    if (!this.chain.length || !this.pointer) return;
    this.chainIdx = (this.chainIdx + dir + this.chain.length) % this.chain.length;
    const hover = this.localRect(this.chain[this.chainIdx]);
    if (!rectEq(hover, this.state.hover)) this.store.set({ hover });
    this.mark();
  }

  private hitHandle(p: Point): Handle | null {
    const s = this.state.sel;
    if (!s || this.state.phase !== "adjusting") return null;
    const tol = this.handleSize;
    for (const h of handlePoints(s)) {
      if (Math.abs(h.x - p.x) <= tol && Math.abs(h.y - p.y) <= tol) return h.k;
    }
    return null;
  }

  private inSel(p: Point): boolean {
    const s = this.state.sel;
    return !!s && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h;
  }

  /** 可编辑那支的句柄命中，返回其 key；没得编辑 / 没压着 = null。容差与选区手柄同宽 */
  private hitEditable(p: Point): string | null {
    const sh = this.editableShape();
    if (!sh) return null;
    const tol = this.handleSize;
    for (const h of shapeHandles(sh)) {
      if (Math.abs(h.x - p.x) <= tol && Math.abs(h.y - p.y) <= tol) return h.k;
    }
    return null;
  }

  /** 当前可拖端点的图形（图形被撤销掉时自然变 null，句柄也就没了） */
  private editableShape(): Shape | null {
    if (this.editId === null) return null;
    return this.state.shapes.find((x) => x.id === this.editId) ?? null;
  }

  /** 交还「可编辑」状态：起新笔、切工具、退回、undo/redo 都要调 */
  private releaseEditHandles(): void {
    if (this.editId === null && this.hotEdit === null) return;
    this.editId = null;
    this.hotEdit = null;
    this.mark();
  }

  /**
   * 光标 = 状态的纯函数。判定顺序：拖拽中的锁定值 > 刷圈 > 文字插入点 > 悬停态。
   *
   * **拖拽中必须用锁定值**：resize 时每帧 sel 都在变，再拿实时位置去 hitHandle，
   * 选区一撑大手柄就跑出容差，光标会在 resize / move / crosshair 之间抖。
   * 悬停态（hotHandle / hoverShapeId）由 updateHover 统一算，这里只读结果 ——
   * 画布上的高亮和光标因此永远说同一句话。
   */
  private updateCursor(): void {
    const s = this.state;
    const p = this.pointer;
    const a = this.anchor;
    let c = "crosshair";
    if (a?.mode === "resize") c = CURSOR_FOR_HANDLE[a.handle];
    else if (a?.mode === "shape-edit")
      // 拖图形的 8 向句柄时给方向缩放光标，拖端点时给抓手
      c = a.key in CURSOR_FOR_HANDLE ? CURSOR_FOR_HANDLE[a.key as Handle] : "move";
    else if (a?.mode === "move" || a?.mode === "shape-move") c = "move";
    // 压在「刚画完那支」的句柄上：此时工具还开着（默认是十字），但这一格该给反馈
    else if (this.hotEdit)
      c = this.hotEdit in CURSOR_FOR_HANDLE ? CURSOR_FOR_HANDLE[this.hotEdit as Handle] : "move";
    // 该工具要自绘笔刷圈（橡皮圆头 / 马赛克线条 / 画笔）时隐藏系统光标，
    // 避免圈+十字双光标打架；矩形模式、形状类工具仍用十字
    else if (this.brushRadius() !== null) c = "none";
    else if (s.pendingTextAt) c = "text";
    else if (s.phase === "adjusting" && !s.tool && p) {
      if (this.hotHandle) c = CURSOR_FOR_HANDLE[this.hotHandle];
      else if (this.hoverShapeId !== null || this.inSel(p)) c = "move";
    }
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  /**
   * 没有按下时的悬停判定：命中哪个手柄、压在哪个已画图形上，一次算完，
   * 供 updateCursor 与 paint 共用（分开算就会出现"光标说 move、画布没高亮"）。
   */
  private updateHover(p: Point): void {
    const s = this.state;
    // 图形句柄不看工具是否开着：刚画完一支时工具仍是选中的，句柄照样要能悬停
    // （本方法只在没有按下锚点时被调用，不必再判 drawing/tool-drawing）
    const ei = this.hotEdit;
    const nextEdit = this.hitEditable(p);
    const on = s.phase === "adjusting" && !s.tool && !s.pendingTextAt && nextEdit === null;
    const h = on ? this.hitHandle(p) : null;
    const sh = on && !h ? this.shapeAt(p) : null;
    const id = sh && this.inSel(p) ? sh.id : null;
    if (ei === nextEdit && h === this.hotHandle && id === this.hoverShapeId) return;
    this.hotEdit = nextEdit;
    this.hotHandle = h;
    this.hoverShapeId = id;
    this.mark();
  }

  /** 悬停态作废（按下、切工具、退回检测态、指针离开画布时都要清，
   *  否则高亮/放大的那颗点会赖在最后一帧上） */
  private clearHover(): void {
    if (this.hotHandle === null && this.hoverShapeId === null && this.hotEdit === null) return;
    this.hotHandle = null;
    this.hoverShapeId = null;
    this.hotEdit = null;
    this.mark();
  }

  // ---------- 指针 ----------

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) return; // 右键交给 contextmenu
    if (e.button !== 0 && e.button !== 1) return;
    const p = this.evPos(e);
    this.pointer = p;
    const s = this.state;
    this.clearHover();

    if (e.button === 1) {
      if (s.sel) void this.run("pin");
      return;
    }
    if (s.pendingTextAt) {
      this.commitText();
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);

    // 0) 刚画完那一支的句柄优先于一切：不先判它，工具还开着时这一点会被当成
    //    "起笔画下一支"，句柄就永远拖不动（Snipaste 绘制后当场可改的就是这个入口）
    const ei = this.hitEditable(p);
    if (ei) {
      const sh = this.editableShape()!;
      this.pushUndo();
      this.anchor = {
        mode: "shape-edit",
        start: p,
        id: sh.id,
        key: ei,
        origin: JSON.parse(JSON.stringify(sh)) as Shape,
      };
      this.mark();
      return;
    }
    // 落点不在句柄上 = 这一支就此定稿（点别处、端点消失后不可再改）
    this.releaseEditHandles();

    if (s.phase === "adjusting" && !s.tool) {
      // 先试命中已有图形（阶段 2 的再选中入口），再试手柄/整体移动
      const hitShape = this.shapeAt(p);
      if (hitShape && this.inSel(p)) {
        // 快照原图 + 每次从原点重算，避免逐帧累加漂移
        this.pushUndo();
        this.store.set({ selectedId: hitShape.id });
        this.anchor = {
          mode: "shape-move",
          start: p,
          id: hitShape.id,
          origin: JSON.parse(JSON.stringify(hitShape)) as Shape,
        };
        this.mark();
        return;
      }
      if (s.selectedId !== null) this.store.set({ selectedId: null });
      const h = this.hitHandle(p);
      if (h) {
        this.anchor = { mode: "resize", handle: h, rect0: { ...s.sel! }, start: p };
        this.mark();
        return;
      }
      if (this.inSel(p)) {
        this.anchor = { mode: "move", rect0: { ...s.sel! }, start: p };
        this.mark();
        return;
      }
    }

    if (s.tool && s.sel) {
      this.beginShape(p);
      return;
    }

    // 新框选：picking，或在已有选区外/工具未激活时重新起框
    if (this.isEditor) {
      // 重编辑里选区就是整幅图，不存在"重新框一遍"；空白处点击只取消图形选中，
      // 否则会把已有标注当成一次新框选给清空
      this.store.set({ selectedId: null });
      this.mark();
      return;
    }
    this.anchor = { mode: "draw", start: p, moved: false, spaceFromRect: null };
    this.store.set({
      phase: "drawing",
      sel: { x: p.x, y: p.y, w: 1, h: 1 },
      hover: null,
      shapes: [],
      selectedId: null,
      toolbarVisible: false,
    });
    this.past.length = 0;
    this.future.length = 0;
    this.committedRect = null;
    this.committedSelId = null;
    this.mark();
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.evPos(e);
    this.pointer = p;
    const a = this.anchor;

    if (!a) {
      if (this.state.phase === "picking") {
        const hover = this.hoverFor(p);
        if (!rectEq(hover, this.state.hover)) this.store.set({ hover });
      }
      this.updateHover(p);
      this.updateCursor();
      this.mark();
      return;
    }
    this.clearHover();

    const bound = { w: this.layout.physW, h: this.layout.physH };
    const sel = this.state.sel;

    if (a.mode === "draw") {
      if (this.spaceHeld && sel && sel.w > 2) {
        // 按住 Space 不放：拖拽中转为整体移动
        if (!a.spaceFromRect) a.spaceFromRect = { ...sel };
        const r = a.spaceFromRect;
        this.store.set({ sel: moveRect(r, p.x - a.start.x, p.y - a.start.y, bound) });
        this.mark();
        return;
      }
      a.spaceFromRect = null;
      let dx = p.x - a.start.x;
      let dy = p.y - a.start.y;
      if (e.shiftKey) {
        const m = Math.min(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx) * m;
        dy = Math.sign(dy) * m;
      }
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) a.moved = true;
      const r = norm(a.start.x, a.start.y, dx, dy);
      this.store.set({ sel: { ...r, w: Math.max(1, r.w), h: Math.max(1, r.h) } });
    } else if (a.mode === "resize") {
      // 与图形句柄共用 resizeRect（同一份缩放算法），从按下时的原矩形重算
      this.store.set({
        sel: resizeRect(a.rect0, a.handle, p.x - a.start.x, p.y - a.start.y),
      });
    } else if (a.mode === "move") {
      this.store.set({ sel: moveRect(a.rect0, p.x - a.start.x, p.y - a.start.y, bound) });
    } else if (a.mode === "shape-new") {
      this.growShape(a.id, p, e);
    } else if (a.mode === "shape-move") {
      const sh = this.state.shapes.find((x) => x.id === a.id);
      if (sh) applyFromOrigin(sh, a.origin, p.x - a.start.x, p.y - a.start.y);
    } else if (a.mode === "shape-edit") {
      const sh = this.state.shapes.find((x) => x.id === a.id);
      if (sh) applyShapeHandle(sh, a.key, p, a.origin, a.start);
    }
    this.updateCursor();
    this.mark();
  };

  private onPointerLeave = () => {
    // 只在没按下时清：拖拽中指针飞出画布是常事，锚点还得留着继续算
    if (!this.anchor) this.clearHover();
  };

  private onPointerUp = (e: PointerEvent) => {
    const a = this.anchor;
    this.anchor = null;
    if (!a) return;

    if (a.mode === "draw") {
      const p = this.evPos(e);
      let sel = this.state.sel;
      // 单击（几乎没拖动）= 采纳吸附目标整窗
      if (!a.moved && (!sel || sel.w < 4 || sel.h < 4)) {
        sel = this.state.hover ?? this.hoverFor(p);
      }
      this.store.set({ phase: "adjusting", sel: sel ?? null, toolbarVisible: true });
    } else if (a.mode === "shape-new") {
      this.settleShape(a.id);
      this.store.set({ phase: "adjusting" });
    } else if (a.mode === "shape-move") {
      this.store.set({ phase: "adjusting" });
    } else if (a.mode === "shape-edit") {
      // 拖完一端句柄要继续留着，好接着拖另一端；"点别处才定稿"由下一次
      // pointerdown 的 releaseEditHandles 负责，这里不收
      this.store.set({ phase: "adjusting" });
    } else {
      this.store.set({ phase: "adjusting", toolbarVisible: true });
    }
    this.mark();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    // 有工具 → 调该工具的尺寸；选中了已画图形 → 调那个图形；都没有 → 换吸附层级
    if (this.state.tool || this.state.selectedId !== null) this.bumpSize(e.deltaY < 0 ? 1 : -1);
    else if (!this.state.sel) this.cycleChain(e.deltaY > 0 ? 1 : -1);
  };

  private onDblClick = (e: MouseEvent) => {
    const s = this.state;
    if (s.phase === "adjusting" && s.sel) {
      void this.run("copy");
      return;
    }
    const p = this.evPos(e);
    const w = this.hitChain(p)[0];
    if (w) void this.cleanWindowCopy(w);
  };

  /** 右键：画图态结束当前图形；已定选区退回检测态；检测态再按 = 放弃本次截图 */
  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    if (this.state.pendingTextAt) {
      this.cancelText();
      return;
    }
    const s = this.state;
    if (s.phase === "tool-drawing" && this.anchor?.mode === "shape-new") {
      this.settleShape(this.anchor.id);
      this.anchor = null;
      this.store.set({ phase: "adjusting" });
      this.mark();
      return;
    }
    if (s.sel && s.phase !== "picking") {
      this.store.set({
        phase: "picking",
        sel: null,
        tool: null,
        selectedId: null,
        toolbarVisible: true,
        hover: this.pointer ? this.hoverFor(this.pointer) : null,
      });
      this.clearHover();
      this.releaseEditHandles();
      this.committedRect = null;
      this.mark();
      return;
    }
    void this.cancel();
  };

  private onBlur = () => {
    this.spaceHeld = false;
    this.altHeld = false;
  };

  // ---------- 键盘（单一优先级链，避免 case 互相吞键） ----------

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.state.pendingTextAt) return; // 输入框自己处理，且已 stopPropagation

    const k = e.key;
    const s = this.state;
    const mod = e.ctrlKey || e.metaKey;

    if (k === " " || k === "Spacebar") {
      this.spaceHeld = true;
      if (!this.anchor) {
        e.preventDefault();
        this.store.set({ toolbarVisible: !s.toolbarVisible });
        this.mark();
      }
      return;
    }
    if (k === "Alt" || e.altKey) {
      this.altHeld = true;
      this.mark();
      return;
    }
    const lower = k.length === 1 ? k.toLowerCase() : k;

    // 1) 与修饰键无关的导航键
    if (k === "Escape") {
      e.preventDefault();
      if (s.selectedId !== null) this.store.set({ selectedId: null });
      else if (s.tool) this.setTool(null);
      else void this.cancel();
      return;
    }
    if (k === "Enter") {
      e.preventDefault();
      if (s.sel) void this.run("copy");
      return;
    }
    if (k === "Tab") {
      e.preventDefault();
      if (!s.sel) this.cycleChain(e.shiftKey ? -1 : 1);
      return;
    }
    if (k.startsWith("Arrow")) {
      e.preventDefault();
      this.nudgeSelection(k, e);
      return;
    }
    if (k === "Delete" || k === "Backspace") {
      if (s.selectedId !== null) {
        e.preventDefault();
        this.deleteSelected();
      }
      return;
    }
    // 尺寸（线宽 / 橡皮大小 / 马赛克粒度）只认滚轮：这里不再绑 [ ] 1 2。
    // 保留键盘的话，属性栏就还得做成可点的档位按钮才能"看起来一致"，
    // 而按需求线宽要的是单一入口 —— 见 bumpSize 与 PropertyBar 的只读圆点。

    // 2) 带修饰键的命令
    if (mod) {
      if (lower === "a") {
        e.preventDefault();
        this.selectWholeScreen();
      } else if (lower === "c") {
        e.preventDefault();
        if (s.sel) void this.run("copy");
      } else if (lower === "s") {
        e.preventDefault();
        if (s.sel) void this.run("save");
      } else if (lower === "t") {
        e.preventDefault();
        if (s.sel) void this.run("pin");
      } else if (lower === "z") {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (lower === "y") {
        e.preventDefault();
        this.redo();
      }
      return;
    }

    // 3) Shift+C 切颜色格式 / C 复制放大镜颜色
    if (lower === "c") {
      e.preventDefault();
      void this.copyColor(e.shiftKey);
      return;
    }

    // 4) R：恢复上次选区（与 Snipaste 的 R 语义一致；矩形工具在 V）
    if (lower === "r") {
      e.preventDefault();
      if (this.isEditor) return; // 重编辑里选区就是整幅图，没有"上次选区"可言
      if (!this.restoreLastRect()) this.store.set({ error: "没有可恢复的上次选区" });
      return;
    }

    // 4b) F：描边 ⇄ 填充（仅矩形/椭圆；工具未激活但选中了它们也生效）
    if (lower === "f") {
      e.preventDefault();
      if (!this.fillState().visible) return;
      this.toggleFill();
      return;
    }

    // 5) 工具单键（先于 WASD，确保 t/x/n 等不被当成方向键）
    const tool = TOOL_KEYS[lower];
    if (tool) {
      e.preventDefault();
      this.setTool(s.tool === tool ? null : tool);
      return;
    }

    // 5) +/-：序号工具的起始编号
    if (k === "+" || k === "=" || k === "-" || k === "_") {
      e.preventDefault();
      this.bumpStepNumber(k === "-" || k === "_" ? -1 : 1);
      return;
    }

    // 6) WASD 移系统光标 1px（a/s 与工具键不冲突：TOOL_KEYS 里没有 a、s）
    const wv = WASD[lower];
    if (wv) {
      e.preventDefault();
      void this.nudgeCursor(wv);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === " " || e.key === "Spacebar") this.spaceHeld = false;
    if (e.key === "Alt") {
      this.altHeld = false;
      this.mark();
    }
  };

  /** WASD：移动系统光标，WebView2 随即补一个 pointermove，天然复用同一套命中/绘制 */
  private async nudgeCursor(d: [number, number]): Promise<void> {
    const p = this.pointer;
    if (!p) return;
    const nx = clamp(p.x + d[0], 0, this.layout.physW - 1);
    const ny = clamp(p.y + d[1], 0, this.layout.physH - 1);
    if (nx === p.x && ny === p.y) return;
    try {
      await getCurrentWindow().setCursorPosition(new PhysicalPosition(nx, ny));
    } catch (err) {
      // capabilities 缺 core:window:allow-set-cursor-position 时走内部兜底：
      // 不移动系统光标，但仍按新坐标更新吸附与读数
      console.warn("setCursorPosition 不可用，降级为内部光标位更新", err);
    }
    this.pointer = { x: nx, y: ny };
    if (this.state.phase === "picking") {
      const hover = this.hoverFor(this.pointer);
      if (!rectEq(hover, this.state.hover)) this.store.set({ hover });
    }
    this.mark();
  }

  /** 方向键：无修饰=移动（选区或选中图形），Ctrl=对应边外扩，Shift=对应边内缩 */
  private nudgeSelection(k: string, e: KeyboardEvent): void {
    const v = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[
      k as "ArrowLeft"
    ];
    if (!v) return;
    const [dx, dy] = v;
    const sel = this.state.sel;
    if (!sel) return;

    if (this.state.selectedId !== null) {
      const sh = this.state.shapes.find((x) => x.id === this.state.selectedId);
      if (sh) {
        this.pushUndo();
        translateShape(sh, dx, dy);
        this.touchShapes();
      }
      this.mark();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      this.store.set({ sel: { ...sel, w: Math.max(1, sel.w + dx), h: Math.max(1, sel.h + dy) } });
    } else if (e.shiftKey) {
      this.store.set({
        sel: {
          x: sel.x + (dx < 0 ? dx : 0),
          y: sel.y + (dy < 0 ? dy : 0),
          w: Math.max(1, sel.w - (dx !== 0 ? 1 : 0)),
          h: Math.max(1, sel.h - (dy !== 0 ? 1 : 0)),
        },
      });
    } else {
      this.store.set({ sel: moveRect(sel, dx, dy, { w: this.layout.physW, h: this.layout.physH }) });
    }
    this.mark();
  }

  private selectWholeScreen(): void {
    this.store.set({
      phase: "adjusting",
      sel: { x: 0, y: 0, w: this.layout.physW, h: this.layout.physH },
      hover: null,
      toolbarVisible: true,
    });
    this.committedRect = null;
    this.mark();
  }

  /** R：恢复上一次成功截图的选区（宿主记录，随 bootstrap 下发） */
  private restoreLastRect(): boolean {
    const last = this.overlay?.lastRect;
    if (!last) return false;
    const b = this.boot.bounds;
    const x0 = Math.max(last.x, b.x);
    const y0 = Math.max(last.y, b.y);
    const x1 = Math.min(last.x + last.width, b.x + b.width);
    const y1 = Math.min(last.y + last.height, b.y + b.height);
    if (x1 - x0 < 2 || y1 - y0 < 2) return false;
    this.store.set({
      phase: "adjusting",
      sel: { x: x0 - b.x, y: y0 - b.y, w: x1 - x0, h: y1 - y0 },
      hover: null,
      toolbarVisible: true,
    });
    this.committedRect = null;
    this.mark();
    return true;
  }

  // ---------- 工具、属性与图形 ----------

  setTool(t: ToolId | null): void {
    // 切工具时丢弃未提交的文字输入（输入框随 pendingTextAt 一起消失）
    this.store.set({ tool: t, selectedId: null, pendingTextAt: null });
    this.clearHover();
    // 切工具 = 离开刚才那一支，端点句柄随之消失
    this.releaseEditHandles();
    this.pendingTextValue = "";
    // 光标要立刻跟上：用键盘 E/X 切到有刷圈的工具时，鼠标可能根本不动，
    // 不在这里调 updateCursor 就会「系统十字光标 + 自绘圆圈」同时挂着
    this.updateCursor();
    this.mark();
  }

  setProps(patch: Partial<DrawProps>): void {
    this.store.set({ props: { ...this.state.props, ...patch } });
    this.applyPropsToEditable(patch);
    this.mark();
  }

  /**
   * 属性栏/滚轮的改动落到「刚画完那一支」上 —— 句柄还活着 = 它仍是当前作品
   * （对齐 §4：此时改箭头样式、点色板都作用在这一支；点别处定稿后就不再改它）。
   *
   * 只镜像**已有图形身上真有的字段**：颜色、线宽，以及箭头的头部样式与单/双向。
   * 其余（记号笔矩形模式、橡皮半径、马赛克粒度…）是"下一笔怎么画"的参数，
   * 拿它们去改一支已经画完的图形没有意义。
   */
  private applyPropsToEditable(patch: Partial<DrawProps>): void {
    const sh = this.editableShape();
    if (!sh) return;
    let changed = false;
    if (patch.color !== undefined && sh.color !== patch.color) {
      sh.color = patch.color;
      changed = true;
    }
    if (patch.width !== undefined) {
      const phys = patch.width * this.scale; // 图形存物理 px，与 beginShape 一致
      if (Math.abs(sh.width - phys) > 0.01) {
        sh.width = phys;
        changed = true;
      }
    }
    if (sh.kind === "arrow") {
      if (patch.arrowHead !== undefined && sh.head !== patch.arrowHead) {
        sh.head = patch.arrowHead;
        changed = true;
      }
      if (patch.arrowDouble !== undefined && sh.double !== patch.arrowDouble) {
        sh.double = patch.arrowDouble;
        changed = true;
      }
    }
    if (changed) this.touchShapes();
  }

  /**
   * 描边 / 填充单选组的落点：圆点=描边、填充按钮=填充，两个入口都走这里。
   * 用「设为某值」而不是翻转 —— 点已选中的那一项必须原地不动，
   * 否则单选组会退化成开关，圆点和填充按钮互相打脸。
   * 选中了已画的矩形/椭圆时连同该图形一起改 —— 否则只动全局默认值，
   * 用户点选一个图形再按 F 会毫无反应。
   */
  setFill(filled: boolean): void {
    const sel = this.state.shapes.find((x) => x.id === this.state.selectedId);
    const target = sel && (sel.kind === "rect" || sel.kind === "ellipse") ? sel : null;
    if (target && target.filled !== filled) {
      target.filled = filled;
      this.touchShapes();
    }
    if (this.state.props.filled !== filled) this.setProps({ filled });
  }

  /** 描边 ⇄ 填充。F 键走这个（切换语义），属性栏两个单选项走 setFill */
  toggleFill(): void {
    this.setFill(!this.fillState().filled);
  }

  /** 填充开关的可见性与当前态：工具是矩形/椭圆，或选中的图形是它们。
   *  和 toggleFill 读同一套判定，按钮不会显示得出来却点不动。 */
  fillState(): { visible: boolean; filled: boolean } {
    const sel = this.state.shapes.find((x) => x.id === this.state.selectedId);
    const onShape = !!sel && (sel.kind === "rect" || sel.kind === "ellipse");
    const onTool = this.state.tool === "rect" || this.state.tool === "ellipse";
    const filled =
      onShape && sel && (sel.kind === "rect" || sel.kind === "ellipse")
        ? sel.filled
        : this.state.props.filled;
    return { visible: onTool || onShape, filled };
  }

  /**
   * 调“大小”（线宽 / 橡皮半径 / 马赛克粒度），**只有滚轮这一个入口**。
   * 没有激活工具但选中了已画图形时，直接改那个图形本身 —— 属性栏的圆点已改成只读
   * 读数，若这里仍只改全局 props，选中图形就会变成谁也调不动的死值。
   */
  /** 属性栏的尺寸圆点也吃滚轮（绘图区之外唯一的调节入口） */
  adjustSize(dir: number): void {
    this.bumpSize(dir);
  }

  private bumpSize(dir: number): void {
    const p = this.state.props;
    const t = this.state.tool;
    if (!t) {
      const sel = this.state.shapes.find((x) => x.id === this.state.selectedId);
      if (sel && sel.kind !== "text" && sel.kind !== "step") {
        // 图形存**物理** px：步长与上下限都要按 scale 换算，
        // 否则 150% 屏上"上限 16"会提前卡在约 10.7 逻辑 px，且每格滚动也不等宽
        sel.width = clamp(sel.width + dir * this.scale, MIN_WIDTH * this.scale, MAX_WIDTH * this.scale);
        this.setProps({ width: clamp(Math.round(sel.width / this.scale), MIN_WIDTH, MAX_WIDTH) });
        this.touchShapes();
      }
      return;
    }
    // 数值不再有滚动气泡：改由属性栏圆点上的悬停读数显示（见 PropertyBar 的 SizeDot）
    if (t === "mosaic") {
      // 线条模式调笔刷直径（独立于线宽的范围）；填充模式调像素粒度/模糊半径
      if (p.mosaicMode === "line") {
        this.setProps({ mosaicBrush: clamp(p.mosaicBrush + dir * 2, MIN_MOSAIC_BRUSH, MAX_MOSAIC_BRUSH) });
      } else {
        this.setProps({ mosaicLevel: clamp(p.mosaicLevel + dir * 2, 2, 40) });
      }
    } else if (t === "eraser") {
      // 步长 ×2：范围放宽到 4–80 后，一格 1px 要滚 76 下太磨人
      this.setProps({ eraserRadius: clamp(p.eraserRadius + dir * 2, MIN_ERASER, MAX_ERASER) });
    } else if (t !== "text") {
      // 滚轮改宽：setProps 里那条 applyPropsToEditable 会顺手落到「刚画完那一支」上，
      // 所以这里只管改默认值，不必再单独摸一次图形（线宽与颜色、箭头样式同一条路）
      this.setProps({ width: clamp(p.width + dir, MIN_WIDTH, MAX_WIDTH) });
    }
  }

  private bumpStepNumber(dir: number): void {
    if (this.state.tool !== "step") return;
    this.setProps({ stepNo: Math.max(1, this.state.props.stepNo + dir) });
  }

  /** 图形命中（倒序 = 后画的在上层）；线类用加粗容差 */
  private shapeAt(p: Point): Shape | null {
    const shapes = this.state.shapes;
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (hitShape(shapes[i], p, this.scale)) return shapes[i];
    }
    return null;
  }

  private beginShape(p: Point): void {
    const kind = this.state.tool;
    if (!kind) return;
    if (kind === "text") {
      this.store.set({ pendingTextAt: { ...p } });
      this.mark();
      return;
    }
    const sc = this.scale;
    const props = this.state.props;
    const base = { id: this.nextShapeId++, color: props.color, width: props.width * sc };
    let shape: Shape;
    if (kind === "eraser") {
      // 橡皮擦产出一条 erase 图形，渲染时对标注层打洞（按区域擦，不整块删）：
      // path=笔刷折线擦除（width=笔刷直径），rect=框选擦除
      const w = props.eraserRadius * 2 * sc;
      shape = props.eraserRect
        ? { id: base.id, kind: "erase", color: props.color, width: w, mode: "rect", r: { x: p.x, y: p.y, w: 0, h: 0 } }
        : { id: base.id, kind: "erase", color: props.color, width: w, mode: "path", pts: [{ ...p }] };
    } else if (kind === "marker" && props.markerRect) {
      // 记号笔矩形模式：拖出半透明高亮框
      shape = { ...base, kind: "rect", r: { x: p.x, y: p.y, w: 0, h: 0 }, filled: true, marker: true };
    } else if (kind === "rect" || kind === "ellipse") {
      shape = { ...base, kind, r: { x: p.x, y: p.y, w: 0, h: 0 }, filled: props.filled };
    } else if (kind === "mosaic") {
      shape =
        props.mosaicMode === "line"
          ? {
              ...base,
              kind: "mosaic",
              r: { x: p.x, y: p.y, w: 0, h: 0 },
              pts: [{ ...p }],
              brush: props.mosaicBrush * sc,
              style: props.mosaicStyle,
              level: props.mosaicLevel,
            }
          : {
              ...base,
              kind: "mosaic",
              r: { x: p.x, y: p.y, w: 0, h: 0 },
              style: props.mosaicStyle,
              level: props.mosaicLevel,
            };
    } else if (kind === "arrow") {
      shape = {
        ...base,
        kind: "arrow",
        a: { ...p },
        b: { ...p },
        double: props.arrowDouble,
        head: props.arrowHead,
      };
    } else if (kind === "polyline" || kind === "marker") {
      shape = { ...base, kind, pts: [{ ...p }] };
    } else {
      shape = {
        ...base,
        kind: "step",
        at: { ...p },
        n: props.stepNo,
        radius: props.stepRadius * sc,
      };
    }
    this.pushUndo();
    this.store.set({
      shapes: [...this.state.shapes, shape],
      phase: "tool-drawing",
      selectedId: null,
    });
    if (kind === "step") {
      // 序号是单击盖章，不进入拖拽
      this.setProps({ stepNo: props.stepNo + 1 });
      this.store.set({ phase: "adjusting" });
    } else {
      this.anchor = { mode: "shape-new", start: p, id: shape.id };
    }
    this.mark();
  }

  private growShape(id: number, p: Point, e: PointerEvent): void {
    const shapes = this.state.shapes;
    const s = shapes.find((x) => x.id === id);
    const a = this.anchor;
    if (!s || a?.mode !== "shape-new") return;
    if (s.kind === "mosaic" && s.pts) {
      // 线条马赛克：沿鼠标轨迹加点（brush 笔刷在渲染时决定宽度）
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_POINT_DIST * this.scale) {
        s.pts.push({ x: p.x, y: p.y });
      }
    } else if (s.kind === "rect" || s.kind === "ellipse" || s.kind === "mosaic") {
      let dx = p.x - a.start.x;
      let dy = p.y - a.start.y;
      if (e.shiftKey) {
        const m = Math.min(Math.abs(dx), Math.abs(dy));
        dx = Math.sign(dx) * m;
        dy = Math.sign(dy) * m;
      }
      s.r = norm(a.start.x, a.start.y, dx, dy);
    } else if (s.kind === "arrow") {
      let b = { x: p.x, y: p.y };
      if (e.shiftKey) {
        const ang = Math.atan2(b.y - s.a.y, b.x - s.a.x);
        const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(b.x - s.a.x, b.y - s.a.y);
        b = { x: s.a.x + Math.cos(snap) * len, y: s.a.y + Math.sin(snap) * len };
      }
      s.b = b;
    } else if (s.kind === "marker") {
      // 记号笔线模式：只认起点→终点，画一条直线（不跟随鼠标中间轨迹）
      s.pts = [{ ...a.start }, { x: p.x, y: p.y }];
    } else if (s.kind === "polyline") {
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_POINT_DIST * this.scale) {
        s.pts.push({ x: p.x, y: p.y });
      }
    } else if (s.kind === "erase") {
      if (s.mode === "rect") {
        s.r = norm(a.start.x, a.start.y, p.x - a.start.x, p.y - a.start.y);
      } else if (s.pts) {
        const last = s.pts[s.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_POINT_DIST * this.scale) {
          s.pts.push({ x: p.x, y: p.y });
        }
      }
    }
    this.mark();
  }

  private settleShape(id: number): void {
    const s = this.state.shapes.find((x) => x.id === id);
    if (!s) return;
    let keep = true;
    if (s.kind === "mosaic" && s.pts) keep = s.pts.length > 1;
    else if (s.kind === "rect" || s.kind === "ellipse" || s.kind === "mosaic") keep = s.r.w > 2 && s.r.h > 2;
    else if (s.kind === "arrow") keep = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > 3;
    else if (s.kind === "polyline" || s.kind === "marker") keep = s.pts.length > 1;
    // 橡皮擦：单击（一个点）也要生效——擦一个笔刷大的点；矩形擦需拖出尺寸
    else if (s.kind === "erase") keep = s.mode === "rect" ? !!s.r && s.r.w > 2 && s.r.h > 2 : (s.pts?.length ?? 0) >= 1;
    if (keep) {
      this.touchShapes();
      // 留哪些句柄看 canEditShape：箭头两端、笔迹首末点、矩形/椭圆四角+四边中点 8 向
      this.editId = canEditShape(s) ? id : null;
      this.hotEdit = null;
      return;
    }
    // 太小的废图形丢弃，并把 beginShape 压的那次快照还原
    this.store.set({ shapes: this.state.shapes.filter((x) => x.id !== id) });
    const prev = this.past.pop();
    if (prev) this.store.set({ shapes: JSON.parse(prev) as Shape[], canUndo: this.past.length > 0 });
    this.mark();
  }

  private deleteSelected(): void {
    const id = this.state.selectedId;
    if (id === null) return;
    this.pushUndo();
    this.store.set({ shapes: this.state.shapes.filter((s) => s.id !== id), selectedId: null });
    if (this.editId === id) this.releaseEditHandles();
    this.mark();
  }

  private touchShapes(): void {
    this.store.set({ shapes: [...this.state.shapes] });
  }

  // ---------- 文字输入 ----------

  commitText(): void {
    const at = this.state.pendingTextAt;
    const text = this.pendingTextValue?.trim();
    if (!at) return;
    // 提交后保持文字工具激活：点别处=结束上一条，再点=直接开下一条（Snipaste 的连续标注）
    if (text) {
      const sc = this.scale;
      const p = this.state.props;
      this.pushUndo();
      this.store.set({
        shapes: [
          ...this.state.shapes,
          {
            id: this.nextShapeId++,
            kind: "text",
            color: p.color,
            width: 0,
            at: { ...at },
            text,
            fontPx: p.fontPx * sc,
            bg: p.textBg,
            bold: p.textBold,
            italic: p.textItalic,
            strike: p.textStrike,
            family: p.textFamily,
          },
        ],
        pendingTextAt: null,
      });
    } else {
      this.store.set({ pendingTextAt: null });
    }
    this.pendingTextValue = "";
    this.mark();
  }

  cancelText(): void {
    this.pendingTextValue = "";
    this.store.set({ pendingTextAt: null });
    this.mark();
  }

  /** 由 TextInput 组件双向同步 */
  pendingTextValue = "";

  // ---------- 撤销 / 重做（只作用于标注，不作用于选区） ----------

  private snapshot(): string {
    return JSON.stringify(this.state.shapes);
  }

  pushUndo(): void {
    this.past.push(this.snapshot());
    if (this.past.length > 60) this.past.shift();
    this.future.length = 0;
    this.store.set({ canUndo: true, canRedo: false });
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.snapshot());
    this.store.set({
      shapes: JSON.parse(prev) as Shape[],
      selectedId: null,
      canUndo: this.past.length > 0,
      canRedo: true,
    });
    // 快照是整串图形换掉的，句柄指向的对象已经不存在了
    this.releaseEditHandles();
    this.mark();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snapshot());
    this.store.set({
      shapes: JSON.parse(next) as Shape[],
      selectedId: null,
      canUndo: true,
      canRedo: this.future.length > 0,
    });
    this.releaseEditHandles();
    this.mark();
  }

  // ---------- 放大镜取色 ----------

  private async copyColor(toHex: boolean): Promise<void> {
    const p = this.pointer;
    if (!p || !this.reader) return;
    const [r, g, b] = this.reader.at(p.x, p.y);
    const text = toHex ? this.reader.hex(p.x, p.y) : `rgb(${r},${g},${b})`;
    this.store.set({ loupeFormat: toHex ? "hex" : "rgb" });
    try {
      await navigator.clipboard.writeText(text);
      this.store.set({ error: null });
    } catch {
      // WebView2 剪贴板权限受限时，颜色至少显示在放大镜上
      this.store.set({ error: "颜色已切换到 " + text });
    }
    this.mark();
  }

  // ---------- 提交与导出 ----------

  private virtualRect(r: Rect) {
    const b = this.boot.bounds;
    return { x: b.x + r.x, y: b.y + r.y, width: r.w, height: r.h };
  }

  /**
   * 惰性提交：只在导出时裁剪 + 编码 PNG。
   * 迁移前每次 pointerup 都提交一次，往永不清理的 selections HashMap 里塞一条 Sel；
   * 选区没变时复用已有 sel，等价于把 N 次拖框压成 1 次。
   */
  private async ensureSel(): Promise<number | null> {
    const sel = this.state.sel;
    if (!sel || sel.w < 1 || sel.h < 1) return null;
    // 重编辑：sel 在 loadFrame 时就定了，不再裁剪会话帧
    if (this.isEditor) return this.committedSelId;
    if (this.committedSelId !== null && rectEq(this.committedRect, sel)) return this.committedSelId;
    const r = await invoke<{ sel: number }>("commit_selection", {
      token: this.overlay!.token,
      rect: this.virtualRect(sel),
      source: "region",
      appHint: null,
    });
    this.committedSelId = r.sel;
    this.committedRect = { ...sel };
    return r.sel;
  }

  async finish(op: Op): Promise<void> {
    if (this.state.busy) return;
    const selId = await this.ensureSel();
    if (selId === null) return;
    this.store.set({ busy: true });
    const req: Record<string, unknown> = { sel: selId, op };
    if (this.state.shapes.length) {
      const png = await this.renderFinalPng();
      if (png) {
        req.pngBase64 = png;
        req.annotationJson = JSON.stringify({
          v: 2,
          shapes: this.state.shapes.map((s) => serializeShape(s, this.state.sel!)),
        });
      }
    }
    const res = await invoke<{ cancelled?: boolean }>("export_result", { req });
    // 保存被取消：宿主没关截图层（用户可继续操作），这里必须复位 busy，
    // 否则后续复制/贴图/保存全被开头的 `if (busy) return` 挡死
    if (res?.cancelled) this.store.set({ busy: false });
  }

  /** UI 与快捷键统一入口：失败必须可见，不能静默卡在截图态 */
  async run(op: Op): Promise<void> {
    // 输入框不再靠 blur 提交：走按钮/快捷键导出前，先把在编文字落定
    if (this.state.pendingTextAt) this.commitText();
    try {
      await this.finish(op);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.store.set({ busy: false, error: "导出失败：" + msg });
      console.error("finish failed", e);
      this.mark();
    }
  }

  /** 双击未框选的窗口：走两级抓取（内核逻辑不变） */
  private async cleanWindowCopy(w: SnapshotDto): Promise<void> {
    try {
      const r = await invoke<{ sel: number }>("capture_window_clean", {
        token: this.overlay!.token,
        windowId: w.windowId,
      });
      await invoke("export_result", { req: { sel: r.sel, op: "copy" } });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      this.store.set({ error: "取窗失败：" + msg });
      this.mark();
    }
  }

  private async renderFinalPng(): Promise<string | null> {
    const sel = this.state.sel;
    if (!sel || !this.frame) return null;
    const c = document.createElement("canvas");
    c.width = sel.w;
    c.height = sel.h;
    const cc = c.getContext("2d");
    if (!cc) return null;
    cc.drawImage(this.frame, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    // 图形整体平移到选区局部坐标系；马赛克取样用同样的偏移源图，才与屏上一致
    const src = croppedSource(this.frame, sel);
    drawShapes(
      cc,
      this.state.shapes.map((s) => offsetCopy(s, -sel.x, -sel.y)),
      { x: 0, y: 0, w: sel.w, h: sel.h },
      { source: src, scale: this.scale, scratch: makeScratch() },
    );
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return null;
    return u8ToB64(new Uint8Array(await blob.arrayBuffer()));
  }

  async cancel(): Promise<void> {
    try {
      if (this.overlay) await invoke("cancel_capture", { token: this.overlay.token });
    } catch {
      /* 会话可能已被宿主关掉 */
    }
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  }

  /** 首帧画完后由页面调用：一次 show 到位，不留空窗 */
  async reveal(): Promise<void> {
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  }
}

// ---------- 图形几何辅助 ----------

function translateShape(s: Shape, dx: number, dy: number): void {
  switch (s.kind) {
    case "rect":
    case "ellipse":
    case "mosaic":
      s.r.x += dx;
      s.r.y += dy;
      break;
    case "arrow":
      s.a.x += dx;
      s.a.y += dy;
      s.b.x += dx;
      s.b.y += dy;
      break;
    case "polyline":
    case "marker":
      for (const p of s.pts) {
        p.x += dx;
        p.y += dy;
      }
      break;
    case "text":
    case "step":
      s.at.x += dx;
      s.at.y += dy;
      break;
  }
}

/**
 * 把 o（pointerdown 时的快照）整体平移 (dx,dy) 写回 s。
 * 逐帧从原点重算而非累加，避免亚像素漂移。调用方保证 s 与 o 同 kind（同一个图形）。
 */
function applyFromOrigin(s: Shape, o: Shape, dx: number, dy: number): void {
  const move = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  if (s.kind !== o.kind) return;
  switch (s.kind) {
    case "rect":
    case "ellipse":
    case "mosaic": {
      const t = o as typeof s;
      s.r = { ...t.r, x: t.r.x + dx, y: t.r.y + dy };
      break;
    }
    case "arrow": {
      const t = o as typeof s;
      s.a = move(t.a);
      s.b = move(t.b);
      break;
    }
    case "polyline":
    case "marker": {
      const t = o as typeof s;
      s.pts = t.pts.map(move);
      break;
    }
    case "text":
    case "step": {
      const t = o as typeof s;
      s.at = move(t.at);
      break;
    }
  }
}

function hitShape(s: Shape, p: Point, scale: number): boolean {
  // 橡皮擦痕迹不可再选中/拖动，只作为擦除遮罩存在
  if (s.kind === "erase") return false;
  const tol = Math.max(4, (s.width ?? 0) / scale / 2 + 4) * scale;
  switch (s.kind) {
    case "mosaic":
      return inRect(s.r, p);
    case "rect":
    case "ellipse": {
      const r = s.r;
      if (s.filled) return inRect(r, p);
      const near =
        (Math.abs(p.x - r.x) <= tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol) ||
        (Math.abs(p.x - (r.x + r.w)) <= tol && p.y >= r.y - tol && p.y <= r.y + r.h + tol) ||
        (Math.abs(p.y - r.y) <= tol && p.x >= r.x - tol && p.x <= r.x + r.w + tol) ||
        (Math.abs(p.y - (r.y + r.h)) <= tol && p.x >= r.x - tol && p.x <= r.x + r.w + tol);
      return near;
    }
    case "arrow":
      return distToSegment(p, s.a, s.b) <= tol;
    case "polyline":
    case "marker":
      for (let i = 1; i < s.pts.length; i++) {
        if (distToSegment(p, s.pts[i - 1], s.pts[i]) <= tol) return true;
      }
      return false;
    case "text": {
      const w = Math.max(8, s.text.length * s.fontPx * 0.6);
      return inRect({ x: s.at.x, y: s.at.y, w, h: s.fontPx * 1.3 }, p);
    }
    case "step":
      return Math.hypot(p.x - s.at.x, p.y - s.at.y) <= s.radius + tol;
  }
}

const inRect = (r: Rect, p: Point) =>
  p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function offsetCopy(s: Shape, dx: number, dy: number): Shape {
  const copy = JSON.parse(JSON.stringify(s)) as Shape;
  translateShape(copy, dx, dy);
  return copy;
}

function serializeShape(s: Shape, sel: Rect): unknown {
  const copy = JSON.parse(JSON.stringify(s)) as Shape;
  translateShape(copy, -sel.x, -sel.y);
  return copy;
}

function croppedSource(frame: ImageBitmap, sel: Rect): CanvasImageSource {
  const c = document.createElement("canvas");
  c.width = sel.w;
  c.height = sel.h;
  const cc = c.getContext("2d");
  if (cc) cc.drawImage(frame, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
  return c;
}
