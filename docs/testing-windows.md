# Windows 真机测试指引

capshot Windows 测试包（2026-10-19 交叉编译 x86_64）

■ 前置条件
- Windows 10 1809+ / Windows 11
- WebView2 运行时：Win11 自带；Win10 若未装过 Edge WebView2 需先安装
  （https://developer.microsoft.com/microsoft-edge/webview2/）。
  WebView2Loader.dll 随 Release 包附带，与 exe 同目录。

■ 第一步：probe（截图内核，无界面，先验证抓取正确性）
cmd / PowerShell 里运行：
  probe.exe permission
  probe.exe list --snap
  probe.exe target --out t.png
  probe.exe monitor 0 --out m.png
  probe.exe window <id> --out w.png     （id 取自 list）
检查点：
  1. list --snap：candidates 应从顶到底列出普通窗口（任务栏/桌面不出现），
     effective 是物理像素（DPI 150% 时约等于 窗口pt×1.5）
  2. target：优先 via=window；对全屏应用/游戏窗口观察是否自动 to-small 兜底
  3. window：输出图与窗口实际内容一致（Chromium/Electron 若黑帧=PrintWindow 已知限制）
  4. 双屏/不同缩放：m.png 分辨率=该屏物理分辨率；左副屏坐标为负仍应正确

■ 第二步：capshot.exe（完整应用，托盘常驻，无安装）
  双击 capshot.exe → 托盘出现蓝色图标。
  · Alt+Shift+A（或托盘「截图」/左键点托盘）→ 全屏冻结帧框选
  · 悬停高亮窗口、拖拽框选、8向手柄微调、Shift 正方形、放大镜
  · 双击（未框选时）= 干净窗口图并直接复制
  · 工具栏：□矩形 ↗箭头 T文字 ▦马赛克 ↶撤销 | 复制/存图/钉图/复制+存/取消
  · Enter=复制 Esc=取消；图片存 %APPDATA%\app.capshot.desktop\history\...
  · 托盘「历史…」/「设置…」；设置里可改热键（点击后按新组合键）、看权限

■ 已知边界（欢迎反馈）
  - Win10 无 SetIsBorderRequired → WGC 截图可能带黄框（Win11 正常）
  - DRM/部分硬件叠加层窗口截出为黑（系统限制，同类工具一致）
  - 钉图点击穿透按钮暂未提供；历史"重编辑"未做

