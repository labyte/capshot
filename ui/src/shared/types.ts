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

/** bootstrap 在 editor 窗返回的形态（重编辑：底图就是这条 sel 的 PNG，无吸附、无二级抓取） */
export interface BootEditor {
  kind: "editor";
  sel: number;
  width: number;
  height: number;
  bounds: PhysicalRect;
  scale: number;
  annotation?: string | null;
  settings: SettingsDto;
}

export type BootCtx = BootOverlay | BootEditor;

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

export interface PermissionStatusDto {
  screenRecording: boolean;
  accessibility: boolean;
}
