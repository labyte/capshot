// overlay 入口。
//
// 这里**故意不套 StrictMode**：StrictMode 会把 effect 双挂载一次，于是 overlay 会
// 两次 bootstrap + 两次 loadFrame + 两次 show()，两个 controller 抢同一个 canvas，
// 首帧时序（画完才 show）就废了。settings/history 那种纯读页面留着 StrictMode 没问题。
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import OverlayPage from "./OverlayPage";

createRoot(document.getElementById("root")!).render(<OverlayPage />);
