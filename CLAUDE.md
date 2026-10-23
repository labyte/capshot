# capshot 项目规则

Tauri v2 截图工具（对齐 Snipaste 交互），Rust workspace + Vite/React 前端。

## 发布构建规则（release.yml，tag `v*` 触发）

- **仅 main 分支触发发布**：release.yml 有 `preflight` 守卫，判断「被推的标签提交是否为
  `origin/main` 的祖先」，不在 main 上则三个 job 全部跳过。发布流程固定为：
  开发分支 → 合并到 main → 在 main 上打 `v*` 标签 → 才构建。
- **压缩包文件名必须带版本号**：`capshot-win-x64-<tag>.zip`、`capshot-macos-arm64-<tag>.zip`
  （如 `capshot-win-x64-v0.1.8.zip`）。tag 从 `GITHUB_REF_NAME` 取；
  upload-artifact 的 path 用 glob（`capshot-*-*.zip`），Create Release 步骤同步匹配。
- 改产物命名时三处必须一起改：build-windows 的 `Compress-Archive -DestinationPath`、
  build-macos 的 `zip -r`、release job 的 `gh release create` 文件参数。
  artifact 名（`capshot-win-x64` / `capshot-macos-arm64`）被 download-artifact 的
  `pattern: capshot-*` 匹配，不要动。

## 构建硬性约束（本地与 CI 一致）

- **release 二进制必须开 `custom-protocol`**：
  `cargo build --release -p desktop --features custom-protocol`。
  不开 = dev 模式，前端不内嵌，运行时连 `http://localhost:1420`——
  在没有 vite dev server 的机器上表现为「一个错误网页」。
- **Windows 编译需要 rc.exe**（tauri-winres 嵌入资源用）：
  设 `RC` 环境变量指向 Windows SDK 的 `x64/rc.exe`
  （`C:\Program Files (x86)\Windows Kits\10\bin\<版本>\x64\rc.exe`）。
  CI 里由「Locate rc.exe」步骤自动定位。
- **前端必须先于 cargo 构建**：custom-protocol 是编译期把 `ui/dist` 打进二进制，
  改了 UI 代码要先 `npm run build`（在 `ui/`）再编 cargo。
- 发布前检查：`cargo test --workspace`（11 项内核测试）+ `npm run typecheck` 都要绿。

## 常用命令

```bash
npm run tauri dev             # 一条命令起 vite + debug 应用（**必须在仓库根目录跑**，见下）
npm run tauri build           # 走 CLI 打包（CI 不用它，发布仍走 cargo + custom-protocol）

cd ui && npm run dev          # vite dev server :1420（tauri debug 构建连它）
cd ui && npm run build        # 产出 ui/dist（多页，漏页会白屏）
cd ui && npm run typecheck
cargo run -p desktop          # debug 版托盘应用（需 vite）
cargo test --workspace
```

- 应用是托盘常驻，无主窗口。默认键位 F1 截图 / F3 贴图 / Shift+F3 显隐贴图。
- 单实例：重复启动静默退出；先 `taskkill //IM capshot.exe //F`。
- 浏览器调试截图层：vite 跑着时开 `http://localhost:1420/overlay.html?mock`
  （合成帧，交互链路完整可跑，生产构建自动剔除）。

### tauri CLI 的接法（为什么必须从根目录跑）

本项目是**非标准布局**：Tauri 的 crate 在 `apps/desktop`（不是 `src-tauri/`），前端在 `ui/`。
所以 `npm run tauri dev` 有四个硬条件，缺一个就起不来：

1. **CLI 只装在根 `package.json`** 的 devDependencies 里，`ui/` 不装第二份。
2. **必须在仓库根目录执行**：CLI 没有 `--cwd` 参数，它要求在当前目录**或其任一子目录**里
   找到 `tauri.conf.json`。从 `ui/` 跑会直接 panic
   `Couldn't recognize the current folder as a Tauri project`；从根目录能扫到
   `apps/desktop/tauri.conf.json` ✓。
3. **`beforeDevCommand` / `beforeBuildCommand` 写成 `npm --prefix ui run dev|build`**：
   显式指到 `ui/`，不受 CLI 的工作目录影响；而且根 `package.json` 里**不要放 `dev` 脚本**，
   否则旧的 `npm run dev` 形式会自己调自己。
4. **Windows 仍要 `RC` 环境变量**指向 SDK 的 `x64/rc.exe`（CLI 内部照样跑 cargo，
   tauri-build 嵌资源要 rc.exe）—— 与手工 `cargo build` 是同一个坑。

`tauri dev` 编的是**不带 `custom-protocol`** 的 debug 二进制，运行时连 `http://localhost:1420`，
所以 vite 必须在（CLI 的 `beforeDevCommand` 会自己起，端口被占就报 `Port 1420 is already in use`——
多半是上次遗留的 vite 没退干净）。**发布产物不走 CLI**：`release.yml` 用的是
`npm run build` + `cargo build --release -p desktop --features custom-protocol`。

> **⚠ `tauri dev` 会覆盖 `target/debug/capshot.exe`**（真踩过）：它写进去的是**没有内嵌前端**的
> dev 版，只认 `localhost:1420`。所以跑完 `tauri dev` 之后再直接起这个 exe，**没有 vite 就是一张
> 错误网页**。回到"独立可跑的 debug 版"要重编一次：
> `cargo build -p desktop --features custom-protocol`。
> 一眼判别法：`grep -a -o 'TextInput-[A-Za-z0-9_-]*\.js' target/debug/capshot.exe`
> 有输出 = 内嵌版（独立可跑）；**空 = dev 版（必须配 vite）**。

## 测试包目录 `capshot-win-x64/`

gitignored 的本地打包产物目录（exe + WebView2Loader.dll + probe.exe + README-test.md），
不要提交；正式分发走 GitHub Release。
