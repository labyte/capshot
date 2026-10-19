// 历史：网格缩略图 + 复制/钉图/打开目录/删除。
import { invoke } from "../shared.js";

const grid = document.getElementById("grid");
const refreshBtn = document.getElementById("refresh");

async function load() {
  const rows = await invoke("list_history", { limit: 120, offset: 0 });
  grid.innerHTML = "";
  for (const r of rows) {
    const card = document.createElement("div");
    card.className = "card";
    const img = document.createElement("img");
    img.src = "data:image/jpeg;base64," + r.thumb_base64;
    const meta = document.createElement("div");
    meta.className = "meta";
    const time = new Date(r.created_at * 1000).toLocaleString();
    meta.innerHTML = `<span title="${time}">${time}</span><span>${r.width}×${r.height}</span>`;
    const btn = (label, fn, title) => {
      const b = document.createElement("button");
      b.textContent = label; b.title = title || label;
      b.onclick = async (e) => { e.stopPropagation(); try { await fn(); } catch (err) { alert(String(err?.message || err)); } };
      meta.appendChild(b);
    };
    btn("复制", () => invoke("history_copy", { id: r.id }));
    btn("钉图", () => invoke("history_pin", { id: r.id }));
    btn("目录", () => invoke("history_open_folder", { id: r.id }), "在文件管理器中显示");
    btn("删", async () => { await invoke("history_delete", { id: r.id }); load(); });
    card.appendChild(img); card.appendChild(meta);
    card.ondblclick = () => invoke("history_copy", { id: r.id });
    grid.appendChild(card);
  }
  if (!rows.length) grid.innerHTML = '<p class="hint">还没有截图记录。按热键开始第一次截图。</p>';
}
refreshBtn.onclick = load;
load();
