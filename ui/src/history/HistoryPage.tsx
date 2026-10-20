// 历史：缩略图为主，动作图标悬停浮出；双击条目进重编辑器（导出另存为新条目）。

import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "../shared/ipc";
import type { HistoryRow } from "../shared/types";
import { IconCopy, IconEdit, IconFolder, IconPin, IconTrash } from "../shared/icons";

export default function HistoryPage() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string>("");

  const load = useCallback(async () => {
    try {
      setRows(await invoke<HistoryRow[]>("list_history", { limit: 120, offset: 0 }));
      setError("");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  /** 卡片上的动作按钮：阻止冒泡，否则会被卡片的「双击重编辑」吞掉 */
  const onAct = (fn: () => Promise<unknown>) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    void run(fn);
  };

  if (!rows) return <p className="hint">加载中…</p>;

  return (
    <>
      <header>
        <h1>历史</h1>
        <button onClick={load}>刷新</button>
        {error && <span className="err">{error}</span>}
      </header>

      {rows.length === 0 ? (
        <p className="hint">还没有截图记录。按 F1 开始第一次截图。</p>
      ) : (
        <div id="grid">
          {rows.map((r) => {
            const time = new Date(r.created_at * 1000).toLocaleString();
            return (
              <div
                className="card"
                key={r.id}
                title="双击重新编辑"
                onDoubleClick={() => void run(() => invoke("history_edit", { id: r.id }))}
              >
                <div className="thumb">
                  <img src={`data:image/jpeg;base64,${r.thumb_base64}`} alt="" />
                  <div className="card-acts">
                    <button
                      title="重新编辑"
                      onClick={onAct(() => invoke("history_edit", { id: r.id }))}
                    >
                      <IconEdit />
                    </button>
                    <button
                      title="复制到剪贴板"
                      onClick={onAct(() => invoke("history_copy", { id: r.id }))}
                    >
                      <IconCopy />
                    </button>
                    <button
                      title="贴图"
                      onClick={onAct(() => invoke("history_pin", { id: r.id }))}
                    >
                      <IconPin />
                    </button>
                    <button
                      title="在文件管理器中显示"
                      onClick={onAct(() => invoke("history_open_folder", { id: r.id }))}
                    >
                      <IconFolder />
                    </button>
                    <button
                      title="删除"
                      onClick={onAct(async () => {
                        await invoke("history_delete", { id: r.id });
                        await load();
                      })}
                    >
                      <IconTrash />
                    </button>
                  </div>
                </div>
                <div className="meta">
                  <span title={time}>{time}</span>
                  <span>
                    {r.width}×{r.height}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
