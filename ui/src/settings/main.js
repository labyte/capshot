// 设置：权限引导、快捷键捕获重注册、导出项、自启。
import { invoke } from "../shared.js";

const $ = (id) => document.getElementById(id);
let settings = null;

(async () => {
  settings = await invoke("get_settings");
  $("quality").value = settings.quality;
  $("flash").value = settings.flashMs;
  $("saveCopy").checked = settings.saveOnCopy;
  $("autostart").checked = settings.autostart;
  $("hkNow").textContent = settings.hotkey;
  await refreshPerm();
})();

async function refreshPerm() {
  const st = await invoke("permission_status");
  $("permState").innerHTML =
    `屏幕录制：<span class="${st.screenRecording ? "perm-ok" : "perm-no"}">${st.screenRecording ? "已授权" : "未授权"}</span>` +
    `　辅助功能：<span class="${st.accessibility ? "perm-ok" : "perm-no"}">${st.accessibility ? "已授权" : "未授权（可选增强）"}</span>`;
}
$("permReq").onclick = async () => { const r = await invoke("permission_request"); if (r === "prompted") setTimeout(refreshPerm, 1500); refreshPerm(); };
$("permOpen").onclick = () => invoke("permission_open_settings");
$("permChk").onclick = refreshPerm;

async function patch(p) {
  const r = await invoke("set_settings", { patch: p });
  if (r.hotkeyError) { $("hkErr").textContent = "注册失败：" + r.hotkeyError; }
  else $("hkErr").textContent = "";
  if (r.settings) { settings = r.settings; $("hkNow").textContent = settings.hotkey; }
}
$("quality").onchange = (e) => patch({ quality: parseFloat(e.target.value) });
$("flash").onchange = (e) => patch({ flashMs: parseInt(e.target.value, 10) });
$("saveCopy").onchange = (e) => patch({ saveOnCopy: e.target.checked });
$("autostart").onchange = (e) => patch({ autostart: e.target.checked });

// 快捷键捕获
$("hkEdit").onclick = () => {
  $("hkNow").textContent = "请按下新快捷键…";
  const handler = async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
      window.removeEventListener("keydown", handler, true);
      const mods = [];
      if (e.ctrlKey) mods.push("Control");
      if (e.metaKey) mods.push("Super");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      let key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      key = { " ": "Space" }[key] || key;
      if (mods.length < 1) { $("hkErr").textContent = "需要至少一个修饰键"; $("hkNow").textContent = settings.hotkey; return; }
      await patch({ hotkey: mods.join("+") + "+" + key });
    }
  };
  window.addEventListener("keydown", handler, true);
};
