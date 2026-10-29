import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import { installSettingsMock } from "../shared/devmock";
import SettingsPage from "./SettingsPage";

// 仅 vite dev + ?mock：在纯浏览器里核对设置页布局与键位交互，生产构建不会带入
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
  installSettingsMock();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsPage />
  </StrictMode>,
);
