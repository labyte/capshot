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

## CI 构建产物规则（ci.yml，push main / PR 触发）

- **CI 也出安装版 + 免安装版**，与 release.yml 同形态、同清单，只是上传成 workflow artifact
  （不打 tag 就能从 Actions 页面下载当次构建，`retention-days: 14`）。
  免安装与安装版**分两个 artifact**（`capshot-ci-<plat>-portable-*` / `capshot-ci-win-x64-setup-*`、
  `capshot-ci-macos-arm64-dmg-*`），想拿哪个下哪个，不用整包下载。
- **CI 没有 tag，文件名用 `<version>-<shortsha>`**：version 读 `apps/desktop/tauri.conf.json`
  （`node -p`），sha 取 `${GITHUB_SHA::7}`，都在 `Resolve artifact names` 步骤里算成
  `steps.pkg.outputs.plat` / `.suffix`。改文件名只需改这一处 + 各平台 Package 步骤。
- **打包用 `tauri build`，不能用 `tauri bundle` 去复用 workspace 构建的产物**：
  `Swatinem/rust-cache@v2` 按设计**不缓存 workspace 自己的 crate**（README 原话
  "the workspace crates themselves are not cached"）。恢复缓存后
  `cargo build --release --workspace --examples --features desktop/custom-protocol`
  可能判定 desktop 是 fresh 而**跳过重链**，`target/release/capshot(.exe)` 压根不存在
  —— 实测整个 workspace 构建只花 3.75s，只编了 capture-core/macos/windows 三个。
  `tauri build` 内部那次 cargo 调用 feature 组合不同、指纹不同，会真编 desktop，
  产物缺失时也会直接报错。所以那条 workspace release 构建**只当编译检查**，不是产物来源。
  （`tauri bundle` 只打包不编译，在没有二进制时才会「静默无事发生」，别用。）
- **probe 必须按平台显式 `-p` 编**：`capture-windows` 与 `capture-macos` 的 example
  同名 `probe`，`--workspace --examples` 会往同一个 `target/release/examples/probe(.exe)`
  互相覆盖（cargo 已警告 `output filename collision`，并说以后可能变硬错误），
  谁后编谁留下——不重建就可能把**另一平台的 probe** 打进 zip。
  显式 `-p capture-<平台> --example probe` 的指纹与 workspace 那次不同，是实打实的重编（实测 40s）。
  release.yml 同理。
- 挑 NSIS/DMG 产物**按 mtime 倒序取最新**，别用字母序 `First 1`：`target/release/bundle/`
  不会自动清空，版本号不变时旧包留着，`0.1.20` 会排在 `0.1.21` 前面（本地实测踩到）。
- 打包前先跑「一眼判别法」自检（`Verify binary embeds UI`）：没内嵌前端就直接失败，
  别把开出来是错误网页的壳发出去。放在 `tauri build` 之后 = 检的是真要发的那个。

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
- **macOS 打包必须有 `icons/icon.icns`**，且要列进 `tauri.conf.json` 的 `bundle.icon`。
  缺了就是 `failed to bundle project: Failed to create app icon: 'No matching IconType'`
  —— **v0.1.21 的 Release 就是这么挂的**（build-macos 失败 → release job 被 skip → 那次
  一个附件都没发出去）。原因（读 `tauri-bundler/src/bundle/macos/icon.rs` 确证）：
  `create_icns_file` 先看 icon 列表里有没有 `.icns`，**有就直接用**；没有才 fallback 去把
  PNG 打成 ICNS，而 fallback 里我们那张 1024×1024 的 `icon.png`（文件名不带 `@2x`，
  density=1）在 `icns::IconType::from_pixel_size_and_density(1024,1024,1)` 上**没有对应类型**
  （1024 只作为 `ic10` = 512@2x 存在）→ 抛错。
  补法：`npx tauri icon apps/desktop/icons/icon.png --output <临时目录>`，**只把生成的
  `icon.icns` 拷进 `apps/desktop/icons/`**——别让它覆盖 `icon.ico`（tauri 导出的 ico 是全 PNG
  帧，会重新触发 RC2176）。生成后核对一下 ico 仍是 8×BMP + 256×PNG。
  `build.rs` 的 `rerun-if-changed` 已补 `icons/icon.icns`。
- **`scripts/make-app.sh` 组装的免安装 `.app` 图标靠 `.icns` + `CFBundleIconFile`**：
  光把 `icon.png` 扔进 `Contents/Resources/` 是不显示的（Finder/Dock 给通用图标）。
  版本号也别再硬写，脚本现在从 `apps/desktop/tauri.conf.json` 里 sed 出来。
- **前端必须先于 cargo 构建**：custom-protocol 是编译期把 `ui/dist` 打进二进制，
  改了 UI 代码要先 `npm run build`（在 `ui/`）再编 cargo。
- 发布前检查：`cargo test --workspace`（11 项内核测试）+ `npm run typecheck` 都要绿。

## 常用命令

```bash
npm run tauri dev             # 一条命令起 vite + debug 应用（**必须在仓库根目录跑**，见下）
npm run tauri build           # **CI 与 release 都走它**（`-- --bundles nsis|dmg`），exe 与安装包同一次构建

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
> **在 macOS 上必须加 `LC_ALL=C`**：BSD grep 在 UTF-8 locale 下啃几十 MB 无换行的
> Mach-O 会**静默失配**（实测：同一份 UI 产物，windows-latest 的 GNU grep 命中、
> macos-14 不命中；把 v0.1.20 的 mac 二进制拉下来按字节搜，`TextInput-DHGYpKV_.js`
> 命中 1 次，说明东西在、是 grep 的姿势不对）。C locale 按单字节处理，两边行为一致。

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
