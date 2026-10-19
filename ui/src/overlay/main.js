// overlay：冻结帧框选 + 窗口吸附 + 放大镜 + 标注 + 复制/保存/钉图。
// 内部坐标一律物理像素、本显示器局部；提交时换算为虚拟屏坐标（capture-core 契约）。
import { invoke, u8ToB64 } from "../shared.js";

const $ = (id) => document.getElementById(id);
// alpha 画布：帧未画好前画布透明 → 透出真实屏幕；画好后不透明冻结帧覆盖。
// 免去 visibility 切换，消除"先黑/先透再画面"的闪烁
const view = $("view"), ctx = view.getContext("2d");
const magEl = $("magnifier"), magCv = $("mag"), magCtx = magCv.getContext("2d"), magInfo = $("magInfo");
const toolbar = $("toolbar"), flash = $("flash"), textInput = $("textInput"), textValue = $("textValue");

let boot, bm, mosaicCv;            // 启动数据 / 冻结帧位图 / 马赛克缓存
let scale = 2;
let bounds = { x: 0, y: 0, width: 0, height: 0 };
let mode = "idle";                 // idle | draw | edit
let rect = null;                   // {x,y,w,h} 物理
let anchor = null;                 // 拖拽起点 {x,y,rect0,handle}
let hover = null;                  // 吸附候选 {x,y,w,h}
let tool = null;                   // null|rect|arrow|text|mosaic
let shapes = [], undoStack = [];
let sel = null;                    // 提交后的选区 id
let pendingTextInputShape = null;
let committing = false;

const HANDLE_R = () => 6 * scale;

// ---------- 启动 ----------
(async function init() {
  boot = await invoke("bootstrap");
  if (boot.kind !== "overlay") { view.style.cursor = "default"; return; }
  bounds = boot.bounds; scale = boot.scale || 2;
  view.width = bounds.width; view.height = bounds.height;
  document.documentElement.style.setProperty("--scale", scale);
  try {
    const buf = await invoke("get_monitor_frame", { token: boot.token, monitor: boot.monitor });
    bm = await createImageBitmap(new Blob([buf], { type: "image/png" }));
  } catch (e) { console.error(e); }
  buildMosaic();
  buildToolbar();
  render();
  // 透明窗 + 画布就绪前不可见：帧数据到位前一帧都不盖任何东西，
  // 显示瞬间即完整冻结帧，无空窗/无淡入（DWM 过渡已在 Rust 侧禁用）
  const win = window.__TAURI__.window.getCurrentWindow();
  if (bm) {
    await win.show();
    await win.setFocus();
  } else {
    try { await invoke("cancel_capture", { token: boot.token }); } catch {}
    try { await win.close(); } catch {}
  }
})();

function buildMosaic() {
  if (!bm) return;
  const sw = Math.max(1, Math.floor(bm.width / 8)), sh = Math.max(1, Math.floor(bm.height / 8));
  const s1 = document.createElement("canvas"); s1.width = sw; s1.height = sh;
  const c1 = s1.getContext("2d"); c1.imageSmoothingEnabled = true;
  c1.drawImage(bm, 0, 0, sw, sh);
  mosaicCv = document.createElement("canvas"); mosaicCv.width = bm.width; mosaicCv.height = bm.height;
  const c2 = mosaicCv.getContext("2d"); c2.imageSmoothingEnabled = false;
  c2.drawImage(s1, 0, 0, bm.width, bm.height);
}

// ---------- 渲染 ----------
function render() {
  if (!bm) return;
  ctx.drawImage(bm, 0, 0);
  ctx.save();
  if (mode === "idle" && hover) {
    ctx.strokeStyle = "#3f6fd8"; ctx.lineWidth = 2 * scale;
    ctx.strokeRect(hover.x, hover.y, hover.w, hover.h);
  }
  if (rect && rect.w > 0 && rect.h > 0) {
    // 选区外压暗
    ctx.fillStyle = "rgba(0,0,0,.45)";
    const { x, y, w, h } = rect;
    ctx.fillRect(0, 0, bm.width, y);
    ctx.fillRect(0, y + h, bm.width, bm.height - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, bm.width - x - w, h);
    ctx.strokeStyle = "#5b9cff"; ctx.lineWidth = 1 * scale;
    ctx.strokeRect(x, y, w, h);
    drawShapes(ctx, rect, 0, 0);
    if (mode === "edit") drawHandles();
    showReadout();
  }
  ctx.restore();
}

