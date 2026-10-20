import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import SettingsPage from "./SettingsPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SettingsPage />
  </StrictMode>,
);
