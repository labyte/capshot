//! 设置持久化（JSON 文件于 app_config_dir）。对应计划的 settings 项与 Qianwen 的
//! prefs/keybinding 语义（存储位置与格式自定，行为对齐：改键即注册、冲突保留旧值）。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub hotkey: String,
    pub quality: f64,
    pub flash_ms: u64,
    pub autostart: bool,
    pub save_on_copy: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "Alt+Shift+A".into(),
            quality: 0.86,
            flash_ms: 250, // 参考 appShotAnimationTotalDuration 未取证值，默认按其量级
            autostart: false,
            save_on_copy: false,
        }
    }
}

impl Settings {
    pub fn load(path: &std::path::Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }
    pub fn save(&self, path: &std::path::Path) {
        if let Some(s) = serde_json::to_string_pretty(self).ok() {
            let _ = std::fs::write(path, s);
        }
    }
}
