// 设置：分页面板（常规 / 截屏 / 输出 / 快捷键），布局照 Snipaste 偏好面板 ——
// 顶部一排页签，页内两列对齐：标签列右对齐带冒号，控件列左对齐，行末留一格给状态图标。
//
// 页签只放**我们真有设置项**的那几类：Snipaste 的「界面 / 贴图 / 关于」这里没有对应开关
// （关于是托盘单独开的 about 窗，搬进来就是两份真相），所以不做空页签。
// 「快捷键」页对应 Snipaste 的「控制」页 —— 我们只有全局键位，没有应用内快捷键和鼠标页，
// 直接叫「快捷键」比叫「控制」更不容易误解。
//
// 键位规则：F1–F12 / PrintScreen / Pause 允许裸键（对齐 Snipaste 的 F1/F3），
// 其余仍要求至少一个修饰键 —— 裸字母会在全局把别人的输入吞掉。

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../shared/ipc";
import { IconCheck, IconClose, IconInfo } from "../shared/icons";
import type { HotkeySlot, HotkeySlotStatusDto, PermissionStatusDto, SettingsDto } from "../shared/types";

const HOTKEY_SLOTS: { slot: HotkeySlot; label: string; hint: string; info?: string }[] = [
  { slot: "hotkey", label: "截图", hint: "默认 F1" },
  { slot: "hotkeyPin", label: "贴图（剪贴板）", hint: "默认 F3" },
  { slot: "hotkeyHidePins", label: "隐藏 / 显示全部贴图", hint: "默认 Shift+F3" },
  {
    slot: "hotkeyThrough",
    label: "贴图鼠标穿透",
    hint: "默认不绑定",
    info: "穿透中的贴图会直接吃掉鼠标事件；忘了关可以从托盘菜单恢复。",
  },
];

type TabId = "general" | "capture" | "output" | "hotkey";

const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "常规" },
  { id: "capture", label: "截屏" },
  { id: "output", label: "输出" },
  { id: "hotkey", label: "快捷键" },
];

interface PatchResult {
  hotkey?: string;
  settings?: SettingsDto;
}

const MOD_KEYS = ["Shift", "Control", "Alt", "Meta"];

/**
 * 行末状态图标的 hover 文案：`F1 已被其它程序占用（注册失败：…）`。
 * 正文只放图标，原因全在 title 里 —— 参照 Snipaste 的快捷键面板，一行一个勾/叉就够看懂。
 */
function hkTip(st: HotkeySlotStatusDto): string {
  if (st.ok) return `${st.key} 已生效`;
  const key = st.failedKey ?? st.key;
  const why = st.label ?? "未生效";
  return st.detail ? `${key} ${why}（${st.detail}）` : `${key} ${why}`;
}

/**
 * 权限三态渲染：true = 已授权，false = 未授权（用调用方给的措辞），
 * null = **本平台不适用**（Windows 无 TCC），不是「未授权」。
 * 文案和配色收在这一处，别再散到 JSX 里各写一遍条件。
 */
