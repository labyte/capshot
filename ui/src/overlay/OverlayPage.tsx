//! overlay 页面：canvas + 浮层 chrome。画布由 controller 命令式绘制；
//! 本组件的 rAF 只负责把浮层定位/文本写进 DOM（不走 setState）。

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "../shared/ipc";
import type { BootOverlay } from "../shared/types";
import { OverlayController } from "./engine/controller";
import { emptyChromeRefs, type ChromeRefs } from "./components/chrome";
import { layoutChrome, StatusBar } from "./chromeLayout";
import Toolbar from "./components/Toolbar";
import PropertyBar from "./components/PropertyBar";
import Magnifier from "./components/Magnifier";
import Readout from "./components/Readout";
import TextInput from "./components/TextInput";

export default function OverlayPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<OverlayController | null>(null);
  const chrome = useRef<ChromeRefs>(emptyChromeRefs());
  const [boot, setBoot] = useState<BootOverlay | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ctrl: OverlayController | null = null;

    (async () => {
      const b = await invoke<BootOverlay>("bootstrap");
      if (cancelled) return;
      if (b.kind !== "overlay") {
        setFailed("非截图窗口");
        return;
      }
      setBoot(b);
      const c = new OverlayController(b, canvasRef.current!);
      ctrl = c;
      ctrlRef.current = c;
      // dev 调试钩子：CDP 自动化与手动 console 都能直接读 store 状态
      if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ctrl = c;
      const ok = await c.loadFrame();
      if (!ok || cancelled) {
        await c.cancel();
        return;
      }
      // 等**第一帧真的画上**再 show —— 不是"等一个 rAF"：那样可能抢在绘制之前显示，
      // 用户看到的就是一整块空画布（黑屏）。
      await c.firstFrame();
      await c.reveal();
      flash(b.settings.flashMs);
    })().catch(async (e) => {
      if (cancelled) return;
      // bootstrap 失败（会话已被 2 槽上限挤掉等）必须自收，否则留下一个吃点击的隐形全屏窗
      console.error("overlay bootstrap failed", e);
      setFailed(String((e as Error)?.message ?? e));
      try {
        await getCurrentWindow().close();
      } catch {
        /* ignore */
      }
    });

    return () => {
      cancelled = true;
      ctrl?.dispose();
      ctrlRef.current = null;
    };
  }, []);

  // 每帧把浮层写到位
  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl || !boot) return;
    let raf = 0;
    const tick = () => {
      layoutChrome(ctrl, chrome.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [boot]);

  return (
    <>
      <canvas ref={canvasRef} className="snip-canvas" />
      {boot && (
        <>
          <Readout chrome={chrome} />
          <Magnifier chrome={chrome} />
          <Toolbar ctrl={ctrlRef.current!} chrome={chrome} />
          <PropertyBar ctrl={ctrlRef.current!} chrome={chrome} />
          <TextInput ctrl={ctrlRef.current!} />
          <StatusBar ctrl={ctrlRef.current!} />
        </>
      )}
      {failed && <div className="snip-fatal">{failed}</div>}
      <div id="flash" />
    </>
  );
}

function flash(ms: number) {
  if (!ms) return;
  const el = document.getElementById("flash");
  if (!el) return;
  el.style.transition = "none";
  el.style.opacity = "0.85";
  requestAnimationFrame(() => {
    el.style.transition = `opacity ${ms}ms ease-out`;
    el.style.opacity = "0";
  });
}

