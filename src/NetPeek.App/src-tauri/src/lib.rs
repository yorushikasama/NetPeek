// NetPeek UI 入口。
// - 后台线程接入命名管道客户端，把采集服务推来的 TrafficSnapshot 经 Tauri event 转发给前端。
// - 系统托盘：左键唤出主窗，右键菜单含「打开主界面 / 退出」；关闭主窗时隐藏到托盘常驻。

mod geo;
mod history;
mod mini;
mod pipe;
mod settings;
mod theme;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent, Wry,
};

/// 托盘「暂停监控」菜单项的共享状态。文案跟随采集服务的真实暂停状态（快照
/// `Status` 字段），而不是只由托盘菜单自己记忆 —— 迷你窗、设置界面的暂停入口
/// 都走同一条控制管道，快照回来时在这里收敛，任何入口改状态托盘都跟得上。
pub struct TrayPause {
    paused: AtomicBool,
    item: Mutex<Option<MenuItem<Wry>>>,
}

/// 同步托盘暂停文案。快照每秒一帧，状态没翻转时是纯原子读，零开销。
pub fn sync_tray_pause(app: &tauri::AppHandle, paused: bool) {
    let state = app.state::<TrayPause>();
    if state.paused.swap(paused, Ordering::SeqCst) != paused {
        if let Some(item) = state.item.lock().unwrap().as_ref() {
            let _ = item.set_text(if paused {
                "恢复监控"
            } else {
                "暂停监控"
            });
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
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
            settings::collector_log_path,
            settings::open_collector_log,
            settings::country_db_info,
            settings::set_country_db,
            settings::pick_country_db,
            history::history_daily,
            history::history_range,
            history::history_stats,
            history::clear_history,
            history::set_retention,
            mini::toggle_mini,
            mini::place_mini_default,
            mini::set_mini_shape,
            mini::send_control_command,
            mini::show_main_window,
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

            // 托盘暂停状态先于 pipe 线程注册：pipe.rs 每帧快照都会来同步。
            app.manage(TrayPause {
                paused: AtomicBool::new(false),
                item: Mutex::new(None),
            });
            // 网速提醒的冷却状态（pipe.rs 每帧按设置判断是否弹系统通知）。
            app.manage(pipe::AlertState::default());
            pipe::spawn(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let mini = MenuItem::with_id(app, "mini", "打开迷你窗", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停监控", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &mini, &pause, &quit])?;

            // 菜单项交给共享状态，pipe.rs 的快照同步才能改到文案。
            *app.state::<TrayPause>().item.lock().unwrap() = Some(pause);

            // 任务栏/Alt-Tab 图标：tauri-codegen 生成 default_window_icon 时只取
            // icon.ico 的**第一个** entry（见 tauri-codegen 的 `CachedIcon::new_ico`），
            // 我们的 ico 按 16→256 升序排列，于是窗口图标一直是那张 16×16，
            // 再被 Windows 拉伸到 32/48/64 显示，糊得很明显（托盘不糊是因为它
            // 单独喂了 icon-32.png）。这里按实际缩放比挑对应的原生层重设一次。
            if let Some(window) = app.get_webview_window("main") {
                let px = window.scale_factor().unwrap_or(1.0) * 32.0;
                let bytes: &[u8] = if px > 48.5 {
                    include_bytes!("../icons/icon-64.png")
                } else if px > 32.5 {
                    include_bytes!("../icons/icon-48.png")
                } else {
                    include_bytes!("../icons/icon-32.png")
                };
                window.set_icon(tauri::image::Image::from_bytes(bytes)?)?;
            }

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
                        // 乐观翻转 + 立即发命令；采集服务不在线时快照不来，
                        // 文案保持乐观值（服务恢复后第一帧快照会再校正）。
                        let state = app.state::<TrayPause>();
                        let new_paused = !state.paused.load(Ordering::SeqCst);
                        drop(state);
                        // 失败（服务未运行 / 管道不可用）时保持乐观文案，下一帧快照会校正。
                        let _ = pipe::send_control(if new_paused { "pause" } else { "resume" });
                        sync_tray_pause(app, new_paused);
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
