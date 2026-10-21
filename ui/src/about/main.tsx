import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../shared/theme.css";
import AboutPage from "./AboutPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AboutPage />
  </StrictMode>,
);
