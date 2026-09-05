// NetPeek UI 入口。
// - 后台线程接入命名管道客户端，把采集服务推来的 TrafficSnapshot 经 Tauri event 转发给前端。
// - 系统托盘：左键唤出主窗，右键菜单含「打开主界面 / 退出」；关闭主窗时隐藏到托盘常驻。

mod history;
mod mini;
mod pipe;
mod settings;
mod theme;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            theme::load_theme_config,
            theme::save_theme_config,
            theme::save_background_image,
            theme::read_background_image,
            settings::load_settings,
            settings::save_settings,
            settings::get_autostart,
            settings::set_autostart,
            settings::data_dir_path,
            history::query_history,
            history::history_daily,
            history::history_stats,
            history::clear_history,
            history::set_retention,
            mini::toggle_mini,
            mini::set_mini_shape,
            mini::send_control_command,
            mini::show_main_window,
            mini::quit_app,
        ])
        .setup(|app| {
            // 历史数据（SQLite 分钟聚合）与设置（settings.json + 注册表）。
            // 先 manage 状态再初始化，保证任何窗口前端尽早 invoke 也不会命中未注册状态。
            let history_state = history::HistoryState::new();
            app.manage(history_state.clone());
            // 历史库初始化失败不阻断启动：用占位内存库继续运行，历史仅不落盘。
            if let Err(e) = history::init(app.handle(), &history_state) {
                history::log_error(&history_state, &format!("初始化历史数据库失败：{e}"));
            }
            history::spawn(history_state);

            // 设置加载失败回退默认值，不让启动崩溃。
            let settings_state = settings::init(app.handle()).unwrap_or_else(|e| {
                eprintln!("初始化设置失败，使用默认设置：{e}");
                settings::SettingsState::default()
            });
            app.manage(settings_state);

            pipe::spawn(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let mini = MenuItem::with_id(app, "mini", "打开迷你窗", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停监控", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &mini, &pause, &quit])?;

            // 本地跟踪暂停状态以切换菜单文案；真实状态以采集服务快照为准（前端据此显示）。
            let paused = Arc::new(AtomicBool::new(false));
            let pause_item = pause.clone();
            let paused_flag = Arc::clone(&paused);

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon-32.png"))?;

            let tray = TrayIconBuilder::new()
                .icon(icon)
                .tooltip("NetPeek")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "mini" => {
                        let _ = mini::toggle_mini((*app).clone());
                    }
                    "pause" => {
                        let new_paused = !paused_flag.load(Ordering::SeqCst);
                        paused_flag.store(new_paused, Ordering::SeqCst);
                        pipe::send_control(if new_paused { "pause" } else { "resume" });
                        let _ = pause_item
                            .set_text(if new_paused { "继续监控" } else { "暂停监控" });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // 保持托盘图标存活（否则 setup 结束后会被释放）。
            app.manage(tray);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭主窗改为隐藏到托盘，程序继续运行。
                window.hide().unwrap();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running NetPeek UI");
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
