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
    /// annotationJson（v2 结构）。导出时随条目落进历史的 annotation_json 列；
    /// 「重新编辑」已移除，所以当前没有读取方（数据仍写，见 history.rs::insert）。
    /// 截图当场的 sel 没有它，贴图上的标注已经烘进像素。
    pub annotation: Option<String>,
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

/// 全局快捷键的动作分派。存**已解析的 Shortcut** 而不是字符串：
/// Shortcut 的 Display 是大写规范形（`ALT+SHIFT+A`），与用户存的原始写法不一致，
/// 按字符串比会漏触发。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutAction {
    Snip,
    PinClipboard,
    TogglePins,
    ToggleThrough,
}

impl ShortcutAction {
    /// 对应设置里的槽位字段名，**与 `ui/src/shared/types.ts` 的 `HotkeySlot` 逐字对齐**：
    /// 设置页靠它把一条失败记录钉回正确的那一行，对不上就谁都不亮。
    pub fn slot(&self) -> &'static str {
        match self {
            ShortcutAction::Snip => "hotkey",
            ShortcutAction::PinClipboard => "hotkeyPin",
            ShortcutAction::TogglePins => "hotkeyHidePins",
            ShortcutAction::ToggleThrough => "hotkeyThrough",
        }
    }
}

pub type Shortcut = tauri_plugin_global_shortcut::Shortcut;

/// 快捷键失败的原因类别。分类必须在注册现场就做好：启动通知只说「哪把键」，
/// 设置页要说「为什么」（但只说短原因 `label`，内部错误串留给日志和 hover 提示）。
/// 若只存一条拼好的字符串，展示层就得反过来解析「（注册失败：…）」这种内部措辞，
/// 改一个字文案就散架。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HotkeyFailureKind {
    /// 系统侧注册不上 —— 绝大多数是被别的程序占用（本机实测：Snipaste 占 F1）
    Occupied,
    /// 用户手填的键名解析不了
    Invalid,
    /// 同一把物理键被两个动作槽抢
    Conflict,
}

impl HotkeyFailureKind {
    /// 给用户看的短原因。措辞只有这一份，设置页与改键返回都复用它。
    pub fn label(&self) -> &'static str {
        match self {
            HotkeyFailureKind::Occupied => "已被其它程序占用",
            HotkeyFailureKind::Invalid => "键名无法识别",
            HotkeyFailureKind::Conflict => "与另一个快捷键冲突",
        }
    }
}

/// 一条快捷键失败记录。
#[derive(Debug, Clone)]
pub struct HotkeyFailure {
    /// 用户配置里的原始写法（`F1`、`Shift+F3`），可直接读给用户听
    pub key: String,
    /// 哪个槽位（`ShortcutAction::slot`），设置页据此定位到具体那一行
    pub slot: &'static str,
    pub kind: HotkeyFailureKind,
    /// 内部原因（如 `注册失败：HotKey already registered`）。只进日志与 hover 提示，
    /// 不出现在通知或正文里 —— 用户读不懂，还会把短行撑爆。
    pub detail: String,
}

impl HotkeyFailure {
    /// 日志用的一行完整说明：`F1（注册失败：…）`
    pub fn display(&self) -> String {
        format!("{}（{}）", self.key, self.detail)
    }
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
    /// 当前注册的 (快捷键, 动作)。改键时整批重注册，失败回滚旧表。
    pub bindings: Mutex<Vec<(Shortcut, ShortcutAction)>>,
    /// 上一次成功导出的选区（虚拟屏物理坐标）。overlay 的「H 恢复上次选区」用，
    /// 对应 Snipaste 的 R 键语义。
    pub last_rect: Mutex<Option<PhysicalRectOwned>>,
    /// Shift+F3 隐藏全部贴图后，记住原来的可见性
    pub pins_hidden: Mutex<bool>,
    /// 最近关闭的贴图，F3 在无剪贴板图时复活（Snipaste 默认容量 1）
    pub recently_closed: Mutex<VecDeque<Sel>>,
    /// 处于鼠标穿透状态的贴图 sel 集合。tauri 只有 set_ignore_cursor_events 的
    /// **setter、没有 getter**，所以穿透态必须由宿主自己记，否则无法切换与兜底恢复。
    pub pin_through: Mutex<std::collections::HashSet<u64>>,
    /// 最近一次快捷键注册失败的记录（含被别的程序占用的情况，比如 Snipaste 占着 F1）。
    /// 只写日志的话，用户只会觉得「按了没反应」，所以要留一个前端可见的出口。
    pub hotkey_errors: Mutex<Vec<HotkeyFailure>>,
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
            bindings: Mutex::new(Vec::new()),
            last_rect: Mutex::new(None),
            pins_hidden: Mutex::new(false),
            recently_closed: Mutex::new(VecDeque::new()),
            pin_through: Mutex::new(std::collections::HashSet::new()),
            hotkey_errors: Mutex::new(Vec::new()),
        }
    }

    /// 记住一个被关掉的贴图（容量 1，对齐 Snipaste 默认 max_recoverable_closed_images）
    pub fn push_closed_sel(&self, sel: Sel) {
        let mut g = self.recently_closed.lock().unwrap();
        while g.len() >= 1 {
            g.pop_front();
        }
        g.push_back(sel);
    }

    pub fn take_closed_sel(&self) -> Option<Sel> {
        self.recently_closed.lock().unwrap().pop_back()
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

    #[allow(dead_code)] // 预留：当前无调用方（原为 M8 重编辑器留的口子）
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
