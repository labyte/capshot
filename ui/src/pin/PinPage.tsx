//! 贴图窗（阶段 3b）。Snipaste 式：滚轮缩放（光标锚定）、Ctrl+滚轮透明度、中键复位、
//! 方向键微调 1px、1/2 旋转、3/4 翻转、Esc/双击关闭、Shift+双击缩略图、拖动即移动。
//!
//! 几何模型（定死，别改来改去）：
//!   窗口物理尺寸 = base + 2*PAD，base = 旋转后的图像外接盒 = imgSize(zoom, rot)
//!   元素 CSS 尺寸 = 未旋转的 natural*zoom / dpr，再用 CSS rotate 摆正 ——
//!     直接按旋转后的盒给元素尺寸，转 90° 会得到反向的比例
//!   dpr 用 window.devicePixelRatio（WebView2 每显示器 DPI 感知，等于该屏 scale），
//!     只有需要「当前窗口原点」时才对 pin_bounds 往返一次
//! 3d（原生右键菜单）已做，但三项功能因宿主侧行为不正确被暂时摘掉 —— 见 openMenu 里的
//! 「待办」注释块与 docs/testing-windows.md「贴图右键菜单：待办」。3c（贴图上直接涂画）另做。

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

  /**
   * 恢复原始大小：zoom→1 并退出缩略图模式，旋转/翻转/透明度/灰度一概不动
   * （那是中键「已复位」的活）。
   *
   * 缩略图态必须跟着一起清 —— 只把窗口尺寸按整图放大，而 thumbScale 还按
   * THUMB_W/base.w 缩着，结果就是「大窗口里一张小图 + 一圈空白」。
   * 菜单项和中键复位共用这一份，别再各写一遍走岔。
   */
  const resetZoom = useCallback(async () => {
    await resizeTo(1, null, false);
    setThumbRestore(null);
    thumbRef.current = null;
  }, [resizeTo]);

  /**
   * Ctrl+C / Ctrl+S 的出口。
   *
   * ⚠ 走的是截图层那条 export_result，带三个不该有的副作用（历史窗重复入库、
   * 改写 last_rect、关掉正在进行的会话 overlay）—— 详见 openMenu 里的「待办 P1」。
   * 右键菜单上的「复制到剪贴板 / 保存」已因此隐藏，这两个快捷键仍留在原行为上：
   * 摘掉它们等于贴图完全没有出图口，属于功能回退，等 export_core 支持 from_pin
   * 再一起收口。
   */
  const exportOp = useCallback(
    async (op: "copy" | "save") => {
      if (!boot) return;
      try {
        const res = await invoke<{ cancelled?: boolean }>("export_result", { req: { sel: boot.sel, op } });
        if (res?.cancelled) return; // 另存为被取消：不提示
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
          await resetZoom();
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
    [resetZoom, toast],
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
  // 而 core:menu:default（capabilities 里的 core:default 已含）把全部菜单命令授予前端。
  // popup 的 at 是**窗口客户区**相对坐标（tauri/src/menu/mod.rs:728 → muda 内部 ClientToScreen），
  // 所以直接喂 e.clientX/clientY 的逻辑像素就对。
  //
  // ⚠ 有三项功能被暂时摘掉（复制 / 保存 / 重新编辑），成因与恢复条件
  //   写在下面的「待办」注释块里，另见 docs/testing-windows.md「贴图右键菜单：待办」一节。
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
          // ───────────────── 待办：以下三项暂时隐藏 ─────────────────
          //
          // P1 「复制到剪贴板」/「保存」—— 两者都调 export_result，而 export_core
          //    （commands.rs）是为**截图层**写的一条龙：无条件 `history.insert()` +
          //    落 PNG/JPEG 两个文件，末尾还 `close_session_overlays()` 并把
          //    `last_rect` 改写成贴图自己的 rect。后果：
          //      · 贴图每复制/保存一次，历史窗就多一条**同图重复**条目（贴图那张
          //        在 op="pin" 时已经入过一次库了）；
          //      · 「H 恢复上次选区」被贴图的 rect 顶掉；
          //      · 顺带关掉正在进行的截图会话 overlay。
          //    另外导出的是 `sel` 的原始像素，旋转/翻转/灰度/反色都是 CSS 层的，
          //    不会被烘进去 —— 与屏上所见不一致。
          //    恢复条件：ExportReq 加 `from_pin`（或 `skip_history`）标记，export_core
          //    据此跳过入库/关会话/写 last_rect；并决定要不要把当前变换烘进导出图。
          //
          // P1 「重新编辑…」—— open_editor_window(sel) 拿到的是**已烘焙**的 sel.png
          //    当底图，而 bootstrap 同时把 `s.annotation` 交回给编辑器，
          //    controller.loadFrame() 再 parseAnnotation 还原一遍图形 →
          //    带标注截出来的贴图，进编辑器后**标注画两遍**。
          //    另外编辑器是普通窗、贴图是 always-on-top，两者重叠时编辑器被压在下面；
          //    且编辑导出后贴图不会刷新（img src 是启动时取的 blob URL）。
          //    恢复条件：底图与 annotation 二选一（存原图 + 图形，或存烘焙图 + 不还原），
          //    并在导出后回推贴图重载。
          //
          // await item("复制到剪贴板", () => void exportOp("copy")),
          // await item("保存", () => void exportOp("save")),
          // await item("重新编辑…", () => void invoke("open_editor_window", { sel: boot.sel })),
          // ─────────────────────────────────────────────────────────

          // 缩放组：zoomBy 走 zoomRef，且内部按 thumbRef 决定是否保持缩略图宽度，
          // 与滚轮/`+`/`-` 是同一条路径。
          // 「恢复原始大小」走 resetZoom（zoom→1 + 退出缩略图模式），与中键复位共用一份实现。
          await item("恢复原始大小", () =>
            void (async () => {
              await resetZoom();
              toast("100%");
            })(),
          ),
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
    [boot, gray, invert, resetZoom, through, toast, toggleThumb, topmost, zoomBy],
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
