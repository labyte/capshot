# capshot —— 跨平台截图软件（Windows 主 / macOS 次）

把千问 macOS 客户端“截屏提问”的截屏原理（z 序窗口枚举、系统壳过滤、两级抓取、too-small 回退、
0.86 JPEG、权限 preflight、requestId 幂等）移植为通用截图工具。
逆向依据：对 Qianwen.app v5.0.0.268（macOS）截屏层的静态分析记录（Swift `AppShotCaptureController`，核心参数均有反汇编佐证）。

## 当前状态（里程碑）

| 里程碑 | 状态 | 验证方式 |
|---|---|---|
| M1 capture-core（types/trait/plan/coord/encode/filename） | ✅ 完成 | `cargo test --workspace` 11/11 绿（fixture 复刻参考判定案例） |
| M2 capture-macos 后端 + probe | ✅ 完成 | `probe target` 与已验证的参考实现（同逻辑的 Swift 原型）对照：同窗口、`via=window`、物理坐标一致；CGWindowListCreateImage 经 core-graphics 声明链接 |
| M3 capture-windows 代码（EnumWindows/DWM/WGC/BitBlt/PrintWindow + probe） | ✅ 编译完成 | `cargo check --target x86_64-pc-windows-msvc --examples` 0 error 0 warning；**真实抓取需 Windows 机器验收（M3 矩阵）** |
| M0 脚手架（workspace+tauri v2+静态多页 UI） | ✅ 完成 | 双目标 `cargo check`；启动冒烟 3s 无 panic |
| M4 壳层（托盘/全局热键/单实例/日志/设置/权限页/历史窗） | ✅ 代码完成 | 实机体验待用户验证（`cargo run -p desktop`） |
| M5 overlay 冻结帧框选（吸附/放大镜/跨屏提交） | ✅ 代码完成 | 同上 |
| M6 标注（矩形/箭头/文字/马赛克/撤销，前端渲染导出） | ✅ 基础版 | 同上 |
| M7 钉图（滚轮缩放锚定/透明度/拖动/双击关） | ✅ 完成 | M11 已补齐穿透开关与右键菜单 |
| M8 历史（SQLite+PNG+缩略图，复制/钉图/目录/删除/重编辑） | ✅ 完成 | editor 窗复用 overlay 引擎（`isEditor` 分支），导出另存为新条目 |
| M9 打包 | ⏳ 未开始 | —— |
| M11 交互层 Snipaste 化（React+Vite / 截图层 / 标注 / 贴图 / F1·F3） | ✅ 代码完成 | `cargo test --workspace` 11/11 仍绿（抓取内核零改动）；**手感待实机验收** |

## 布局

```
crates/capture-core     # 平台无关：契约 + 纯逻辑（全部可单测）
crates/capture-macos    # CGWindowList* + 权限 + point↔physical 换算 + examples/probe
crates/capture-windows  # EnumWindows/Dwm/WGC/BitBlt/PrintWindow + examples/probe（cfg 门控）
ui/                     # Vite 多页 + React：六页各自入口，加页面要同时改 vite.config.js 的 input
ui/src/annotate/        # 图形模型/绘制/命中/撤销栈/annotationJson v2（overlay、editor、贴图共用）
ui/src/overlay/engine/  # 截图层命令式引擎：状态机 + rAF 画布 + 像素读取（React 只管浮层 chrome）
ui/src/shared/theme.css # 单一样式表 + 视觉 token（按 body class 分透明/不透明作用域）
```

坐标契约：**物理像素虚拟屏坐标**（左上原点、y 向下、负坐标合法）。窗口 z_index 前→后。
`Frame` = RGBA8 stride 缓冲；编码 PNG 无损为主，JPEG 默认 **0.86**（参考常数），缩略图白底合成。

## 使用

```bash
cargo test --workspace                                   # 纯逻辑
cargo run -p capture-macos --example probe -- list --snap # macOS：吸附候选+有效矩形
cargo run -p capture-macos --example probe -- target --out /tmp/t.jpg --jpeg
cargo run -p capture-macos --example probe -- permission
# Windows 上同形：
cargo run -p capture-windows --example probe -- list --snap
cargo run -p capture-windows --example probe -- window <hwnd> --out w.png
cargo check --target x86_64-pc-windows-msvc -p capture-windows   # mac 上的类型验证
```

## 已验证的行为对齐（macOS，与参考实现逐点比对）

