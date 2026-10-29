//! 与 apps/desktop/src/commands.rs 的 DTO 一一对应（serde 均为 camelCase）。

export interface PhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SettingsDto {
  /** 截图，默认 F1 */
  hotkey: string;
  /** 从剪贴板贴图，默认 F3 */
  hotkeyPin: string;
  /** 隐藏/显示全部贴图，默认 Shift+F3 */
  hotkeyHidePins: string;
  /** 贴图鼠标穿透，默认空（不绑定） */
  hotkeyThrough: string;
  hotkeyMigrated?: boolean;
  quality: number;
  flashMs: number;
  autostart: boolean;
  saveOnCopy: boolean;
  /** 截图保存位置（保存时直接落盘）。空串 = 每次保存弹「另存为」 */
  saveDir: string;
}

/** 可录制快捷键的槽位 */
export type HotkeySlot = "hotkey" | "hotkeyPin" | "hotkeyHidePins" | "hotkeyThrough";

/**
 * hotkey_status 返回的一槽状态（对应 apps/desktop/src/commands.rs::hotkey_status）。
 * 只有**已绑定**的槽才会出现在这里，所以前端不用为「未绑定」画图标。
 *
 * - `ok`：这把键真的注册上了（行末绿勾）；false = 没生效（红叉）。
 * - `label`：短原因，措辞只在 Rust 侧 `HotkeyFailureKind::label()` 有一份，前端别再造句子。
 * - `failedKey`：出问题的键名。与 `key` 不同 = 刚改的那把新键被拒（当前值仍是能用的旧键），
 *   这时才需要在行末补一句文字说明是哪把键，否则图标 + hover 就够。
 * - `detail`：系统给的原始错误串（如 `注册失败：HotKey already registered`），只进 hover。
 */
export interface HotkeySlotStatusDto {
  slot: HotkeySlot;
  key: string;
  ok: boolean;
  failedKey: string | null;
  label: string | null;
  detail: string | null;
}

/** bootstrap 在 overlay 窗返回的形态 */
export interface BootOverlay {
  kind: "overlay";
  token: number;
  monitor: number;
  bounds: PhysicalRect;
  scale: number;
  windows: SnapshotDto[];
  settings: SettingsDto;
  /** 上一次成功截图的虚拟屏选区，H 键恢复用（首次运行为 null） */
  lastRect?: PhysicalRect | null;
}

/** bootstrap 在 pin 窗返回的形态 */
export interface BootPin {
  kind: "pin";
  sel: number;
  width: number;
  height: number;
  pad?: number;
}

export interface BootPlain {
  kind: "plain";
}

export type Boot = BootOverlay | BootPin | BootPlain;

/** commands.rs::SnapDto */
export interface SnapshotDto {
  windowId: number;
  title: string | null;
  appName: string | null;
  bundleId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** history.rs::HistoryRow */
export interface HistoryRow {
  id: number;
  created_at: number;
  width: number;
  height: number;
  source: string;
  app_hint: string | null;
  rect: PhysicalRect;
  thumb_base64: string;
}

/**
 * 权限状态（对应 capture-core::PermissionStatus，serde camelCase）。
 * `null` = 本平台没有这项权限概念（Windows 无 TCC），**不是「未授权」**：
 * 设置页见到 `screenRecording === null` 时整块「权限」都不渲染。
 */
export interface PermissionStatusDto {
  screenRecording: boolean | null;
  accessibility: boolean | null;
}
