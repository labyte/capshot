import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

// 多页：每一页都必须登记进 rollupOptions.input —— 漏掉的页面 prod 构建不产出该 html，
// 对应窗口白屏（WebviewUrl::App("overlay.html") 找的是 dist/overlay.html）。
export default defineConfig({
  // tauri://localhost 与 devUrl 下都安全；绝对 "/assets/*" 在自定义协议里会解析失败
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/target/**", "**/dist/**"] },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: !!process.env.TAURI_DEBUG,
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        overlay: resolve(root, "overlay.html"),
        pin: resolve(root, "pin.html"),
        settings: resolve(root, "settings.html"),
        history: resolve(root, "history.html"),
        editor: resolve(root, "editor.html"),
      },
    },
  },
});
