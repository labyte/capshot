//! capshot 宿主：Tauri v2 装配（托盘/全局热键/单实例/日志/命令面）。
//! macOS 以 Accessory 策略运行（LSUIElement，无 Dock 图标），Windows 走托盘常驻。

mod commands;
mod history;
mod settings;
mod state;
mod windows;

use state::AppState;
use tauri::{Builder, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app;
        }))
        .plugin(
            // release 默认目标已含 LogDir（AppData/logs），不要再显式追加，否则双写
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(
            // 单一 handler 按「哪把键触发」分派。比对的是解析后的 Shortcut，
            // 不是字符串 —— Display 形是大写规范名，与用户存的原始写法对不上。
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    commands::dispatch_shortcut(app, shortcut);
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let app_data = app.path().app_data_dir()?;
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir).ok();
            let settings_path = config_dir.join("settings.json");
            let settings = settings::Settings::load(&settings_path);
            let history_root = app_data.clone();
            let store = history::HistoryStore::open(history_root)
                .map_err(|e| format!("history open failed: {e}"))?;

            #[cfg(target_os = "macos")]
            let backend: Box<dyn capture_core::CaptureBackend> = Box::new(
                capture_macos::MacOsBackend::new().ok_or("macos backend unavailable")?,
            );
            #[cfg(windows)]
            let backend: Box<dyn capture_core::CaptureBackend> = Box::new(
                capture_windows::WindowsBackend::new().ok_or("windows backend unavailable")?,
            );

            app.manage(AppState::new(backend, settings, settings_path, store));
            // 四槽快捷键一次注册；失败不致命，设置页会显式报错
            if let Err(e) = commands::rebind_all(app.handle()) {
                log::error!("hotkey register failed (will surface in settings): {e}");
            }
            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::get_monitor_frame,
            commands::commit_selection,
            commands::capture_window_clean,
            commands::export_result,
            commands::get_selection_png,
            commands::cancel_capture,
            commands::pin_move,
            commands::pin_bounds,
            commands::pin_ready,
            commands::pin_ignore_cursor,
            commands::pin_set_through,
            commands::pin_set_top,
            commands::pin_from_clipboard,
            commands::toggle_pins_visible,
            commands::clear_through_pins,
            commands::close_all_pins,
            commands::open_editor_window,
            commands::history_edit,
            commands::history_copy,
            commands::history_pin,
            commands::list_history,
            commands::history_png,
            commands::history_delete,
            commands::history_open_folder,
            commands::permission_status,
            commands::permission_request,
            commands::permission_open_settings,
            commands::get_settings,
            commands::set_settings,
            commands::hotkey_status,
            commands::open_settings_window,
            commands::open_history_window,
            commands::open_about_window,
            commands::about_info,
        ])
        .build(tauri::generate_context!())
        .expect("capshot build failed")
        .run(|_app, event| {
            // 托盘常驻：最后一个窗口关闭会触发无 code 的 ExitRequested（runtime-wry 的
            // all-windows-destroyed 逻辑），必须拦截；托盘「退出」走 app.exit(0) 带 code，放行。
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                log::info!("run: ExitRequested code={code:?}");
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

use tauri::tray::TrayIconBuilder;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

/// 托盘悬停提示：软件名 + 换行的截图/贴图快捷键。
/// 改键后由 commands::set_settings 调 refresh_tray_tooltip 重算。
pub fn tray_tooltip(app: &tauri::AppHandle) -> String {
    let (snip, pin) = {
        let state = app.state::<AppState>();
        let s = state.settings.lock().unwrap();
        (s.hotkey.clone(), s.hotkey_pin.clone())
    };
    format!("CapsShot\n截图: {snip}\n贴图: {pin}")
}

/// 把当前 tooltip 推到托盘图标上（改键后刷新）
pub fn refresh_tray_tooltip(app: &tauri::AppHandle) {
    let tip = tray_tooltip(app);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tip));
    }
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, "capture", "截图", true, None::<&str>)?;
    let clip = MenuItem::with_id(app, "pin_clip", "贴图剪贴板", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "toggle_pins", "隐藏 / 显示全部贴图", true, None::<&str>)?;
    let clear_through =
        MenuItem::with_id(app, "clear_through", "解除所有贴图穿透", true, None::<&str>)?;
    let close_pins = MenuItem::with_id(app, "close_pins", "关闭所有贴图", true, None::<&str>)?;
    let history = MenuItem::with_id(app, "history", "历史…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 CapsShot", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &capture,
            &clip,
            &sep1,
            &hide,
            &clear_through,
            &close_pins,
            &sep2,
            &history,
            &settings,
            &sep3,
            &about,
            &sep4,
            &quit,
        ],
    )?;
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip(tray_tooltip(app))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "capture" => commands::trigger_capture(app),
            "pin_clip" => {
                if let Err(e) = commands::pin_from_clipboard(app.clone()) {
                    log::warn!("tray pin_from_clipboard: {e:?}");
                }
            }
            "toggle_pins" => {
                let _ = commands::toggle_pins_visible(app.clone());
            }
            "clear_through" => commands::clear_through_pins(app.clone()),
            "close_pins" => commands::close_all_pins(app.clone()),
            "history" => {
                let _ = commands::open_history_window(app.clone());
            }
            "settings" => {
                let _ = commands::open_settings_window(app.clone());
            }
            "about" => {
                let _ = commands::open_about_window(app.clone());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            // 按下与松开各发一次 Click —— 只认左键松开，否则一次点击触发两个会话
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                commands::trigger_capture(&tray.app_handle().clone());
            }
        })
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            tauri::image::Image::new(&[], 1, 1)
        }))
        .build(app)?;
    Ok(())
}
