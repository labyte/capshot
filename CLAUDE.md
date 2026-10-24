# capshot 项目规则

Tauri v2 截图工具（对齐 Snipaste 交互），Rust workspace + Vite/React 前端。

## 发布构建规则（release.yml，tag `v*` 触发）

- **仅 main 分支触发发布**：release.yml 有 `preflight` 守卫，判断「被推的标签提交是否为
  `origin/main` 的祖先」，不在 main 上则三个 job 全部跳过。发布流程固定为：
  开发分支 → 合并到 main → 在 main 上打 `v*` 标签 → 才构建。
- **产物文件名必须带版本号**：免安装 `capshot-win-x64-<tag>.zip`、`capshot-macos-arm64-<tag>.zip`；
  安装版 `capshot-win-x64-<tag>-setup.exe`（NSIS）、`capshot-macos-arm64-<tag>.dmg`。
  tag 从 `GITHUB_REF_NAME` 取。NSIS/DMG 的默认名（`CapsShot_<ver>_x64-setup.exe` /
  `CapsShot_<ver>_aarch64.dmg`）必须在各平台 Package 步骤 rename 成约定名。
  upload-artifact 的 path 用 glob（`capshot-win-x64-*` / `capshot-macos-arm64-*`，zip+安装版一起），
  release job 的 `gh release create` **显式列四个文件**（缺任何一个直接报错，不让 release 静默少附件）。
- 改产物命名时四处必须一起改：build-windows 的 `Compress-Archive` 与 setup rename、
  build-macos 的 `zip -r` 与 dmg rename、release job 的 `gh release create` 文件清单。
  artifact 名（`capshot-win-x64` / `capshot-macos-arm64`）被 download-artifact 的
  `pattern: capshot-*` 匹配，不要动。

## 构建硬性约束（本地与 CI 一致）

- **release 二进制必须开 `custom-protocol`**：
  `cargo build --release -p desktop --features custom-protocol`。
  不开 = dev 模式，前端不内嵌，运行时连 `http://localhost:1420`——
  在没有 vite dev server 的机器上表现为「一个错误网页」。
- **Windows 编译需要 rc.exe**（tauri-winres 嵌图标/manifest 资源用）：
  **不用手设了** —— `apps/desktop/build.rs` 的 `ensure_rc()` 会自动定位
  `%ProgramFiles(x86)%\Windows Kits\10\bin\<版本>\x64\rc.exe`，规则与 CI「Locate rc.exe」步骤
  完全一致（路径倒序 = 最新 SDK 优先）。定位结果打在 build script 的 stdout
  （`target/debug/build/desktop-*/output` 里的 `auto-located rc.exe: …`，或 `cargo build -vv`）。
  仍可用 `RC` / `RC_<target>` 覆盖，但**得真能用**：值解析不到、或 MSVC 目标配了 GNU 的
  `*windres`，build.rs 会打 warning 并改走自动定位（`.cargo/config.toml` 里那条 `[env] RC=…windres`
  就是这么被绕开的 —— cargo 的 `[env]` 不分 target，会污染 MSVC 构建）。
