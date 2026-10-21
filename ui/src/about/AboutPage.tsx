//! 关于窗：软件名 / 版本 / 当前快捷键。数据来自宿主 about_info（版本取 tauri.conf）。

import { useEffect, useState } from "react";
import { invoke } from "../shared/ipc";

interface AboutInfo {
  name: string;
  version: string;
  hotkey: string;
  hotkeyPin: string;
  hotkeyHidePins: string;
}

// 与 app 图标同一枚裁剪框字形（crop brackets），品牌一致
function Logo() {
  return (
    <svg width="56" height="56" viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient id="about-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5aa9ff" />
          <stop offset="1" stopColor="#2f6fe0" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="184" fill="url(#about-bg)" />
      <g transform="translate(512 512) scale(0.66) translate(-512 -512)" fill="#fff">
        <path d="M256 768h672a31 31 0 0 1 0 64H224a32 32 0 0 1-32-32V96a31 31 0 0 1 64 0v672z" />
        <path d="M832 224v704a31 31 0 0 1-64 0V256H96a31 31 0 0 1 0-64h704a32 32 0 0 1 32 32z" />
      </g>
    </svg>
  );
}

export default function AboutPage() {
  const [info, setInfo] = useState<AboutInfo | null>(null);

  useEffect(() => {
    void invoke<AboutInfo>("about_info").then(setInfo).catch(console.error);
  }, []);

  return (
    <div className="about-card">
      <Logo />
      <div className="about-name">{info?.name ?? "CapsShot"}</div>
      <div className="about-ver">版本 {info?.version ?? "—"}</div>
      <div className="about-keys">
        <div className="row">
          <span className="hk-label">截图</span>
          <code>{info?.hotkey || "未绑定"}</code>
        </div>
        <div className="row">
          <span className="hk-label">贴图（剪贴板）</span>
          <code>{info?.hotkeyPin || "未绑定"}</code>
        </div>
        <div className="row">
          <span className="hk-label">隐藏 / 显示全部贴图</span>
          <code>{info?.hotkeyHidePins || "未绑定"}</code>
        </div>
      </div>
      <div className="about-foot">© {new Date().getFullYear()} CapsShot</div>
    </div>
  );
}
