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

// 拖动移动（img 区域按住左键）
let drag = null;
img.addEventListener("pointerdown", async (e) => {
  if (e.button !== 0) return;
  const g = await ensureGeom();
  drag = { sx: e.clientX * g.scale, sy: e.clientY * g.scale, gx: g.x, gy: g.y, scale: g.scale };
  img.setPointerCapture(e.pointerId);
});
img.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const x = Math.round(drag.gx + (e.clientX * drag.scale - drag.sx));
  const y = Math.round(drag.gy + (e.clientY * drag.scale - drag.sy));
  invoke("pin_move", { x, y, w: geom.width, h: geom.height });
  geom.x = x; geom.y = y;
});
img.addEventListener("pointerup", () => { drag = null; });
img.addEventListener("dblclick", () => close());

alpha.addEventListener("input", () => { img.style.opacity = alpha.value / 100; });
$("close").addEventListener("click", () => close());
function close() { try { window.__TAURI__.window.getCurrentWindow().close(); } catch {} }