function permView(v: boolean | null, deniedText: string): { text: string; cls: string } {
  if (v === null) return { text: "不适用", cls: "perm-na" };
  return v ? { text: "已授权", cls: "perm-ok" } : { text: deniedText, cls: "perm-no" };
}

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
  const [tab, setTab] = useState<TabId>("general");
  const [recording, setRecording] = useState<HotkeySlot | null>(null);
  /** 当前页签底部的一行红字：只装这一页自己判得出来的错（该键需要修饰键、保存失败）。
   * 快捷键注册失败不走这里，它按 slot 落在对应那一行上，见 regStatus。 */
  const [error, setError] = useState<string>("");
  const [saveDirError, setSaveDirError] = useState<string>("");
  const [regStatus, setRegStatus] = useState<HotkeySlotStatusDto[]>([]);
  const keyHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  const refreshPerm = useCallback(async () => {
    try {
      setPerm(await invoke<PermissionStatusDto>("permission_status"));
    } catch (e) {
      console.error("permission_status failed", e);
    }
  }, []);

  /** 注册结论由宿主算好（它才知道系统里到底注册上没有）：一次给**所有已绑定的槽**，
   * 所以绿勾与红叉出自同一份数据，不会只报坏消息。 */
  const refreshReg = useCallback(async () => {
    try {
      const r = await invoke<{ slots?: HotkeySlotStatusDto[] }>("hotkey_status");
      setRegStatus(r.slots ?? []);
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
      // 改键被拒时后端只写日志，页面靠 refreshReg 拿到的结构化记录在对应行上标红，
      // 这里只需清掉上一条本地校验提示
      setError("");
      if (r.settings) setSettings(r.settings);
      await refreshReg();
    } catch (e) {
      setError("保存失败：" + String((e as Error)?.message ?? e));
    }
  }

  /**
   * 点键位框开始录制。允许裸 F1–F12 / PrintScreen / Pause（Snipaste 的键位习惯），
   * 其余仍要求修饰键 —— 裸字母会在全局吞掉正常输入。Esc 取消。
   */
  function startRecording(slot: HotkeySlot) {
    stopRecording();
    setRecording(slot);
    setError("");
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (MOD_KEYS.includes(e.key)) return;
      if (e.key === "Escape") {
        stopRecording();
        return;
      }
      const mods = collectModifiers(e);
      let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (key === " ") key = "Space";
      const bareAllowed = /^F([1-9]|1[0-2])$/.test(key) || key === "PrintScreen" || key === "Pause";
      if (mods.length < 1 && !bareAllowed) {
        setError("该键需要至少一个修饰键（F1–F12 / PrintScreen / Pause 可单独使用）");
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

  /** 「恢复默认」：默认值只从宿主要（Settings::default()），前端不抄第二份 */
  async function restoreDefaults() {
    try {
      const d = await invoke<Record<HotkeySlot, string>>("default_hotkeys");
      await patch({ ...d });
    } catch (e) {
      setError("恢复默认失败：" + String((e as Error)?.message ?? e));
    }
  }

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

  // 权限三态里的 null = **本平台没有这项概念**（Windows 无 TCC）。这种情况整块「权限」不显示：
  // 写「未授权」是误导，写「不适用」也是一行没人要的噪音，那两个按钮更是空操作。
  // 还没拿到状态时同样不显示，免得在 Windows 上先闪一帧再消失。
  const permRows =
    perm && perm.screenRecording !== null
      ? [
          { label: "屏幕录制", view: permView(perm.screenRecording, "未授权") },
          { label: "辅助功能", view: permView(perm.accessibility, "未授权（可选增强）") },
        ]
      : null;

  const panelGeneral = (
    <div className="form">
      <span className="k">开机自启：</span>
      <label className="c">
        <input
          type="checkbox"
          defaultChecked={settings.autostart}
          onChange={(e) => void patch({ autostart: e.target.checked })}
        />{" "}
        登录系统后自动启动
      </label>
      <span className="k" aria-hidden="true" />
      <span className="c hint-inline">
        应用是托盘常驻，不自启的话每次开机都要手动启动，F1 也就没人听了。
      </span>

      {permRows && (
        <>
          <h2 className="spanall">权限</h2>
          {permRows.map((r) => (
            <Fragment key={r.label}>
              <span className="k">{r.label}：</span>
              <span className={"c " + r.view.cls}>{r.view.text}</span>
            </Fragment>
          ))}
          <span className="k" aria-hidden="true" />
          <div className="c row">
            <button onClick={requestPermission}>请求屏幕录制权限</button>
            <button onClick={() => void invoke("permission_open_settings")}>打开系统设置</button>
            <button onClick={refreshPerm}>重新检查</button>
          </div>
        </>
      )}
    </div>
  );

  const panelCapture = (
    <div className="form">
      <span className="k">闪光时长：</span>
      <div className="c row">
        <input
          type="number"
          min={0}
          max={2000}
          step={10}
          defaultValue={settings.flashMs}
          onChange={(e) => {
            // 清空输入框时 parseInt 给 NaN：serde 会直接拒收，别把这种半截值发出去
            const v = parseInt(e.target.value, 10);
            if (!Number.isNaN(v)) void patch({ flashMs: v });
          }}
        />
        <span className="hint-inline">ms（0 = 关闭）</span>
      </div>
      <span className="k" aria-hidden="true" />
      <span className="c hint-inline">
        截图完成那一瞬间整屏白闪的时长。只影响观感，存下来的图不受影响。
      </span>
    </div>
  );

  const panelOutput = (
    <div className="form">
      <span className="k">保存位置：</span>
      <div className={"c path-field" + (settings.saveDir ? "" : " empty")}>
        {settings.saveDir || "未设置（每次保存时询问）"}
      </div>
      <span className="k" aria-hidden="true" />
      <div className="c row">
        <button onClick={chooseSaveDir}>选择文件夹…</button>
        {settings.saveDir && (
          <>
            <button onClick={openSaveDir}>打开文件夹</button>
            <button onClick={() => void patch({ saveDir: "" })}>改为每次询问</button>
          </>
        )}
      </div>
      {saveDirError && (
        <>
          <span className="k" aria-hidden="true" />
          <span className="c err">{saveDirError}</span>
        </>
      )}

      <span className="k">历史原图：</span>
      <div className="c row">
        <button onClick={openHistoryDir}>打开历史原图目录</button>
        <span className="hint-inline">每次截图都会存一份无损 PNG，「历史」窗可回看</span>
      </div>

      <span className="k">复制同时保存：</span>
      <label className="c">
        <input
          type="checkbox"
          defaultChecked={settings.saveOnCopy}
          onChange={(e) => void patch({ saveOnCopy: e.target.checked })}
        />{" "}
        复制到剪贴板时也顺手存一份
      </label>

      <span className="k">标注导出质量：</span>
      <div className="c row">
        <input
          type="number"
          min={0.1}
          max={1}
          step={0.01}
          defaultValue={settings.quality}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) void patch({ quality: v });
          }}
        />
        <span className="hint-inline">0.1 – 1，只作用于标注后导出的 JPEG</span>
      </div>

      <p className="spanall hint-inline">
        设置保存位置后，截图「保存」直接落到该文件夹，文件名撞车自动加 -1 / -2 后缀，不再弹「另存为」。
      </p>
    </div>
  );

  const panelHotkey = (
    <div className="form hk">
      {HOTKEY_SLOTS.map(({ slot, label, hint, info }) => {
        // 图标只认宿主算好的结论；未绑定的槽不会出现在 regStatus 里 → 不给图标
        const st = regStatus.find((s) => s.slot === slot);
        // 只有「刚改的那把新键被拒」才补一句文字：这时框里显示的还是能用的旧键，
        // 图标（叉）说不出被拒的是哪把键。其余情况图标 + hover 就够，不再堆红字。
        const rejected = st && !st.ok && st.failedKey && st.failedKey !== settings[slot] ? st : null;
        const bound = !!settings[slot];
        const rec = recording === slot;
        return (
          <Fragment key={slot}>
            <span className="k">
              {label}：
              {info && (
                <span className="info" title={info}>
                  <IconInfo size={13} />
                </span>
              )}
            </span>
            <div
              className={"hk-field" + (rec ? " rec" : "") + (bound ? "" : " unset")}
              title={rec ? "按 Esc 取消" : `点击后按下新快捷键 · ${hint}`}
              onClick={() => (rec ? stopRecording() : startRecording(slot))}
            >
              <span className="val">{rec ? "请按下新快捷键…" : (settings[slot] || "按下快捷键")}</span>
              {bound && !rec && (
                <button
                  className="hk-clear"
                  title={`解绑 ${settings[slot]}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void patch({ [slot]: "" });
                  }}
                >
                  <IconClose size={9} />
                </button>
              )}
            </div>
            <span className="hk-state">
              {st && (
                <span className={st.ok ? "hk-ok" : "hk-no"} title={hkTip(st)}>
                  {st.ok ? <IconCheck size={15} /> : <IconClose size={15} />}
                </span>
              )}
            </span>
            {rejected && (
              <>
                <span className="k" aria-hidden="true" />
                <span className="span2 err">
                  {rejected.failedKey} {rejected.label}
                </span>
              </>
            )}
          </Fragment>
        );
      })}
      <span className="k" aria-hidden="true" />
      <div className="c row end span2">
        <button onClick={() => void restoreDefaults()}>恢复默认</button>
      </div>
    </div>
  );

  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              stopRecording();
              setError("");
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="panel" role="tabpanel">
        {tab === "general" && panelGeneral}
        {tab === "capture" && panelCapture}
        {tab === "output" && panelOutput}
        {tab === "hotkey" && panelHotkey}
        {/* 本地错（该键需要修饰键 / 保存失败）跟着当前页签走：钉死在快捷键页的话，
            在「截屏」页把数字框清空导致的失败就完全看不见了 */}
        {error && <p className="err form-error">{error}</p>}
      </div>
    </>
  );
}
