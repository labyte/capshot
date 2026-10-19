//! AppState：后端、会话（token 幂等 + 帧缓存 ≤2，对应参考 requestId 缓存与 R-5 内存上限）、
//! 选区、剪贴板、设置、历史、快捷键。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

use capture_core::{BackendCapabilities, CaptureBackend, Frame, MonitorInfo, WindowInfo};

use crate::history::HistoryStore;
use crate::settings::Settings;

/// 提交后的选区：原图 Frame + 渲染后 PNG（pin/历史/剪贴板共用）
pub struct Sel {
    pub frame: Frame,
    pub rect: PhysicalRectOwned,
    pub png: Vec<u8>,
    pub source: String,
    pub app_hint: Option<String>,
}

/// PhysicalRect 属 capture-core，此处别名避免 state 依赖 types 路径细节
pub type PhysicalRectOwned = capture_core::PhysicalRect;

pub struct Session {
    pub token: u64,
    pub monitors: Vec<MonitorInfo>,
    pub windows: Vec<WindowInfo>,
    /// monitor id → 冻结帧（物理像素）+ PNG 缓存
    pub frames: HashMap<u64, Frame>,
    pub pngs: HashMap<u64, Vec<u8>>,
    pub overlays: Vec<String>,
}

pub struct AppState {
    pub backend: Box<dyn CaptureBackend>,
    pub sessions: Mutex<VecDeque<Session>>, // 最近 2 个
    pub selections: Mutex<HashMap<u64, Sel>>,
    pub seq: Mutex<u64>,
    /// 热键去抖 / 重复触发聚焦（对应 lastAppShotCaptureCache 语义）
    pub active: Mutex<Option<(u64, Instant)>>, // (token, since)
    pub settings: Mutex<Settings>,
    pub settings_path: std::path::PathBuf,
    pub history: Mutex<HistoryStore>,
    pub clip: Mutex<Option<arboard::Clipboard>>,
    pub current_shortcut: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(
        backend: Box<dyn CaptureBackend>,
        settings: Settings,
        settings_path: std::path::PathBuf,
        history: HistoryStore,
    ) -> Self {
        Self {
            backend,
            sessions: Mutex::new(VecDeque::new()),
            selections: Mutex::new(HashMap::new()),
            seq: Mutex::new(1),
            active: Mutex::new(None),
            settings: Mutex::new(settings),
            settings_path,
            history: Mutex::new(history),
            clip: Mutex::new(arboard::Clipboard::new().ok()),
            current_shortcut: Mutex::new(None),
        }
    }

    pub fn next_id(&self) -> u64 {
        let mut s = self.seq.lock().unwrap();
        *s += 1;
        *s
    }

    pub fn put_session(&self, s: Session) {
        let mut g = self.sessions.lock().unwrap();
        while g.len() >= 2 {
            g.pop_front();
        }
        g.push_back(s);
    }

    #[allow(dead_code)] // M8 重编辑预留
    pub fn session_monitors(&self) -> Vec<MonitorInfo> {
        self.sessions
            .lock()
            .unwrap()
            .back()
            .map(|s| s.monitors.clone())
            .unwrap_or_default()
    }

    #[allow(dead_code)] // 前端能力展示用
    pub fn capabilities(&self) -> BackendCapabilities {
        self.backend.capabilities()
    }

    pub fn save_settings(&self) {
        let s = self.settings.lock().unwrap().clone();
        s.save(&self.settings_path);
    }
}