- **改了 `icons/` 必须让 build script 重跑**：tauri-build 自己只对 `tauri.conf.json` 与
  `capabilities/` 发 `rerun-if-changed`，**不含 icons/**。build.rs 已补上这两条；
  哪天新增图标文件（如 `icon.icns`）要一起补。图标是**编译期**烘进 exe 的 PE 资源（32512/IDI_APPLICATION），
  Windows 上托盘的 `default_window_icon()` 运行时读的就是它（取 **32×32** 那一档，
  `icons/icon.png` 在 Windows 这条路上根本不参与），所以 build script 不重跑 = 新图标永远看不见。
  取证方法：`python -I scanexe.py <新ico> <旧ico> target/debug/capshot.exe`（按 ICO 帧字节逐个查命中）。
- **`icon.ico` 里 16–128 必须是经典 BMP，只有 256 能用 PNG**：提交 `aaa01ea`
  「rc.exe 拒绝 PNG-in-ICO（RC2176）」就是为此而改的，重画图标时别又导出成全 PNG
  （已实测：同一个 ico 改回 BMP 容器，9 帧逐通道最大绝对差 = 0，纯容器变化、零像素代价）。
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
4. **Windows 的 rc.exe 不用再管**（CLI 内部照样跑 cargo、照样要嵌资源）：
   build.rs 会自动定位，见上面那条。历史上 `npm run tauri dev` 之所以挂在
   `tauri-winres … Are you sure you have RC.EXE in your $PATH` 上，元凶是
   `.cargo/config.toml` 里 `[env] RC = "x86_64-w64-mingw32-windres"`（GNU 专用、本机还没装），
   现已删除该 `[env]` 并由 build.rs 兜底。

`tauri dev` 编的是**不带 `custom-protocol`** 的 debug 二进制，运行时连 `http://localhost:1420`，
所以 vite 必须在（CLI 的 `beforeDevCommand` 会自己起，端口被占就报 `Port 1420 is already in use`——
多半是上次遗留的 vite 没退干净）。**发布主链路走 `tauri build --bundles`**（v0.1.21 起）：exe 与安装包（NSIS/DMG）出自同一次
构建（release 下 `custom-protocol` 默认开，build-windows 的 Package 步骤用下面这条一眼判别法
做自检，缺失即失败）；zip 免安装包仍手工 `Compress-Archive` / `zip` 组装。
别再改回裸 `cargo build` 出 exe——那会丢掉安装包，且 custom-protocol 漏开时没人兜底。

> **⚠ `tauri dev` 会覆盖 `target/debug/capshot.exe`**（真踩过）：它写进去的是**没有内嵌前端**的
> dev 版，只认 `localhost:1420`。所以跑完 `tauri dev` 之后再直接起这个 exe，**没有 vite 就是一张
> 错误网页**。回到"独立可跑的 debug 版"要重编一次：
> `cargo build -p desktop --features custom-protocol`。
> 一眼判别法：`grep -a -o 'TextInput-[A-Za-z0-9_-]*\.js' target/debug/capshot.exe`
> 有输出 = 内嵌版（独立可跑）；**空 = dev 版（必须配 vite）**。

## 推送 GitHub 走 VPN 代理

推送反复出现 `Recv failure: Connection was reset` / `Failed to connect to github.com port 443`
（而 `api.github.com` 反而通 200）时，是 `github.com` 这个主机名被掐。VPN 客户端切到
**「系统 HTTP 代理」模式**后走它的代理即可。

**端口别写死，从注册表读**——那是系统代理的权威来源，客户端换端口/换机器都跟着变：

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" //v ProxyServer
# 本机实测 = 127.0.0.1:12000（不是 7890；文档里曾长期写着 7890，那个端口压根没人听）
```

用 `-c` 一次性带代理推，**不写进 config**，用完没有残留、也不需要 `--unset`：

```bash
# 先确认真能通（拿到 200 再推）：
curl -m 15 -x http://127.0.0.1:12000 -sS -o /dev/null -w "%{http_code}\n" https://github.com/
# 再推：
git -c http.https://github.com.proxy=http://127.0.0.1:12000 push origin main
```

**三条必须知道的坑**（都实测过）：

1. **先确认端口在听再设**：`netstat -ano | grep ":<端口>.*LISTENING"`。
   客户端跑的是 **TUN 全流量接管**时端口往往不存在——此时设了代理等于把推送弄瘫
   （实测：端口没人听时 `git ls-remote` 直接失败，而**直连是通的**）。TUN 模式下什么都不用配，直连。
2. **`curl -x` 试通 ≠ 端口能当代理**：8888 上有监听，但拿它当代理是 `Proxy CONNECT aborted`。
   只有 `curl -x http://127.0.0.1:<端口> https://github.com/` 返回 200 才算数。
3. **别写 `--global`**：per-URL 规则只作用于 `github.com`，全局设了会影响其它内网 git。

## 测试包目录 `capshot-win-x64/`

gitignored 的本地打包产物目录（exe + WebView2Loader.dll + probe.exe + README-test.md），
不要提交；正式分发走 GitHub Release。
