// 贴图入口。和 overlay 一样不套 StrictMode：双挂载会让 pin_ready / 窗口几何
// 被触发两次，出现「先放大再缩回」的抖动。
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import PinPage from "./PinPage";

createRoot(document.getElementById("root")!).render(<PinPage />);