function drawShapes(c, clipRect, dx, dy) {
  for (const s of shapes) {
    c.save();
    if (clipRect) { c.beginPath(); c.rect(clipRect.x, clipRect.y, clipRect.w, clipRect.h); c.clip(); }
    if (s.kind === "rect") {
      c.strokeStyle = s.color; c.lineWidth = s.w; c.strokeRect(s.x + dx, s.y + dy, s.w2, s.h2);
    } else if (s.kind === "arrow") {
      drawArrow(c, s, dx, dy);
    } else if (s.kind === "text") {
      c.fillStyle = s.color; c.font = `${s.fontPx}px -apple-system, "Segoe UI", sans-serif`;
      c.textBaseline = "top";
      c.fillStyle = "rgba(0,0,0,.35)";
      const m = c.measureText(s.text);
      c.fillRect(s.x + dx - 2, s.y + dy - 2, m.width + 4, s.fontPx + 4);
      c.fillStyle = s.color; c.fillText(s.text, s.x + dx, s.y + dy);
    } else if (s.kind === "mosaic") {
      if (mosaicCv) c.drawImage(mosaicCv, s.x, s.y, s.w2, s.h2, s.x + dx, s.y + dy, s.w2, s.h2);
    }
    c.restore();
  }
}

function drawArrow(c, s, dx, dy) {
  const x1 = s.x + dx, y1 = s.y + dy, x2 = s.x2 + dx, y2 = s.y2 + dy;
  const ang = Math.atan2(y2 - y1, x2 - x1), head = Math.max(10 * scale, s.w * 3);
  c.strokeStyle = c.fillStyle = s.color; c.lineWidth = s.w; c.lineCap = "round";
  c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
  c.beginPath();
  c.moveTo(x2, y2);
  c.lineTo(x2 - head * Math.cos(ang - 0.5), y2 - head * Math.sin(ang - 0.5));
  c.lineTo(x2 - head * Math.cos(ang + 0.5), y2 - head * Math.sin(ang + 0.5));
  c.closePath(); c.fill();
}

function drawHandles() {
  ctx.fillStyle = "#5b9cff";
  for (const p of handlePts()) ctx.fillRect(p.x - HANDLE_R() / 2, p.y - HANDLE_R() / 2, HANDLE_R(), HANDLE_R());
}
function handlePts() {
  const { x, y, w, h } = rect;
  return [
    { k: "nw", x, y }, { k: "n", x: x + w / 2, y }, { k: "ne", x: x + w, y },
    { k: "e", x: x + w, y: y + h / 2 }, { k: "se", x: x + w, y: y + h },
    { k: "s", x: x + w / 2, y: y + h }, { k: "sw", x, y: y + h }, { k: "w", x, y: y + h / 2 },
  ];
}

// ---------- 事件 ----------
function evPos(e) {
  const r = view.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - r.left) * (view.width / r.width)),
    y: Math.round((e.clientY - r.top) * (view.height / r.height)),
  };
}
function hitHandle(p) {
  if (!rect) return null;
  for (const h of handlePts())
    if (Math.abs(h.x - p.x) <= HANDLE_R() && Math.abs(h.y - p.y) <= HANDLE_R()) return h.k;
  return null;
}
function inRect(p) { return rect && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h; }
function winAt(p) {
  const ws = boot.windows || [];
  for (const w of ws) {
    const x = w.x - bounds.x, y = w.y - bounds.y;
    if (p.x >= x && p.x <= x + w.width && p.y >= y && p.y <= y + w.height)
      return { x, y, w: w.width, h: w.height, id: w.windowId, app: w.appName, title: w.title };
  }
  return null;
}

