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
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    use tauri_plugin_global_shortcut::ShortcutState;
                    if event.state() == ShortcutState::Pressed {
                        commands::trigger_capture(app);
                    }
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

            let hotkey = settings.hotkey.clone();
            app.manage(AppState::new(backend, settings, settings_path, store));
            *app.state::<AppState>().current_shortcut.lock().unwrap() = Some(hotkey.clone());
            if let Err(e) = app.global_shortcut().register(hotkey.as_str()) {
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
            commands::pin_ignore_cursor,
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
            commands::open_settings_window,
            commands::open_history_window,
        ])
        .run(tauri::generate_context!())
        .expect("capshot run failed");
}

use tauri::tray::TrayIconBuilder;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let capture = MenuItem::with_id(app, "capture", "截图 (热键)", true, None::<&str>)?;
    let history = MenuItem::with_id(app, "history", "历史…", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 capshot", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&capture, &sep, &history, &settings, &sep, &quit])?;
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("capshot")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "capture" => commands::trigger_capture(app),
            "history" => {
                let _ = commands::open_history_window(app.clone());
            }
            "settings" => {
                let _ = commands::open_settings_window(app.clone());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::TrayIconEvent;
            if let TrayIconEvent::Click { .. } = event {
                commands::trigger_capture(&tray.app_handle().clone());
            }
        })
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            tauri::image::Image::new(&[], 1, 1)
        }))
        .build(app)?;
    Ok(())
}
