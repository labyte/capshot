//! overlay 命令式引擎：事件、rAF 绘制趟、状态机、IPC。
//! React 只在**交互边界**读 store；每帧连续数据走 ref，不进 store、不触发渲染。

import { invoke, u8ToB64 } from "../../shared/ipc";
import { getCurrentWindow, PhysicalPosition } from "@tauri-apps/api/window";
import { createStore } from "./store";
import { paint } from "./painter";
import { PixelReader } from "./pixelReader";
import { makeScratch } from "../../annotate/mosaic";
import { drawShapes } from "../../annotate/render";
import { DEFAULT_PROPS, type DrawProps, type Shape } from "../../annotate/model";
import { parse as parseAnnotation } from "../../annotate/serialize";
import {
  clamp,
  CURSOR_FOR_HANDLE,
  handlePoints,
  moveRect,
  norm,
  rectEq,
  type Handle,
  type Phase,
  type Point,
  type Rect,
  type ToolId,
} from "./types";
import type { BootCtx, BootOverlay, SnapshotDto } from "../../shared/types";

export const ACCENT = "#4c9ff5";
const MASK_ALPHA = 0.5;
/** 折线/马克笔的落点抽稀阈值（物理 px），不抽稀一次拖拽会攒几千个点 */
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
    this.loop();
    return true;
  }

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
    c.addEventListener("pointerup", this.onPointerUp);
    c.addEventListener("pointercancel", this.onPointerUp);
    c.addEventListener("wheel", this.onWheel, { passive: false });
    c.addEventListener("dblclick", this.onDblClick);
    c.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onResize);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    const c = this.canvas;
    c.removeEventListener("pointerdown", this.onPointerDown);
    c.removeEventListener("pointermove", this.onPointerMove);
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

  private loop(): void {
    if (this.disposed) return;
    if (this.dirty) {
      this.dirty = false;
      this.draw();
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  private draw(): void {
    if (!this.frame) return;
    const s = this.state;
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
        accent: ACCENT,
        maskAlpha: MASK_ALPHA,
        handleSize: this.handleSize,
      },
    );
    this.publishFrameInfo();
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

  private updateCursor(): void {
    const s = this.state;
    const p = this.pointer;
    let c = "crosshair";
    if (s.pendingTextAt) c = "text";
    else if (s.phase === "adjusting" && !s.tool && p) {
      const h = this.hitHandle(p);
      if (h) c = CURSOR_FOR_HANDLE[h];
      else if (this.inSel(p)) c = "move";
    }
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
  }

  // ---------- 指针 ----------

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 2) return; // 右键交给 contextmenu
    if (e.button !== 0 && e.button !== 1) return;
    const p = this.evPos(e);
    this.pointer = p;
    const s = this.state;

    if (e.button === 1) {
      if (s.sel) void this.run("pin");
      return;
    }
    if (s.pendingTextAt) {
      this.commitText();
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);

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
      this.updateCursor();
      this.mark();
      return;
    }

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
      const dx = p.x - a.start.x;
      const dy = p.y - a.start.y;
      const r = a.rect0;
      let { x, y, w, h } = { x: r.x, y: r.y, w: r.w, h: r.h };
      if (a.handle.includes("w")) {
        x = r.x + dx;
        w = r.w - dx;
      }
      if (a.handle.includes("e")) w = r.w + dx;
      if (a.handle.includes("n")) {
        y = r.y + dy;
        h = r.h - dy;
      }
      if (a.handle.includes("s")) h = r.h + dy;
      this.store.set({ sel: norm(x, y, w, h) });
    } else if (a.mode === "move") {
      this.store.set({ sel: moveRect(a.rect0, p.x - a.start.x, p.y - a.start.y, bound) });
    } else if (a.mode === "shape-new") {
      this.growShape(a.id, p, e);
    } else if (a.mode === "shape-move") {
      const sh = this.state.shapes.find((x) => x.id === a.id);
      if (sh) applyFromOrigin(sh, a.origin, p.x - a.start.x, p.y - a.start.y);
    }
    this.updateCursor();
    this.mark();
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
    } else {
      this.store.set({ phase: "adjusting", toolbarVisible: true });
    }
    this.mark();
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.state.tool) this.bumpWidth(e.deltaY < 0 ? 1 : -1);
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
    if (k === "[" || k === "]" || k === "1" || k === "2") {
      e.preventDefault();
      this.bumpWidth(k === "[" || k === "1" ? -1 : 1);
      return;
    }

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
    this.store.set({ tool: t, selectedId: null });
    this.mark();
  }

  setProps(patch: Partial<DrawProps>): void {
    this.store.set({ props: { ...this.state.props, ...patch } });
    this.mark();
  }

  private bumpWidth(dir: number): void {
    this.setProps({ width: clamp(this.state.props.width + dir, 1, 24) });
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
    if (kind === "rect" || kind === "ellipse") {
      shape = { ...base, kind, r: { x: p.x, y: p.y, w: 0, h: 0 }, filled: props.filled };
    } else if (kind === "mosaic") {
      shape = {
        ...base,
        kind: "mosaic",
        r: { x: p.x, y: p.y, w: 0, h: 0 },
        style: props.mosaicStyle,
        level: props.mosaicLevel,
      };
    } else if (kind === "arrow") {
      shape = { ...base, kind: "arrow", a: { ...p }, b: { ...p } };
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
    if (s.kind === "rect" || s.kind === "ellipse" || s.kind === "mosaic") {
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
    } else if (s.kind === "polyline" || s.kind === "marker") {
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= MIN_POINT_DIST * this.scale) {
        s.pts.push({ x: p.x, y: p.y });
      }
    }
    this.mark();
  }

  private settleShape(id: number): void {
    const s = this.state.shapes.find((x) => x.id === id);
    if (!s) return;
    let keep = true;
    if (s.kind === "rect" || s.kind === "ellipse" || s.kind === "mosaic") keep = s.r.w > 2 && s.r.h > 2;
    else if (s.kind === "arrow") keep = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) > 3;
    else if (s.kind === "polyline" || s.kind === "marker") keep = s.pts.length > 1;
    if (keep) {
      this.touchShapes();
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
    if (text) {
      const sc = this.scale;
      this.pushUndo();
      this.store.set({
        shapes: [
          ...this.state.shapes,
          {
            id: this.nextShapeId++,
            kind: "text",
            color: this.state.props.color,
            width: 0,
            at: { ...at },
            text,
            fontPx: this.state.props.fontPx * sc,
            bg: this.state.props.textBg,
          },
        ],
        pendingTextAt: null,
        tool: null,
      });
    } else {
      this.store.set({ pendingTextAt: null, tool: null });
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
    await invoke("export_result", { req });
  }

  /** UI 与快捷键统一入口：失败必须可见，不能静默卡在截图态 */
  async run(op: Op): Promise<void> {
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
