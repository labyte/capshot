// 钉图窗口：缩放(滚轮，锚定光标)、透明度、拖动、关闭。
import { invoke } from "../shared.js";

const $ = (id) => document.getElementById(id);
const img = $("img"), alpha = $("alpha");
let boot;

(async () => {
  boot = await invoke("bootstrap");
  if (boot.kind !== "pin") return;
  const bytes = await invoke("get_selection_png", { sel: boot.sel });
  img.src = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
})();

let geom = null; // {x,y,width,height,scale}
async function ensureGeom() { if (!geom) geom = await invoke("pin_bounds"); return geom; }

// 滚轮缩放（光标锚定）
window.addEventListener("wheel", async (e) => {
  e.preventDefault();
  const g = await ensureGeom();
  const f = Math.pow(1.0015, -e.deltaY);
  const min = g.width * 0.2, max = g.width * 8;
  const w = Math.max(min, Math.min(max, Math.round(g.width * f)));
  if (w === g.width) return;
  const r = w / g.width;
  const h = Math.round(g.height * r);
  const rect = document.documentElement.getBoundingClientRect();
  const cx = g.x + (e.clientX * g.scale);
  const cy = g.y + (e.clientY * g.scale);
  const x = Math.round(cx - (cx - g.x) * r);
  const y = Math.round(cy - (cy - g.y) * r);
  geom = { x, y, width: w, height: h, scale: g.scale };
  await invoke("pin_move", { x, y, w, h });
  $("zoomLabel").textContent = Math.round(w / (boot?.width || w) * 100) + "%";
}, { passive: false });

// 拖动：位移超阈值后交给系统原生拖拽循环（零 IPC、跟手不卡顿）；
// 未移动的点击与双击不受影响（双击关闭仍由 dblclick 处理）
img.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const start = { x: e.clientX, y: e.clientY };
  const win = window.__TAURI__.window.getCurrentWindow();
  const stop = () => {
    img.removeEventListener("pointermove", onMove);
    img.removeEventListener("pointerup", stop);
    img.removeEventListener("pointercancel", stop);
  };
  const onMove = (ev) => {
    if (Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) > 4) {
      stop();
      geom = null; // 原生拖拽改变了窗口几何，下次缩放前重新取
      win.startDragging().catch(() => {});
    }
  };
  img.addEventListener("pointermove", onMove);
  img.addEventListener("pointerup", stop);
  img.addEventListener("pointercancel", stop);
});
img.addEventListener("dblclick", () => {
  try { window.__TAURI__.window.getCurrentWindow().close(); } catch {}
});

alpha.addEventListener("input", () => { img.style.opacity = alpha.value / 100; });
