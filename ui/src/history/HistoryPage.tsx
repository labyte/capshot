// 历史：缩略图为主，动作图标悬停浮出。
// 多选：单击卡片/左上角勾选切换，Shift+单击选一段；顶部「删除选中」两步确认后批量删。

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "../shared/ipc";
import type { HistoryRow } from "../shared/types";
import { IconCheck, IconCopy, IconFolder, IconPin, IconTrash } from "../shared/icons";

export default function HistoryPage() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string>("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  /** 「删除选中」的第一下只是上膛，第二下才真删（原生 confirm 在 WebView2 里不可靠） */
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  /** Shift 连选的锚点：上一次点过的卡片下标 */
  const anchorIdx = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await invoke<HistoryRow[]>("list_history", { limit: 120, offset: 0 });
      setRows(list);
      setError("");
      // 刷新/删除后重算选区：已经不在列表里的 id 不能还留着，否则顶部计数虚高
      setPicked((prev) => {
        if (!prev.size) return prev;
        const alive = new Set(list.map((r) => r.id));
        const next = new Set([...prev].filter((id) => alive.has(id)));
        return next.size === prev.size ? prev : next;
      });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 上膛状态别一直挂着：4 秒没确认就自己收回，免得下次误点直接删
  useEffect(() => {
    if (!confirming) return;
    const t = window.setTimeout(() => setConfirming(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirming]);

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  const togglePick = useCallback((id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirming(false);
  }, []);

  /** 卡片本体单击 = 选中/取消；Shift+单击 = 从锚点到这里的整段 */
  function onCardClick(e: ReactMouseEvent, id: number, idx: number) {
    setNotice("");
    if (e.shiftKey && anchorIdx.current !== null && rows) {
      const [a, b] = [anchorIdx.current, idx].sort((x, y) => x - y);
      setPicked((prev) => {
        const next = new Set(prev);
        for (let i = a; i <= b; i++) next.add(rows[i].id);
        return next;
      });
      setConfirming(false);
      return;
    }
    anchorIdx.current = idx;
    togglePick(id);
  }

  function pickAll() {
    if (!rows) return;
    const all = picked.size === rows.length;
    setPicked(all ? new Set() : new Set(rows.map((r) => r.id)));
    setConfirming(false);
    setNotice("");
  }

  /** 卡片上的动作按钮：阻止冒泡，否则会被卡片的「单击选中」吞掉 */
  const onAct = (fn: () => Promise<unknown>) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    setNotice("");
    void run(fn);
  };

  async function deletePicked() {
    const ids = [...picked];
    if (!ids.length || busy) return;
    setConfirming(false);
    setBusy(true);
    await run(async () => {
      const n = await invoke<number>("history_delete", { ids });
      setPicked(new Set());
      setNotice(n > 0 ? `已删除 ${n} 条` : "这些记录已经不在了");
      await load();
    });
    setBusy(false);
    anchorIdx.current = null;
  }

  // 键盘：Esc 取消选择/收回确认，Ctrl+A 全选，Delete 对选中项上膛
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConfirming(false);
        setPicked(new Set());
        anchorIdx.current = null;
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        if (!rows?.length) return;
        e.preventDefault();
        setPicked(new Set(rows.map((r) => r.id)));
        setConfirming(false);
        return;
      }
      if (e.key === "Delete" && picked.size > 0) {
        e.preventDefault();
        setConfirming(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, picked]);

  if (!rows) return <p className="hint">加载中…</p>;

  const allPicked = rows.length > 0 && picked.size === rows.length;

  return (
    <>
      <header>
        <h1>历史</h1>
        <span className="hint-inline">
          {rows.length} 张 · 单击选择
        </span>
        {rows.length > 0 && (
          <button onClick={pickAll}>{allPicked ? "取消全选" : "全选"}</button>
        )}
        {picked.size > 0 &&
          (confirming ? (
            <button className="danger" disabled={busy} onClick={() => void deletePicked()}>
              确认删除 {picked.size} 条
            </button>
          ) : (
            <button disabled={busy} onClick={() => setConfirming(true)}>
              <IconTrash size={14} />
              删除选中（{picked.size}）
            </button>
          ))}
        <button
          onClick={() => {
            setNotice("");
            setConfirming(false);
            void load();
          }}
        >
          {busy ? "处理中…" : "刷新"}
        </button>
        {notice && <span className="ok">{notice}</span>}
        {error && <span className="err">{error}</span>}
      </header>

      {rows.length === 0 ? (
        <p className="hint">还没有截图记录。按 F1 开始第一次截图。</p>
      ) : (
        <div id="grid">
          {rows.map((r, idx) => {
            const time = new Date(r.created_at * 1000).toLocaleString();
            const isPicked = picked.has(r.id);
            return (
              <div
                className={isPicked ? "card picked" : "card"}
                key={r.id}
                role="checkbox"
                aria-checked={isPicked}
                aria-label={`${time} 的截图`}
                tabIndex={0}
                onClick={(e) => onCardClick(e, r.id, idx)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    togglePick(r.id);
                  }
                }}
              >
                <div className="thumb">
                  <img src={`data:image/jpeg;base64,${r.thumb_base64}`} alt="" />
                  <span className="pick" aria-hidden="true">
                    {isPicked && <IconCheck size={14} />}
                  </span>
                  <div className="card-acts">
                    <button
                      data-tip="复制到剪贴板"
                      aria-label="复制到剪贴板"
                      onClick={onAct(async () => {
                        await invoke("history_copy", { id: r.id });
                        setNotice("已复制到剪贴板");
                      })}
                    >
                      <IconCopy />
                    </button>
                    <button
                      data-tip="贴图"
                      aria-label="贴图"
                      onClick={onAct(() => invoke("history_pin", { id: r.id }))}
                    >
                      <IconPin />
                    </button>
                    <button
                      data-tip="在文件管理器中显示"
                      aria-label="在文件管理器中显示"
                      onClick={onAct(() => invoke("history_open_folder", { id: r.id }))}
                    >
                      <IconFolder />
                    </button>
                    <button
                      className="act-danger"
                      data-tip="删除"
                      aria-label="删除"
                      onClick={onAct(async () => {
                        await invoke("history_delete", { ids: [r.id] });
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