view.addEventListener("pointermove", (e) => {
  const p = evPos(e);
  if (mode === "idle") { hover = snapRect(p); render(); }
  updateMagnifier(e, p);
});

function snapRect(p) {
  const w = winAt(p);
  return w ? { x: w.x, y: w.y, w: w.width, h: w.height } : null;
}

view.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const p = evPos(e);
  view.setPointerCapture(e.pointerId);
  if (mode === "edit" && tool === "text") { startTextInput(p); return; }
  if (mode === "edit" && tool) {
    pushUndo();
    const base = { kind: tool, x: p.x, y: p.y, color: "#ff4d4f", w: 3 * scale };
    shapes.push(tool === "text" ? { ...base, text: "", fontPx: 16 * scale }
      : tool === "arrow" ? { ...base, x2: p.x, y2: p.y }
      : { ...base, w2: 0, h2: 0 });
    anchor = { mode: "shape", start: p, idx: shapes.length - 1 };
    mode = "shape"; render(); return;
  }
  if (mode === "edit") {
    const h = hitHandle(p);
    if (h) { anchor = { mode: "resize", handle: h, rect0: { ...rect }, start: p }; return; }
    if (inRect(p)) { anchor = { mode: "move", rect0: { ...rect }, start: p }; return; }
  }
  // 新框选（idle 或 edit 中重画）：始终从光标处起拖 —— 自由框选；
  // 未拖动即松手（<4px）时由 pointerup 按“点击吸附窗口”处理
  rect = { x: p.x, y: p.y, w: 1, h: 1 };
  anchor = { mode: "draw", start: p };
  shapes = []; sel = null;
  mode = "draw"; render();
});

view.addEventListener("pointermove", (e) => {
  if (!anchor) return;
  const p = evPos(e);
  if (anchor.mode === "draw") {
    let { x: x0, y: y0 } = anchor.start;
    let dx = p.x - x0, dy = p.y - y0;
    if (e.shiftKey) { const m = Math.min(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx) * m; dy = Math.sign(dy) * m; }
    rect = norm(x0, y0, dx, dy);
  } else if (anchor.mode === "resize") {
    const r = anchor.rect0, h = anchor.handle, ddx = p.x - anchor.start.x, ddy = p.y - anchor.start.y;
    let { x, y, w, hgt } = { x: r.x, y: r.y, w: r.w, hgt: r.h };
    if (h.includes("w")) { x = r.x + ddx; w = r.w - ddx; }
    if (h.includes("e")) { w = r.w + ddx; }
    if (h.includes("n")) { y = r.y + ddy; hgt = r.h - ddy; }
    if (h.includes("s")) { hgt = r.h + ddy; }
    rect = norm(x, y, w, hgt);
  } else if (anchor.mode === "move") {
    const r = anchor.rect0;
    rect = { x: clamp(r.x + (p.x - anchor.start.x), 0, bm.width - r.w), y: clamp(r.y + (p.y - anchor.start.y), 0, bm.height - r.h), w: r.w, h: r.h };
  } else if (anchor.mode === "shape") {
    const s = shapes[anchor.idx];
    if (s.kind === "arrow") { s.x2 = p.x; s.y2 = p.y; }
    else { s.w2 = Math.abs(p.x - s.x); s.h2 = Math.abs(p.y - s.y); s.x = Math.min(s.x, p.x); s.y = Math.min(s.y, p.y); }
  }
  render(); positionToolbar();
});

