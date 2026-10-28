// 设置：权限引导、四槽快捷键、导出项、自启。
//
// 键位规则：F1–F12 / PrintScreen / Pause 允许裸键（对齐 Snipaste 的 F1/F3），
// 其余仍要求至少一个修饰键 —— 裸字母会在全局把别人的输入吞掉。

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../shared/ipc";
import type { HotkeySlot, PermissionStatusDto, SettingsDto } from "../shared/types";

const HOTKEY_SLOTS: { slot: HotkeySlot; label: string; hint: string; clearable?: boolean }[] = [
  { slot: "hotkey", label: "截图", hint: "默认 F1" },
  { slot: "hotkeyPin", label: "贴图（剪贴板）", hint: "默认 F3" },
  { slot: "hotkeyHidePins", label: "隐藏 / 显示全部贴图", hint: "默认 Shift+F3" },
  { slot: "hotkeyThrough", label: "贴图鼠标穿透", hint: "默认不绑定；穿透中可从托盘恢复", clearable: true },
];

interface PatchResult {
  hotkeyError?: string;
  hotkey?: string;
  settings?: SettingsDto;
}

const MOD_KEYS = ["Shift", "Control", "Alt", "Meta"];

function collectModifiers(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Control");
  if (e.metaKey) mods.push("Super");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return mods;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [perm, setPerm] = useState<PermissionStatusDto | null>(null);
  const [recording, setRecording] = useState<HotkeySlot | null>(null);
  const [hotkeyError, setHotkeyError] = useState<string>("");
  const [saveDirError, setSaveDirError] = useState<string>("");
  const [regErrors, setRegErrors] = useState<string[]>([]);
  const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  const refreshPerm = useCallback(async () => {
    try {
      setPerm(await invoke<PermissionStatusDto>("permission_status"));
    } catch (e) {
      console.error("permission_status failed", e);
    }
  }, []);

  /** 注册失败常发生在启动时（键被别的程序占了），必须看得见 */
  const refreshReg = useCallback(async () => {
    try {
      const r = await invoke<{ errors?: string[] }>("hotkey_status");
      setRegErrors(r.errors ?? []);
    } catch (e) {
      console.error("hotkey_status failed", e);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await invoke<SettingsDto>("get_settings");
        setSettings(s);
      } catch (e) {
        console.error("get_settings failed", e);
      }
      await Promise.all([refreshPerm(), refreshReg()]);
    })();
  }, [refreshPerm, refreshReg]);

  async function patch(p: Record<string, unknown>) {
    try {
      const r = await invoke<PatchResult>("set_settings", { patch: p });
      setHotkeyError(r.hotkeyError ? "注册失败：" + r.hotkeyError : "");
      if (r.settings) setSettings(r.settings);
      await refreshReg();
    } catch (e) {
      setHotkeyError("保存失败：" + String((e as Error)?.message ?? e));
    }
  }

  /**
   * 录制一个槽位的新键。允许裸 F1–F12 / PrintScreen / Pause（Snipaste 的键位习惯），
   * 其余仍要求修饰键 —— 裸字母会在全局吞掉正常输入。
   */
  function startRecording(slot: HotkeySlot) {
    stopRecording();
    setRecording(slot);
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (MOD_KEYS.includes(e.key)) return;
      const mods = collectModifiers(e);
      let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (key === " ") key = "Space";
      const bareAllowed = /^F([1-9]|1[0-2])$/.test(key) || key === "PrintScreen" || key === "Pause";
      if (mods.length < 1 && !bareAllowed) {
        setHotkeyError("该键需要至少一个修饰键（F1–F12 / PrintScreen / Pause 可单独使用）");
        stopRecording();
        return;
      }
      const combo = mods.length ? mods.join("+") + "+" + key : key;
      stopRecording();
      void patch({ [slot]: combo });
    };
    keyHandlerRef.current = handler;
    window.addEventListener("keydown", handler, true);
  }

  function stopRecording() {
    if (keyHandlerRef.current) {
      window.removeEventListener("keydown", keyHandlerRef.current, true);
      keyHandlerRef.current = null;
    }
    setRecording(null);
  }

  // 卸载时摘掉全局捕获监听，否则它会随窗口存活并吞掉按键
  useEffect(() => stopRecording, []);

  async function requestPermission() {
    const r = await invoke<string>("permission_request");
    await refreshPerm();
    if (r === "prompted") setTimeout(refreshPerm, 1500);
  }

  /** 选一个文件夹作为截图保存位置。取消（null）直接忽略，不改动现有设置。 */
  async function chooseSaveDir() {
    setSaveDirError("");
    try {
      const dir = await invoke<string | null>("pick_save_dir");
      if (!dir) return;
      await patch({ saveDir: dir });
    } catch (e) {
      setSaveDirError("选择保存位置失败：" + String((e as Error)?.message ?? e));
    }
  }

  /** 在文件管理器里打开已设置的保存目录；未设置时宿主会报错，这里就地显示 */
  async function openSaveDir() {
    setSaveDirError("");
    try {
      await invoke("open_save_dir");
    } catch (e) {
      setSaveDirError(String((e as Error)?.message ?? e));
    }
  }

  async function openHistoryDir() {
    setSaveDirError("");
    try {
      await invoke("open_history_dir");
    } catch (e) {
      setSaveDirError(String((e as Error)?.message ?? e));
    }
  }

  if (!settings) return <p className="hint">加载中…</p>;

  return (
    <>
      <header>
        <h1>设置</h1>
      </header>

      <section>
        <h2>权限</h2>
        <div>
          {perm ? (
            <>
              屏幕录制：
              <span className={perm.screenRecording ? "perm-ok" : "perm-no"}>
                {perm.screenRecording ? "已授权" : "未授权"}
              </span>
              　辅助功能：
              <span className={perm.accessibility ? "perm-ok" : "perm-no"}>
                {perm.accessibility ? "已授权" : "未授权（可选增强）"}
              </span>
            </>
          ) : (
            "检测中…"
          )}
        </div>
        <div className="row">
          <button onClick={requestPermission}>请求屏幕录制权限</button>
          <button onClick={() => void invoke("permission_open_settings")}>打开系统设置</button>
          <button onClick={refreshPerm}>重新检查</button>
        </div>
      </section>

      <section>
        <h2>快捷键</h2>
        {regErrors.length > 0 && (
          <div className="err">
            以下快捷键注册失败（多半已被其它程序占用，可改用带修饰键的组合）：
            {regErrors.join("；")}
          </div>
        )}
        {HOTKEY_SLOTS.map(({ slot, label, hint, clearable }) => (
          <div className="row" key={slot}>
            <span className="hk-label">{label}</span>
            <code>{recording === slot ? "请按下新快捷键…" : (settings[slot] || "未绑定")}</code>
            <button onClick={() => startRecording(slot)}>修改</button>
            {clearable && settings[slot] && (
              <button onClick={() => void patch({ [slot]: "" })}>解绑</button>
            )}
            <span className="hint-inline">{hint}</span>
          </div>
        ))}
        <div className="row">
          <span className="err">{hotkeyError}</span>
        </div>
      </section>

      <section>
        <h2>保存位置</h2>
        <div className="row">
          <span className="hk-label">截图保存到</span>
          <code className="path">{settings.saveDir || "未设置（每次保存时询问）"}</code>
        </div>
        <div className="row">
          <button onClick={chooseSaveDir}>选择文件夹…</button>
          {settings.saveDir && (
            <>
              <button onClick={openSaveDir}>打开文件夹</button>
              <button onClick={() => void patch({ saveDir: "" })}>改为每次询问</button>
            </>
          )}
        </div>
        {saveDirError && <div className="err">{saveDirError}</div>}
        <div className="row">
          <button onClick={openHistoryDir}>打开历史原图目录</button>
        </div>
        <p className="hint-inline">
          设置后截图「保存」直接落到该文件夹，文件名撞车自动加 -1 / -2 后缀，不再弹「另存为」；
          不设置就每次都问。截图原图始终另存一份无损 PNG 到历史目录（「历史」窗可回看 / 重编辑）。
        </p>
      </section>

      <section>
        <h2>导出</h2>
        <div className="row">
          <label>
            JPEG 质量(标注导出用){" "}
            <input
              type="number"
              min={0.1}
              max={1}
              step={0.01}
              defaultValue={settings.quality}
              onChange={(e) => void patch({ quality: parseFloat(e.target.value) })}
            />
          </label>
        </div>
        <div className="row">
          <label>
            闪光时长 ms{" "}
            <input
              type="number"
              min={0}
              max={2000}
              step={10}
              defaultValue={settings.flashMs}
              onChange={(e) => void patch({ flashMs: parseInt(e.target.value, 10) })}
            />
          </label>
        </div>
        <div className="row">
          <label>
            <input
              type="checkbox"
              defaultChecked={settings.saveOnCopy}
              onChange={(e) => void patch({ saveOnCopy: e.target.checked })}
            />{" "}
            复制同时保存到历史目录
          </label>
        </div>
        <div className="row">
          <label>
            <input
              type="checkbox"
              defaultChecked={settings.autostart}
              onChange={(e) => void patch({ autostart: e.target.checked })}
            />{" "}
            开机自启
          </label>
        </div>
      </section>

      <p className="hint">
        说明：截图原图始终以无损 PNG 落历史目录（命名 {"{yyyy}-{MM}-{dd}_{HH}.{mm}.{ss}.{n}.{app}"}）。
        质量与复制同存为后续导出选项预留。
      </p>
    </>
  );
}
