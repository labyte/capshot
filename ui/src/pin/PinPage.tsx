//! 贴图窗（阶段 3b）。Snipaste 式：滚轮缩放（光标锚定）、Ctrl+滚轮透明度、中键复位、
//! 方向键微调 1px、1/2 旋转、3/4 翻转、Esc/双击关闭、Shift+双击缩略图、拖动即移动。
//!
//! 几何模型（定死，别改来改去）：
//!   窗口物理尺寸 = base + 2*PAD，base = 旋转后的图像外接盒 = imgSize(zoom, rot)
//!   元素 CSS 尺寸 = 未旋转的 natural*zoom / dpr，再用 CSS rotate 摆正 ——
//!     直接按旋转后的盒给元素尺寸，转 90° 会得到反向的比例
//!   dpr 用 window.devicePixelRatio（WebView2 每显示器 DPI 感知，等于该屏 scale），
//!     只有需要「当前窗口原点」时才对 pin_bounds 往返一次
//! 3c（贴图上直接涂画）与 3d（原生右键菜单）另做。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { invoke, bytesToBlobUrl } from "../shared/ipc";
import type { BootPin } from "../shared/types";
import { clamp } from "./geometry";

type BootPinWithPad = BootPin & { pad?: number };
interface Origin {
  x: number;
  y: number;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const THUMB_W = 170;

interface Size {
  w: number;
  h: number;
}

/** 旋转后的图像外接盒（物理 px） */
function baseBox(natural: Size, zoom: number, rot: number): Size {
  const swapped = rot % 180 !== 0;
  return {
    w: Math.max(1, Math.round((swapped ? natural.h : natural.w) * zoom)),
    h: Math.max(1, Math.round((swapped ? natural.w : natural.h) * zoom)),
  };
}

export default function PinPage() {
  const [boot, setBoot] = useState<BootPinWithPad | null>(null);
  const [src, setSrc] = useState("");
  const [zoom, setZoom] = useState(1);
  const [opacity, setOpacity] = useState(1);
  const [rot, setRot] = useState(0);
  const [flip, setFlip] = useState({ x: false, y: false });
  const [bubble, setBubble] = useState<string | null>(null);
  const [gray, setGray] = useState(false);
  const [invert, setInvert] = useState(false);
  const [through, setThrough] = useState(false);
  const [topmost, setTopmost] = useState(true);
  /** 菜单对象必须持有引用：注释里写了「前端只留句柄，Rust 侧存活菜单」，掉了句柄就点不动 */
  const menuRef = useRef<Menu | null>(null);
  /** 非 null = 缩略图模式，记录退出时要恢复的窗口几何 */
  const [thumbRestore, setThumbRestore] = useState<Origin & Size | null>(null);

  const padRef = useRef(16);
  const zoomRef = useRef(1);
  const rotRef = useRef(0);
  const thumbRef = useRef<Origin & Size | null>(null);
  const timer = useRef<number | null>(null);
  const dpr = window.devicePixelRatio || 1;

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    rotRef.current = rot;
  }, [rot]);
  useEffect(() => {
    thumbRef.current = thumbRestore;
  }, [thumbRestore]);

  const toast = useCallback((text: string) => {
    setBubble(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setBubble(null), 900);
  }, []);

  // 宿主侧也能改穿透态（托盘「解除所有贴图穿透」、全局热键命中不到窗时清全部），
  // 本地状态必须跟着同步，否则菜单文案会说谎
  useEffect(() => {
    const un = listen<{ action?: string }>("pin-menu", (e) => {
      const a = e.payload?.action;
      if (a === "through-on") setThrough(true);
      else if (a === "through-off") setThrough(false);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  // ---------- 装载 ----------
  useEffect(() => {
    (async () => {
      const b = await invoke<BootPinWithPad>("bootstrap");
      if (b.kind !== "pin") return;
      padRef.current = typeof b.pad === "number" ? b.pad : 16;
      setBoot(b);
      const buf = await invoke<ArrayBuffer>("get_selection_png", { sel: b.sel });
      setSrc(bytesToBlobUrl(buf, "image/png"));
      await invoke("pin_ready");
    })().catch((e) => console.error("pin bootstrap failed", e));
  }, []);

  const naturalOf = useCallback(
    (): Size => ({ w: boot?.width ?? 1, h: boot?.height ?? 1 }),
    [boot],
  );

  /** 目标窗口几何（物理 px）；缩略图模式改用固定宽度 */
  const windowFor = useCallback((z: number, r: number, thumb: boolean): Origin & Size => {
    const pad = padRef.current;
    const base = baseBox(naturalOf(), z, r);
    if (thumb) {
      const th = Math.max(1, Math.round((base.h / base.w) * THUMB_W));
      return { x: 0, y: 0, w: THUMB_W + pad * 2, h: th + pad * 2 };
    }
    return { x: 0, y: 0, w: base.w + pad * 2, h: base.h + pad * 2 };
  }, [naturalOf]);

  const applyWindow = useCallback(
    async (geo: Origin & Size) => {
      await invoke("pin_move", { x: Math.round(geo.x), y: Math.round(geo.y), w: geo.w, h: geo.h });
    },
    [],
  );

  const origin = useCallback(async (): Promise<Origin & Size> => {
    const g = await invoke<{ x: number; y: number; width: number; height: number }>("pin_bounds");
    return { x: g.x, y: g.y, w: g.width, h: g.height };
  }, []);

  /**
   * 缩放。anchorCss 非空时保持该 CSS 坐标下的像素不动（滚轮在光标处缩放）；
   * 为空时保持窗口中心不动。
   */
  const resizeTo = useCallback(
    async (nextZoom: number, anchorCss: { x: number; y: number } | null, thumb: boolean) => {
      const cur = await origin();
      const pad = padRef.current;
      const z = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      const target = windowFor(z, rotRef.current, thumb);
      let x = cur.x;
      let y = cur.y;
      if (anchorCss) {
        const ax = cur.x + anchorCss.x * dpr;
        const ay = cur.y + anchorCss.y * dpr;
        const oldImg = { x: cur.x + pad, y: cur.y + pad, w: cur.w - pad * 2, h: cur.h - pad * 2 };
        const fx = (ax - oldImg.x) / Math.max(1, oldImg.w);
        const fy = (ay - oldImg.y) / Math.max(1, oldImg.h);
        x = ax - fx * (target.w - pad * 2) - pad;
        y = ay - fy * (target.h - pad * 2) - pad;
      } else {
        x = cur.x + (cur.w - target.w) / 2;
        y = cur.y + (cur.h - target.h) / 2;
      }
      setZoom(z);
      await applyWindow({ ...target, x, y });
      return z;
    },
    [applyWindow, dpr, origin, windowFor],
  );

  const zoomBy = useCallback(
    async (factor: number, anchorCss: { x: number; y: number } | null) => {
      const z = clamp(zoomRef.current * factor, MIN_ZOOM, MAX_ZOOM);
      if (z === zoomRef.current) return;
      const applied = await resizeTo(z, anchorCss, !!thumbRef.current);
      toast(`${Math.round(applied * 100)}%`);
    },
    [resizeTo, toast],
  );

  const changeOpacity = useCallback(
    (delta: number) => {
      const n = clamp(Math.round((opacity + delta) * 100) / 100, 0.1, 1);
      setOpacity(n);
      toast(`${Math.round(n * 100)}%`);
    },
    [opacity, toast],
  );

  // ---------- 滚轮 ----------
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey) {
        changeOpacity(e.deltaY < 0 ? 0.05 : -0.05);
        return;
      }
      void zoomBy(Math.pow(1.0015, -e.deltaY), { x: e.clientX, y: e.clientY });
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [changeOpacity, zoomBy]);

  // ---------- 旋转：窗口中心不动，外接盒随 rot 交换 ----------
  const rotateBy = useCallback(
    async (delta: number) => {
      const nextRot = (rotRef.current + delta + 360) % 360;
      const cur = await origin();
      const target = windowFor(zoomRef.current, nextRot, !!thumbRef.current);
      setRot(nextRot);
      await applyWindow({ ...target, x: cur.x + (cur.w - target.w) / 2, y: cur.y + (cur.h - target.h) / 2 });
    },
    [applyWindow, origin, windowFor],
  );

  // ---------- 缩略图模式 ----------
  const toggleThumb = useCallback(async () => {
    const cur = await origin();
    if (thumbRef.current) {
      const back = thumbRef.current;
      setThumbRestore(null);
      thumbRef.current = null;
      await applyWindow(back);
      return;
    }
    setThumbRestore(cur);
    thumbRef.current = cur;
    const target = windowFor(zoomRef.current, rotRef.current, true);
    await applyWindow({ ...target, x: cur.x, y: cur.y });
  }, [applyWindow, origin, windowFor]);

  const exportOp = useCallback(
    async (op: "copy" | "save") => {
      if (!boot) return;
      try {
        await invoke("export_result", { req: { sel: boot.sel, op } });
        toast(op === "copy" ? "已复制" : "已保存");
      } catch (e) {
        toast("失败：" + String((e as Error)?.message ?? e));
      }
    },
    [boot, toast],
  );

  // ---------- 键盘 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const win = getCurrentWindow();
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (mod && k === "w") {
        e.preventDefault();
        void win.close();
        return;
      }
      if (mod && (k === "c" || k === "s")) {
        e.preventDefault();
        void exportOp(k === "c" ? "copy" : "save");
        return;
      }
      if (mod && (k === "+" || k === "=" || k === "-")) {
        e.preventDefault();
        void zoomBy(k === "-" ? 1 / 1.1 : 1.1, null);
        return;
      }
      if (mod) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          void win.close();
          break;
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          e.preventDefault();
          const d: Record<string, [number, number]> = {
            ArrowLeft: [-1, 0],
            ArrowRight: [1, 0],
            ArrowUp: [0, -1],
            ArrowDown: [0, 1],
          };
          const [dx, dy] = d[e.key];
          void (async () => {
            const cur = await origin();
            await applyWindow({ ...cur, x: cur.x + dx, y: cur.y + dy });
          })();
          break;
        }
        case "+":
        case "=":
          e.preventDefault();
          void zoomBy(1.1, null);
          break;
        case "-":
          e.preventDefault();
          void zoomBy(1 / 1.1, null);
          break;
        case "1":
          void rotateBy(270);
          break;
        case "2":
          void rotateBy(90);
          break;
        case "3":
          setFlip((f) => ({ ...f, x: !f.x }));
          break;
        case "4":
          setFlip((f) => ({ ...f, y: !f.y }));
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyWindow, exportOp, origin, rotateBy, toast, zoomBy]);

  // ---------- 拖动 / 中键复位 ----------
  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button === 1) {
        e.preventDefault();
        void (async () => {
          await resizeTo(1, null, false);
          setThumbRestore(null);
          thumbRef.current = null;
          setOpacity(1);
          toast("已复位");
        })();
        return;
      }
      if (e.button !== 0) return;
      const start = { x: e.clientX, y: e.clientY };
      const win = getCurrentWindow();
      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
      };
      const onMove = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) {
          stop();
          void win.startDragging().catch(() => {});
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [resizeTo, toast],
  );

  const onDblClick = useCallback(
    (e: ReactMouseEvent) => {
      if (e.shiftKey) {
        void toggleThumb();
        return;
      }
      void getCurrentWindow().close();
    },
    [toggleThumb],
  );

  // ---------- 右键菜单（JS 侧构造，popup 到光标） ----------
  // 走前端 menu API 而不是 Rust：Manager::get_window 在 tauri 的 `unstable` feature 后面
  // （lib.rs:567），不开该 feature 就拿不到 popup_at 要的 owned Window<R>；
  // 而 core:menu:default 已把全部菜单命令授予前端。
  const openMenu = useCallback(
    async (e: ReactMouseEvent) => {
      e.preventDefault();
      if (!boot) return;
      const item = (text: string, action: () => void) => MenuItem.new({ text, action });
      const sep = () => PredefinedMenuItem.new({ item: "Separator" });
      const opacity = await Submenu.new({
        text: "不透明度",
        items: [50, 75, 100].map((n) => ({
          text: `${n}%`,
          action: () => {
            setOpacity(n / 100);
            toast(`${n}%`);
          },
        })),
      });
      const menu = await Menu.new({
        items: [
          await item("复制到剪贴板", () => void exportOp("copy")),
          await item("保存", () => void exportOp("save")),
          await item("重新编辑…", () => void invoke("open_editor_window", { sel: boot.sel })),
          await sep(),
          await item("恢复原始大小", () => void resizeTo(1, null, false)),
          await item("放大", () => void zoomBy(1.2, null)),
          await item("缩小", () => void zoomBy(1 / 1.2, null)),
          await item("缩略图模式", () => void toggleThumb()),
          opacity,
          await sep(),
          await item(gray ? "取消灰度" : "灰度", () => setGray((v) => !v)),
          await item(invert ? "取消反色" : "反色", () => setInvert((v) => !v)),
          await item(through ? "关闭鼠标穿透" : "鼠标穿透", async () => {
            const next = !through;
            setThrough(next);
            await invoke("pin_set_through", { on: next });
          }),
          await item(topmost ? "取消置顶" : "保持置顶", async () => {
            const next = !topmost;
            setTopmost(next);
            await invoke("pin_set_top", { on: next });
          }),
          await sep(),
          await item("关闭 (Esc)", () => void getCurrentWindow().close()),
          await item("关闭所有贴图", () => void invoke("close_all_pins")),
        ],
      });
      menuRef.current = menu;
      await menu.popup(new LogicalPosition(e.clientX, e.clientY));
    },
    [resizeTo, boot, exportOp, gray, invert, through, toast, toggleThumb, topmost, zoomBy],
  );

  if (!boot || !src) return null;

  const natural = naturalOf();
  const pad = padRef.current;
  // 元素保持**未旋转**尺寸并居中，旋转交给 CSS —— 见文件头注释
  const elW = (natural.w * zoom) / dpr;
  const elH = (natural.h * zoom) / dpr;
  const thumbScale = thumbRestore ? THUMB_W / baseBox(natural, zoom, rot).w : 1;

  return (
    <div
      className="pin-root"
      style={{ padding: `${pad / dpr}px` }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDblClick}
      onContextMenu={openMenu}
    >
      <div className="pin-stage">
        <img
          src={src}
          alt=""
          draggable={false}
          className="pin-img"
          style={{
            width: `${elW}px`,
            height: `${elH}px`,
            opacity,
            // 内联 filter 会覆盖 .pin-img 的 CSS filter，所以投影要一起写在这里
            filter: `drop-shadow(0 2px 8px rgba(0,0,0,.45))${gray ? " grayscale(1)" : ""}${
              invert ? " invert(1)" : ""
            }`,
            // 容器是 flex 居中的 .pin-root，图像本身就是几何盒，不再叠 translate(-50%,-50%)
            transform: `rotate(${rot}deg) scale(${thumbScale}) scaleX(${flip.x ? -1 : 1}) scaleY(${
              flip.y ? -1 : 1
            })`,
          }}
        />
      </div>

      {/* 悬浮操作栏已移除：复制/存图/缩略/关闭全走右键菜单与快捷键
          （Ctrl+C / Ctrl+S / Shift+双击 / Esc），鼠标移入不再弹条 */}
      {bubble && <div className="pin-bubble">{bubble}</div>}
    </div>
  );
}
