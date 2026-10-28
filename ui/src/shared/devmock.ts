//! 浏览器调试替身：vite dev 下用 `?mock` 打开 overlay 页时安装假的
//! __TAURI_INTERNALS__.invoke，把 bootstrap / get_monitor_frame 换成合成帧，
//! 其余命令全部 no-op。用于在真实浏览器（=同 WebView2 内核）里单测交互链路，
//! 以及无头 CDP 自动化验收。生产构建 import.meta.env.DEV 为 false，不会带入。

import type { BootOverlay, SnapshotDto } from "./types";

const w = window as unknown as Record<string, any>;

const scale = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));

/** 合成一张"桌面截图"：渐变底 + 网格 + 三个假窗口块，方便肉眼核对选区/吸附 */
async function fakeFramePng(): Promise<ArrayBuffer> {
  const cw = Math.floor(innerWidth * scale);
  const ch = Math.floor(innerHeight * scale);
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, cw, ch);
  grad.addColorStop(0, "#33415c");
  grad.addColorStop(1, "#1a1d24");
  g.fillStyle = grad;
  g.fillRect(0, 0, cw, ch);
  g.strokeStyle = "rgba(255,255,255,0.06)";
  for (let x = 0; x < cw; x += 40 * scale) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ch); g.stroke();
  }
  for (let y = 0; y < ch; y += 40 * scale) {
    g.beginPath(); g.moveTo(0, y); g.lineTo(cw, y); g.stroke();
  }
  const wins: SnapshotDto[] = fakeWindows();
  const fills = ["#c9553d", "#3d76c9", "#3ba55d", "#e8ebf0"];
  wins.forEach((win, i) => {
    const fi = i % fills.length;
    g.fillStyle = fills[fi];
    g.fillRect(win.x, win.y, win.width, win.height);
    // 第 4 块是浅色窗：专门用来肉眼核对放大镜/描边在亮底上的对比色
    g.fillStyle = fi === 3 ? "#20242b" : "#fff";
    g.font = `${16 * scale}px sans-serif`;
    g.fillText(`MockWindow ${i + 1}`, win.x + 12 * scale, win.y + 26 * scale);
  });
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("mock frame encode failed");
  return blob.arrayBuffer();
}

function fakeWindows(): SnapshotDto[] {
  const cw = innerWidth;
  const ch = innerHeight;
  return [
    { windowId: 1, title: "MockWindow 1", appName: "mock", bundleId: null, x: Math.floor(cw * 0.1), y: Math.floor(ch * 0.12), width: Math.floor(cw * 0.35), height: Math.floor(ch * 0.35) },
    { windowId: 2, title: "MockWindow 2", appName: "mock", bundleId: null, x: Math.floor(cw * 0.5), y: Math.floor(ch * 0.3), width: Math.floor(cw * 0.3), height: Math.floor(ch * 0.45) },
    { windowId: 3, title: "MockWindow 3", appName: "mock", bundleId: null, x: Math.floor(cw * 0.2), y: Math.floor(ch * 0.55), width: Math.floor(cw * 0.4), height: Math.floor(ch * 0.3) },
    { windowId: 4, title: "MockWindow 4", appName: "mock", bundleId: null, x: Math.floor(cw * 0.62), y: Math.floor(ch * 0.08), width: Math.floor(cw * 0.3), height: Math.floor(ch * 0.18) },
  ];
}

export function installMock() {
  if (!w.__TAURI_INTERNALS__) {
    let selSeq = 0;
    const boot: BootOverlay = {
      kind: "overlay",
      token: 1,
      monitor: 0,
      bounds: { x: 0, y: 0, width: Math.floor(innerWidth * scale), height: Math.floor(innerHeight * scale) },
      scale,
      windows: fakeWindows(),
      settings: {
        hotkey: "F1", hotkeyPin: "F3", hotkeyHidePins: "Shift+F3", hotkeyThrough: "",
        quality: 0.86, flashMs: 0, autostart: false, saveOnCopy: false, saveDir: "",
      },
      lastRect: null,
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "overlay-mock-1" }, windowCapabilities: {} },
      transformCallback: (cb: unknown) => cb,
      unregisterCallback: () => {},
      convertFileSrc: (p: string) => p,
      async invoke(cmd: string, args: Record<string, unknown> | undefined) {
        switch (cmd) {
          case "bootstrap":
            return boot;
          case "get_monitor_frame":
            return fakeFramePng();
          case "commit_selection":
            return { sel: ++selSeq };
          case "export_result":
            console.log("[mock] export_result", JSON.stringify(args).slice(0, 300));
            return null;
          case "cancel_capture":
            console.log("[mock] cancel_capture");
            return null;
          default:
            // plugin:window|show / set-focus / close 等一律 no-op
            console.log("[mock] stubbed:", cmd);
            return null;
        }
      },
    };
  }
}
