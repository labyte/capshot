//! 设置持久化（JSON 文件于 app_config_dir）。对应计划的 settings 项与 Qianwen 的
//! prefs/keybinding 语义（存储位置与格式自定，行为对齐：改键即注册、冲突保留旧值）。

use serde::{Deserialize, Serialize};

/// 迁移前（千问键位时代）的默认截图热键。老用户的 settings.json 里存的是这个字面值，
/// `#[serde(default)]` 只对**缺字段**生效，救不了已存在的值 —— 所以要做一次性迁移。
pub const LEGACY_SNIP_HOTKEY: &str = "Alt+Shift+A";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// 截图（对齐 Snipaste 的 F1）
    pub hotkey: String,
    /// 从剪贴板贴图（对齐 Snipaste 的 F3）
    pub hotkey_pin: String,
    /// 隐藏/显示全部贴图（对齐 Snipaste 的 Shift+F3）
    pub hotkey_hide_pins: String,
    /// 贴图鼠标穿透开关。默认空 = 不绑定：Snipaste 当前版本也不给穿透默认键，
    /// 因为裸键会全局吞掉正常输入。穿透可从贴图右键菜单开，托盘可兜底恢复。
    pub hotkey_through: String,
    /// 老配置是否已迁移过（避免用户主动改回 Alt+Shift+A 后又被覆盖）
    pub hotkey_migrated: bool,
    pub quality: f64,
    pub flash_ms: u64,
    pub autostart: bool,
    pub save_on_copy: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "F1".into(),
            hotkey_pin: "F3".into(),
            hotkey_hide_pins: "Shift+F3".into(),
            hotkey_through: String::new(),
            hotkey_migrated: true, // 新装无需迁移
            quality: 0.86,
            flash_ms: 250, // 参考 appShotAnimationTotalDuration 未取证值，默认按其量级
            autostart: false,
            save_on_copy: false,
        }
    }
}

impl Settings {
    pub fn load(path: &std::path::Path) -> Self {
        let raw = std::fs::read_to_string(path).ok();
        let mut s: Settings = raw
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if !s.hotkey_migrated {
            // 只在"仍是旧的千问默认键"时才动它；用户自定义过的键位保持原样
            if s.hotkey == LEGACY_SNIP_HOTKEY {
                s.hotkey = Settings::default().hotkey;
            }
            s.hotkey_migrated = true;
        }
        s
    }

    pub fn save(&self, path: &std::path::Path) {
        if let Some(s) = serde_json::to_string_pretty(self).ok() {
            let _ = std::fs::write(path, s);
        }
    }

    /// 当前生效的 (绑定名, 动作) 列表，空字符串跳过
    pub fn bindings(&self) -> Vec<(String, crate::state::ShortcutAction)> {
        let mut out = Vec::new();
        if !self.hotkey.trim().is_empty() {
            out.push((self.hotkey.clone(), crate::state::ShortcutAction::Snip));
        }
        if !self.hotkey_pin.trim().is_empty() {
            out.push((self.hotkey_pin.clone(), crate::state::ShortcutAction::PinClipboard));
        }
        if !self.hotkey_hide_pins.trim().is_empty() {
            out.push((self.hotkey_hide_pins.clone(), crate::state::ShortcutAction::TogglePins));
        }
        if !self.hotkey_through.trim().is_empty() {
            out.push((self.hotkey_through.clone(), crate::state::ShortcutAction::ToggleThrough));
        }
        out
    }
}
