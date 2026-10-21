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
  双击 capshot.exe → 托盘出现图标。**默认键位已对齐 Snipaste：F1 截图 / F3 贴图（剪贴板）/
  Shift+F3 隐藏显示全部贴图**（旧键 Alt+Shift+A 会在首次启动时自动迁移到 F1）。
  托盘菜单：截图 / 贴图剪贴板 / 隐藏·显示全部贴图 / 解除所有贴图穿透 / 关闭所有贴图 / 历史 / 设置。

  截图层（冻结帧上操作，抓取仍走千问那套：z 序枚举 + 两级抓取）：
  · 悬停高亮窗口；**单击**即采纳整窗，按下即拖则自由框选
  · **Tab / 滚轮**在光标下的命中链里换层级（父子窗、边框内层）
  · 拖框时有跟随光标的 `X, Y` 与 `W × H` 标签 + 像素放大镜
  · **WASD** 移光标 1px；**方向键**移选区；**Ctrl+方向键**外扩、**Shift+方向键**内缩；
    拖拽中**按住 Space** 转为整体移动
  · **Alt** 强制放大镜，**C** 复制颜色，**Shift+C** 切 RGB/HEX
  · **右键**：标注中=结束当前图形；已定选区=退回重新决定；检测态再按=放弃截图（取消也可 Esc）
  · **R** 恢复上次选区，**Ctrl+A** 全屏；**Enter / 双击 / Ctrl+C** 复制，**Ctrl+S** 存图，
    **Ctrl+T / 中键** 贴图
  · 工具条（图标 + 悬停显示快捷键）：V形状（矩形⇄椭圆共按钮） P箭头 L画笔 M马克笔 T文字 X马赛克 N序号 E橡皮擦，
    加撤销/重做与贴图/存图/复制/关闭；选工具后出现**按工具定制的属性栏**（对齐 Snipaste）：
    线宽圆点（点击/滚轮/[ ] 调）、矩形⇄椭圆切换、箭头样式下拉（—无头 / →单箭头 / ↔双箭头）、
    文字 B/斜体/删除线/字体/字号、
    马克笔与橡皮的半透明笔刷示意、橡皮大小（拖过即删标注，Ctrl+Z 可整次回滚）、色板、填充、马赛克粒度
  · 已画图形可再次点选：拖动、方向键微调、Del 删除
  · 未框选时双击某窗口 = 干净整窗图并直接复制（两级抓取，too-small 自动回退缓存帧）
  · 图片存 %APPDATA%\app.capshot.desktop\history\...

  贴图（Pin）：
  · 出现在截图原位，**与选区像素级对齐**（投影改为窗内自绘，不再有 8px 偏移）
  · 滚轮缩放（光标锚定，带百分比气泡）；**Ctrl+滚轮** 透明度；**中键** 复位
  · 方向键微调 1px；**1/2** 旋转 ±90°；**3/4** 水平/垂直翻转；**+/-** 缩放
  · **Esc / Ctrl+W / 双击** 关闭；**Shift+Esc** 销毁；**Shift+双击** 缩略图模式
  · **右键菜单**：复制 / 保存 / 重新编辑 / 恢复原始大小 / 缩放 / 不透明度 / 灰度 / 反色 /
    鼠标穿透 / 保持置顶 / 关闭 / 关闭所有贴图
  · 开启鼠标穿透后该贴图收不到鼠标事件 —— 用托盘「解除所有贴图穿透」恢复
  · 关掉贴图后再按 **F3**（剪贴板无图时）可复活最近关闭的一张

  历史窗：双击条目 = 进重编辑器（可再改标注，导出**另存为新条目**，原条目不变）
  设置窗：四个快捷键槽可分别改键（F1–F12 / PrintScreen / Pause 可裸键，其余需修饰键）

■ 已知边界（欢迎反馈）
  - Win10 无 SetIsBorderRequired → WGC 截图可能带黄框（Win11 正常）
  - DRM/部分硬件叠加层窗口截出为黑（系统限制，同类工具一致）
  - Chromium/Electron 窗口用 PrintWindow 兜底时可能黑帧（同类工具同现象）
  - 选区目前限制在单个显示器内（跨屏需连截两次）；贴图组、磁性对齐、OCR、裁剪未做