- 前台普通窗（企业微信）→ `via=window`，帧 (0,66,3024,1718)px = 参考同窗
- 菜单/控制中心浮层不作为默认目标（`best_snap_target` 优先 Normal）
- 两级抓取：窗口图 too-small 自动落屏幕帧兜底；日志字面保留参考风格
- `permission_denied` / `TargetNotFound` / `DegenerateGeometry` 错误语义
- `CGDisplay::active_displays()` 在 CLI 进程间歇性为空 → 主屏兜底（已修复并 5/5 稳定复跑）

## CI 与下载

- CI：push/PR 在 `windows-latest`（MSVC）与 `macos-14` 原生构建 + `cargo test`（`.github/workflows/ci.yml`）
- 发布：打 tag `v*` → Release 四个附件：免安装 `capshot-win-x64-<tag>.zip`（capshot.exe + probe.exe + WebView2Loader.dll）、
  `capshot-macos-arm64-<tag>.zip`（capshot.app + probe）；安装版 `capshot-win-x64-<tag>-setup.exe`（NSIS）、
  `capshot-macos-arm64-<tag>.dmg`（未签名/未公证，与 zip 同待遇，首跑有系统警告）
- Windows 验收步骤见 `docs/testing-windows.md`

## 运行

UI 是 Vite 多页工程（`ui/`）。**两种模式，别混：**

```bash
# A. 开发模式（HMR）—— 必须两个终端，缺一不可
cd ui && npm install && npm run dev      # 终端 1：Vite 起在 127.0.0.1:1420
cargo run -p desktop                     # 终端 2：托盘出现后截图

# B. 单命令（吃已构建的前端产物，不需要 Vite）
cd ui && npm run build
cargo run -p desktop --features custom-protocol
```

为什么必须这样：`tauri` 的 `dev` cfg 等于 **`!custom_protocol`**（`tauri/build.rs:252`）。
所以 `cargo run -p desktop` 属于 dev 模式，窗口加载 `tauri.conf.json` 里的 `build.devUrl`
—— Vite 没起来就是白屏，不是代码坏了。反过来 `--features custom-protocol` 是**编译期**把
`ui/dist` 打进二进制，dist 缺失会让 `generate_context!` 直接 panic（CI 因此必须先 `npm run build`）。
`cargo test --workspace` / 不带该 feature 的 `cargo build` 都不需要 dist。

- Windows 上 `tauri-build` 需要 `rc.exe`（编图标资源）；命令行环境没带 MSVC 变量时显式指路：
  `RC='C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe' cargo test --workspace`
  （CI 用 `ilammy/msvc-dev-cmd` + 同样的 `$RC` 解析）
- macOS debug 二进制首次截图会触发屏幕录制授权弹窗（TCC 按二进制路径记录，重新构建后可能需要重勾）
- 加新页面要同时改两处：`ui/<页>.html` **+** `ui/vite.config.js` 的 `rollupOptions.input`。
  只加 html 不加 input，prod 构建会**静默不产出该页**，表现为该窗口白屏（CI 有逐页存在性检查兜住）

## 与参考的已知差异（记录在案）

- macOS `visible_bounds` = 全 bounds（菜单栏/Dock inset 待 Tauri 宿主用 NSScreen 细化）
- 干净窗口抓取的 rect 入参用 CGRectNull（参考的全局常量真实值未取证）
- Windows `SetIsBorderRequired` 仅 Win11 可关黄框；Win10 黄框不可避免（可注册表 DisableBorderForAll）
- 混合 DPI 多屏换算为近似（单缩放假设）；列入 M3 手动矩阵

## 下一步

1. **交互层 Snipaste 化**（进行中，计划见 `~/.claude/plans/soft-percolating-mango.md`）：
   阶段 0 React+Vite 地基 ✅ → 1 截图层手感 → 2 标注工具条/属性栏 → 3 贴图窗 → 4 重编辑 + F1/F3 → 5 视觉统一。
   **抓取内核 `crates/capture-*` 全程零改动**（千问方案不变），改造只落在 `ui/` 与 `apps/desktop/`。
2. **Windows 真机验收**：跑 `capture-windows` probe 矩阵（双屏异 DPI / cloaked / WGC→BitBlt 回退），再走全流程
3. macOS 实机体验反馈修正（overlay 焦点、全屏 Space、权限引导文案）
4. M9 打包（NSIS/MSI + DMG，签名/公证）与 M10 打磨：visible_bounds 细化（NSScreen）、本地时区命名