function norm(x0, y0, dx, dy) {
  let x = dx < 0 ? x0 + dx : x0, y = dy < 0 ? y0 + dy : y0;
  let w = Math.abs(dx), h = Math.abs(dy);
  if (anchor?.mode === "draw" && w < 1) w = 1;
  if (anchor?.mode === "draw" && h < 1) h = 1;
  return { x: clamp(x, 0, bm.width - 1), y: clamp(y, 0, bm.height - 1), w, h };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

view.addEventListener("pointerup", async (e) => {
  const a = anchor; anchor = null;
  if (!a) return;
  if (a.mode === "draw") {
    if (rect.w < 4 || rect.h < 4) { // 太小的点击 → 直接吸附窗口
      const w = winAt(evPos(e));
      if (w) { rect = { x: w.x, y: w.y, w: w.width, h: w.height }; }
    }
    mode = "edit"; await commitSel(); showToolbar("action"); render(); positionToolbar();
  } else if (a.mode === "shape") {
    mode = "edit"; render();
  }
});

view.addEventListener("dblclick", async (e) => {
  const p = evPos(e);
  if (mode !== "edit") {
    const w = winAt(p);
    if (w) { // 双击干净窗口图 → 复制（参考两级抓取链）
      try {
        const r = await invoke("capture_window_clean", { token: boot.token, windowId: w.id });
        await invoke("export_result", { req: { sel: r.sel, op: "copy" } });
      } catch (err) { alert(String(err?.message || err)); }
    }
  } else {
    await finish("copy");
  }
});

window.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") { await cancel(); }
  else if (e.key === "Enter" && mode === "edit") { await finish("copy"); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { popUndo(); }
});

// ---------- 选区提交 / 导出 ----------
function virtualRect() {
  return { x: bounds.x + rect.x, y: bounds.y + rect.y, width: rect.w, height: rect.h };
}
async function commitSel() {
  if (committing || !rect) return;
  committing = true;
  try {
    const r = await invoke("commit_selection", { token: boot.token, rect: virtualRect(), source: "region", appHint: null });
    sel = r.sel;
  } finally { committing = false; }
}

async function finish(op) {
  if (!sel) await commitSel();
  if (!sel) return;
  const req = { sel, op };
  if (shapes.length) {
    const png = await renderFinalPng();
    req.pngBase64 = png;
    req.annotationJson = JSON.stringify({ v: 1, shapes: shapes.map(s => ({ ...s, x: s.x - rect.x, y: s.y - rect.y })) });
  }
  try { await invoke("export_result", { req }); }
  catch (e) { alert("导出失败: " + (e?.message || JSON.stringify(e))); return; }
  // export_result 在 Rust 侧关闭所有 overlay；保险兜底：
  setTimeout(() => { try { window.__TAURI__.window.getCurrentWindow().close(); } catch {} }, 300);
}

async function cancel() {
  try { await invoke("cancel_capture", { token: boot.token }); } catch {}
  try { window.__TAURI__.window.getCurrentWindow().close(); } catch {}
}

