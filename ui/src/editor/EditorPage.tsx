//! 重编辑器：复用 overlay 的画布引擎、工具条与标注模型，差别在——
//! 底图是一条已有 sel、没有窗口吸附、选区不可改、关闭只是关窗（不取消会话）。
//! 导出走既有 export_result，每次插入**新**历史条目，原条目不动（已确认的决定）。

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "../shared/ipc";
import type { BootEditor } from "../shared/types";
import { OverlayController } from "../overlay/engine/controller";
import { emptyChromeRefs, type ChromeRefs } from "../overlay/components/chrome";
import { layoutChrome, StatusBar } from "../overlay/chromeLayout";
import Toolbar from "../overlay/components/Toolbar";
import PropertyBar from "../overlay/components/PropertyBar";
import TextInput from "../overlay/components/TextInput";

export default function EditorPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<OverlayController | null>(null);
  const chrome = useRef<ChromeRefs>(emptyChromeRefs());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ctrl: OverlayController | null = null;

    (async () => {
      const b = await invoke<BootEditor>("bootstrap");
      if (cancelled) return;
      if (b.kind !== "editor") {
        setFailed("非重编辑窗口");
        return;
      }
      const c = new OverlayController(b, canvasRef.current!);
      ctrl = c;
      ctrlRef.current = c;
      if (!(await c.loadFrame())) {
        await c.cancel();
        return;
      }
      if (!cancelled) setReady(true);
    })().catch(async (e) => {
      if (cancelled) return;
      console.error("editor bootstrap failed", e);
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

  useEffect(() => {
    const ctrl = ctrlRef.current;
    if (!ctrl || !ready) return;
    let raf = 0;
    const tick = () => {
      layoutChrome(ctrl, chrome.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready]);

  return (
    <>
      <canvas ref={canvasRef} className="snip-canvas editor-canvas" />
      {ready && ctrlRef.current && (
        <>
          <Toolbar ctrl={ctrlRef.current} chrome={chrome} />
          <PropertyBar ctrl={ctrlRef.current} chrome={chrome} />
          <TextInput ctrl={ctrlRef.current} />
          <StatusBar ctrl={ctrlRef.current} />
        </>
      )}
      {failed && <div className="snip-fatal">{failed}</div>}
    </>
  );
}
