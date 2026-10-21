// overlay 入口。
//
// 这里**故意不套 StrictMode**：StrictMode 会把 effect 双挂载一次，于是 overlay 会
// 两次 bootstrap + 两次 loadFrame + 两次 show()，两个 controller 抢同一个 canvas，
// 首帧时序（画完才 show）就废了。settings/history 那种纯读页面留着 StrictMode 没问题。
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import { installMock } from "../shared/devmock";
import OverlayPage from "./OverlayPage";

// 仅 vite dev + ?mock：在纯浏览器里用合成帧跑交互链路，生产构建不会带入
if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
  installMock();
}

createRoot(document.getElementById("root")!).render(<OverlayPage />);