async function renderFinalPng() {
  const c = document.createElement("canvas"); c.width = rect.w; c.height = rect.h;
  const cc = c.getContext("2d");
  cc.drawImage(bm, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  drawShapes(cc, { x: 0, y: 0, w: rect.w, h: rect.h }, -rect.x, -rect.y);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  return u8ToB64(new Uint8Array(await blob.arrayBuffer()));
}

function doFlash() {
  const ms = (boot.settings?.flashMs ?? 250);
  if (!ms) return;
  flash.style.transition = "none"; flash.style.opacity = "0.9";
  requestAnimationFrame(() => { flash.style.transition = `opacity ${ms}ms ease-out`; flash.style.opacity = "0"; });
}

// ---------- 工具栏 ----------
function buildToolbar() {}
function showToolbar(kind) {
  toolbar.classList.remove("hidden");
  toolbar.innerHTML = "";
  const mk = (label, cls, fn) => {
    const b = document.createElement("button");
    b.textContent = label; if (cls) b.className = cls;
    b.onclick = fn; toolbar.appendChild(b); return b;
  };
  const sep = () => { const d = document.createElement("div"); d.className = "sep"; toolbar.appendChild(d); };
  for (const [name, icon] of [["rect", "□"], ["arrow", "↗"], ["text", "T"], ["mosaic", "▦"]]) {
    const b = mk(icon + name.slice(0, 1).toUpperCase(), tool === name ? "on" : "", () => {
      tool = tool === name ? null : name; showToolbar(); render();
    });
    b.title = { rect: "矩形", arrow: "箭头", text: "文字(点击输入)", mosaic: "马赛克" }[name];
  }
  mk("↶", "", () => { popUndo(); render(); });
  sep();
  mk("复制", "", () => finish("copy"));
  mk("存图", "", () => finish("save"));
  mk("钉图", "", () => finish("pin"));
  mk("复制+存", "", () => finish("copySave"));
  sep();
  mk("取消", "", cancel);
  positionToolbar();
}
function positionToolbar() {
  if (!rect) { toolbar.classList.add("hidden"); return; }
  const cw = view.getBoundingClientRect();
  const sx = cw.width / view.width, sy = cw.height / view.height;
  const bx = rect.x * sx, by = (rect.y + rect.h) * sy + 8, bw = rect.w * sx;
  toolbar.style.left = clamp(bx, 4, cw.width - 420) + "px";
  toolbar.style.bottom = "auto";
  toolbar.style.top = Math.min(by, cw.height - 50) + "px";
  void bw;
}

// ---------- 文字输入 ----------
function startTextInput(p) {
  textInput.classList.remove("hidden");
  const cw = view.getBoundingClientRect();
  textInput.style.left = (p.x / view.width * cw.width) + "px";
  textInput.style.top = (p.y / view.height * cw.height) + "px";
  textValue.value = ""; textValue.focus();
  pendingTextInputShape = { kind: "text", x: p.x, y: p.y, text: "", fontPx: 16 * scale, color: "#ff4d4f" };
}
textValue.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter") {
    pendingTextInputShape.text = textValue.value || " ";
    pushUndo(); shapes.push(pendingTextInputShape); pendingTextInputShape = null;
    textInput.classList.add("hidden"); tool = null; render();
  } else if (e.key === "Escape") {
    pendingTextInputShape = null; textInput.classList.add("hidden");
  }
});

// ---------- 放大镜 ----------
function updateMagnifier(e, p) {
  if (!bm || mode === "edit" && !anchor) { /* 编辑中不需要放大镜 */ }
  if (mode !== "idle" && mode !== "draw") { magEl.classList.add("hidden"); return; }
  magEl.classList.remove("hidden");
  const cw = view.getBoundingClientRect();
  const x = e.clientX + 20, y = e.clientY + 20;
  magEl.style.left = Math.min(x, window.innerWidth - 200) + "px";
  magEl.style.top = Math.min(y, window.innerHeight - 220) + "px";
  const N = 9; // 19x19 采样
  magCtx.imageSmoothingEnabled = false;
  magCtx.drawImage(bm, p.x - N, p.y - N, N * 2 + 1, N * 2 + 1, 0, 0, 168, 168);
  magCtx.strokeStyle = "#5b9cff";
  magCtx.strokeRect(84 - 1, 84 - 1, 3, 3);
  const [r, g, b] = pixelAt(p);
  magInfo.textContent = `${p.x + bounds.x}, ${p.y + bounds.y}  rgb(${r},${g},${b})`;
}
let pxCache = null, pxKey = "";
function pixelAt(p) {
  const key = p.x + "," + p.y;
  if (key !== pxKey) {
    const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height;
    const cc = c.getContext("2d"); cc.drawImage(bm, 0, 0);
    pxCache = cc.getImageData(clamp(p.x, 0, bm.width - 1), clamp(p.y, 0, bm.height - 1), 1, 1).data;
    pxKey = key;
  }
  return [pxCache[0], pxCache[1], pxCache[2]];
}

// 尺寸读数（复用 magInfo 旁边 toolbar 上方浮动）
function showReadout() {
  if (rect) view.title = `${rect.w} × ${rect.h} px`;
}

// ---------- 撤销 ----------
function pushUndo() { undoStack.push(JSON.stringify(shapes)); if (undoStack.length > 50) undoStack.shift(); }
function popUndo() { if (undoStack.length) { shapes = JSON.parse(undoStack.pop()); render(); } }
