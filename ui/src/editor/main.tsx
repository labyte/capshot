// 重编辑器入口。与 overlay 同样不套 StrictMode：双挂载会让 controller 建两个，
// 底图与已还原的标注会被重复装载。
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import EditorPage from "./EditorPage";

createRoot(document.getElementById("root")!).render(<EditorPage />);
