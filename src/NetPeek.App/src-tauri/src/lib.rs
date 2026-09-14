// NetPeek UI 入口。
// - 后台线程接入命名管道客户端，把采集服务推来的 TrafficSnapshot 经 Tauri event 转发给前端。
// - 系统托盘：左键唤出主窗，右键菜单含「打开主界面 / 退出」；关闭主窗时隐藏到托盘常驻。

mod geo;
mod history;
mod mini;
mod pipe;
mod settings;
mod theme;
mod tray_theme;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent, Wry,
};

/// 托盘图标 id。同步线程要靠它取回句柄改 tooltip（`tray_by_id`）。
const TRAY_ID: &str = "netpeek-tray";

/// 广播窗口可见性变化给前端。
///
/// 不能只依赖 document.hidden：WebView2 在宿主窗口隐藏时是否触发 visibilitychange
/// 取决于运行时行为，押注它会漏掉「隐藏到托盘停止重绘」这条硬性验收项（§4.1/§11）。
/// 所有 show/hide 路径都显式调用这里，前端以该事件为准确信号。
pub(crate) fn notify_visibility(app: &tauri::AppHandle, label: &str, visible: bool) {
    let _ = app.emit(
        "win-visibility",
        serde_json::json!({ "label": label, "visible": visible }),
    );
}

/// 托盘的状态镜像。
///
/// 菜单文案要说真话：窗口开着就该显示「隐藏主界面」，迷你窗开着就该显示
/// 「关闭迷你窗」，采集服务停了「暂停监控」就该置灰。这些状态的来源有四个
/// （托盘自己、迷你窗按钮、设置页、前端直接调 `win.hide()`），逐个入口挂钩子
/// 必然漏，所以这里只存「真实状态 + 菜单项句柄」，由 [`spawn_tray_sync`] 的
/// 后台线程按固定周期比对后统一落笔。任何入口改状态，最多 300ms 后菜单就一致。
pub struct TrayState {
    /// 三个会随状态改文案的菜单项句柄（`MenuItem` 内部是 `Arc`，clone 廉价）。
    items: Mutex<Option<TrayItems>>,
    /// 采集服务的暂停状态，由 pipe 每帧按快照 `Status` 字段写入。
    paused: AtomicBool,
    /// 采集管道会话是否存续。UI 起来但采集服务没装/没启动时它是 false，
    /// 此时「暂停监控」置灰 —— 点了也不会有任何效果，不该让菜单假装能点。
    online: AtomicBool,
    /// 上一次写进菜单的那组状态，用来做「变了才写」的去重。
    applied: Mutex<AppliedTrayState>,
}

#[derive(Clone)]
struct TrayItems {
    main: MenuItem<Wry>,
    mini: MenuItem<Wry>,
    pause: MenuItem<Wry>,
}

/// 菜单上当前生效的状态组合。任何一项变了才落笔，全等则整轮跳过。
#[derive(Clone, Copy, PartialEq, Eq)]
struct AppliedTrayState {
    main_visible: bool,
    mini_visible: bool,
    paused: bool,
    online: bool,
    /// 首次同步前为 false —— 否则初始值恰好等于真实状态时菜单永远是建菜单时
    /// 写死的那份文案（「暂停监控」永远是「暂停监控」）。
    initialized: bool,
}

impl AppliedTrayState {
    fn uninitialized() -> Self {
        Self {
            main_visible: false,
            mini_visible: false,
            paused: false,
            online: false,
            initialized: false,
        }
    }
}

/// 记录采集服务的暂停状态（pipe.rs 每帧快照调用）。只写原子量，不碰菜单 ——
/// 落笔统一交给同步线程，避免两个线程各自改菜单。
pub fn set_collector_paused(app: &tauri::AppHandle, paused: bool) {
    app.state::<TrayState>()
        .paused
        .store(paused, Ordering::SeqCst);
}

/// 记录采集管道会话是否在线（pipe.rs 连接成功 / 断开时调用）。
pub fn set_collector_online(app: &tauri::AppHandle, online: bool) {
    app.state::<TrayState>()
        .online
        .store(online, Ordering::SeqCst);
}

/// 托盘同步线程：固定周期把真实状态刷进菜单。
///
/// **为什么是轮询而不是事件驱动**：窗口可见性的变更点散在四处（托盘菜单、
/// 迷你窗按钮、主窗关闭事件、前端 `win.hide()`），事件驱动要给每个入口加调用，
/// 漏一个就是「菜单显示的状态和实际对不上」——正是这个模块要根治的毛病。
/// 轮询把「漏路径」这件事从设计上消掉，代价是每 300ms 两次 `is_visible()`
/// 查询（跨线程消息，微秒级），以及一个整型的比较。
fn spawn_tray_sync(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        sync_tray(&app);
    });
}

/// 把真实状态落笔到托盘菜单。**只能在非主线程调用。**
///
/// `MenuItem::set_text`、`MenuItem::set_enabled`、`TrayIcon::set_tooltip`、
/// `WebviewWindow::is_visible` 在 tauri 里都走 `run_on_main_thread` 派发后
/// `recv()` 阻塞等回执。从主线程调用的话，事件循环正忙于执行调用方本身，
/// 回执永远不会来 —— 直接自锁，界面冻死。同步线程、pipe 线程都是安全的。
fn sync_tray(app: &tauri::AppHandle) {
    let state = app.state::<TrayState>();
    let Some(items) = state.items.lock().unwrap().clone() else {
        return; // 菜单项还没注册（setup 早期）
    };

    let main_visible = main_shown(app);
    let mini_visible = window_visible(app, "mini");
    let online = state.online.load(Ordering::SeqCst);
    // 采集服务不在线时一律按「未暂停」呈现：服务重启后从「未暂停」起步，
    // 且离线时那次乐观翻转不会再有快照来校正 —— 菜单不该留着上一轮的
    // 「恢复监控」骗人。这一行也顺带接管了原来「断开时复位」的职责，
    // 且不受 `read_session` 因打开管道失败而提前返回的影响。
    let paused = tray_paused(online, state.paused.load(Ordering::SeqCst));

    let next = AppliedTrayState {
        main_visible,
        mini_visible,
        paused,
        online,
        initialized: true,
    };
    {
        let mut applied = state.applied.lock().unwrap();
        if *applied == next {
            return;
        }
        *applied = next;
    }

    let _ = items.main.set_text(main_item_text(main_visible));
    let _ = items.mini.set_text(mini_item_text(mini_visible));
    let _ = items.pause.set_text(pause_item_text(paused));
    // 离线时置灰：能看出来点不动，比点了没反应强。
    let _ = items.pause.set_enabled(online);

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip_text(online, paused)));
    }
}

/// 菜单项的文案映射都抽成纯函数：它们是「菜单说不说实话」这件事的全部内容，
/// 单测钉住比在真机上肉眼比对菜单可靠得多。
fn main_item_text(visible: bool) -> &'static str {
    if visible {
        "隐藏主界面"
    } else {
        "打开主界面"
    }
}

fn mini_item_text(visible: bool) -> &'static str {
    if visible {
        "关闭迷你窗"
    } else {
        "打开迷你窗"
    }
}

fn pause_item_text(paused: bool) -> &'static str {
    if paused {
        "恢复监控"
    } else {
        "暂停监控"
    }
}

/// 托盘上「暂停」这一维的可见值。离线优先于暂停：服务都没在跑，菜单挂一个
/// 「恢复监控」既点不动也没意义 —— 而且那种状态下没有快照来纠正它。
fn tray_paused(online: bool, stored: bool) -> bool {
    online && stored
}

fn window_visible(app: &tauri::AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// 主窗是否处于「用户看得见、且没被收起」的状态。
///
/// 比 `is_visible()` 多排掉最小化：窗口最小化时 `IsWindowVisible` 仍为真，但那时
/// 菜单该写「打开主界面」——点它会把窗口还原（`show_main` 里有 `unminimize`），
/// 而不是把任务栏上那个图标也一起抹掉。判定和 [`toggle_main`] 必须同源，
/// 否则会出现「文案说隐藏、点下去却在显示」。
fn main_shown(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

/// 托盘 tooltip。窗口没开时它是用户唯一能看到的托盘文案，所以要把
/// 「在不在监控」写清楚 —— 原来恒为「NetPeek」，离线时和正常时长得一样。
fn tooltip_text(online: bool, paused: bool) -> String {
    if !online {
        "NetPeek · 采集服务未连接".to_string()
    } else if paused {
        "NetPeek · 已暂停监控".to_string()
    } else {
        "NetPeek".to_string()
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // 单实例守卫必须**第一个**注册。
    //
    // 为什么这件事非做不可：Windows 上不注册它，每次运行都是一个独立进程，
    // 而主窗的关闭只是 hide 到托盘（见下面的 on_window_event），进程不退。
    // 于是「再点一次图标 / 再跑一次 npm run dev」不会唤出原来那个窗口，
    // 而是长出第二个窗口、第二个托盘图标、第二份采集管道连接 —— 用户看到的就是
    // 「怎么开了两个窗口」。实测一次 dev 会话里同时存活过 3 个 netpeek-app.exe。
    //
    // 顺序有讲究：它拦的正是「第二个进程启动」这件事。排在后面的插件在那个进程里
    // 会先跑一遍自己的 init（通知、对话框、托盘），白做一遍还可能与旧实例抢资源。
    //
    // 回调在**已存在的那个实例**里执行：把它的主窗唤出来（隐藏/最小化都收拢到
    // show_main），然后由插件负责让第二个进程退出。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        show_main(app);
    }));

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            theme::load_theme_config,
            theme::save_theme_config,
            theme::save_background_image,
            theme::read_background_image,
            tray_theme::set_tray_theme,
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
            history::history_range_days,
            history::history_process_totals,
            history::history_stats,
            history::clear_history,
            history::set_retention,
            mini::toggle_mini,
            mini::place_mini_default,
            mini::set_mini_shape,
            mini::send_control_command,
            mini::show_main_window,
            pipe::frontend_ready,
        ])
        .setup(|app| {
            let setup_start = std::time::Instant::now();

            // 历史库初始化挪出关键路径：setup 阻塞着窗口与 WebView 的创建，
            // 开库 + 过期清理不该让用户等。占位内存库先顶住，真实库就绪后热替换。
            let history_state = history::HistoryState::new();
            app.manage(history_state.clone());
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let t = std::time::Instant::now();
                    if let Err(e) = history::init(&app_handle, &history_state) {
                        history::log_error(&history_state, &format!("初始化历史数据库失败：{e}"));
                    }
                    eprintln!("[netpeek] history init {}ms", t.elapsed().as_millis());
                    history::spawn(history_state);
                });
            }

            // 兜底：前端 8 秒内没把窗口显示出来（脚本崩溃等极端情况），
            // 强制显示，避免「托盘有图标、桌面无窗口」的死局。
            {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(8));
                    if let Some(w) = app_handle.get_webview_window("main") {
                        if !w.is_visible().unwrap_or(true) {
                            let _ = w.show();
                        }
                    }
                });
            }

            // 设置加载失败回退默认值，不让启动崩溃。
            let settings_state = settings::init(app.handle()).unwrap_or_else(|e| {
                eprintln!("初始化设置失败，使用默认设置：{e}");
                settings::SettingsState::default()
            });
            app.manage(settings_state);

            // 托盘状态镜像先于 pipe 线程注册：pipe.rs 每帧快照都会来写暂停状态。
            app.manage(TrayState {
                items: Mutex::new(None),
                paused: AtomicBool::new(false),
                online: AtomicBool::new(false),
                applied: Mutex::new(AppliedTrayState::uninitialized()),
            });
            // 网速提醒的冷却状态（pipe.rs 每帧按设置判断是否弹系统通知）。
            app.manage(pipe::AlertState::default());
            // 反向握手：就绪信号必须先注册，管道线程才等得到（见 pipe.rs FrontendReady）。
            // 顺序不能倒：setup 阻塞着事件循环，前端最早也要等 setup 返回才可能
            // 调 frontend_ready，这里先 manage 就是保证 state 一定存在。
            app.manage(pipe::FrontendReady::default());
            pipe::spawn(app.handle().clone());

            // 菜单项的初始文案是「打开主界面 / 打开迷你窗 / 暂停监控」——按
            // 「两个窗口都还没显示、采集未连接」这一初始状态写。真实文案由同步
            // 线程在 300ms 内按实际状态纠正（主窗此时确实还没 show）。
            let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
            let mini = MenuItem::with_id(app, "mini", "打开迷你窗", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", "暂停监控", false, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &mini, &pause, &quit])?;

            // 菜单项交给共享状态，后台同步线程才改得到文案。
            *app.state::<TrayState>().items.lock().unwrap() = Some(TrayItems {
                main: show.clone(),
                mini: mini.clone(),
                pause: pause.clone(),
            });

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

            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(icon)
                .tooltip(tooltip_text(false, false))
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    // 按真实可见性切换，而不是无条件唤出：文案已经写着「隐藏主界面」，
                    // 点下去却只把窗口再聚焦一次，用户会认为这一项坏了。
                    "show" => toggle_main(app),
                    "mini" => {
                        let _ = mini::toggle_mini((*app).clone());
                    }
                    "pause" => {
                        // 离线时这一项是置灰的，正常点不到。
                        let new_paused = !app.state::<TrayState>().paused.load(Ordering::SeqCst);
                        let cmd = if new_paused { "pause" } else { "resume" };
                        // 命令真的送出去了才认这次翻转。送不出去（服务刚退出、
                        // 管道不可用）就什么都不做 —— 文案保持与真实状态一致，
                        // 而不是留一个等不到下一帧快照来校正的假状态。
                        if pipe::send_control(cmd).is_ok() {
                            app.state::<TrayState>()
                                .paused
                                .store(new_paused, Ordering::SeqCst);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        match button {
                            // 左键固定是「唤出并聚焦」：它是托盘的通用手势，不跟菜单文案
                            // 走的切换语义挂钩，否则用户想找窗口时反而把它藏了。
                            MouseButton::Left => show_main(tray.app_handle()),
                            // 右键：这一下之后 tray-icon 才会弹菜单（它的 Windows 实现是
                            // 先 TrayIconEvent::send、后 show_tray_menu → TrackPopupMenu），
                            // 所以这里是唯一能赶在菜单之前把深浅写进系统的位置（§37）。
                            // 注意这一支里只能碰裸 FFI：托盘回调在主线程，
                            // 任何走 run_on_main_thread 的 tauri 调用都会自锁（§34.4）。
                            MouseButton::Right => {
                                tray_theme::reassert();
                            }
                            _ => {}
                        }
                    }
                })
                .build(app)?;

            // 保持托盘图标存活（否则 setup 结束后会被释放）。
            app.manage(tray);

            // 菜单文案/可用性/tooltip 的后台同步（窗口可见性、采集连接、暂停）。
            spawn_tray_sync(app.handle().clone());

            eprintln!("[netpeek] setup {}ms", setup_start.elapsed().as_millis());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 关闭主窗改为隐藏到托盘，程序继续运行。
                window.hide().unwrap();
                notify_visibility(window.app_handle(), window.label(), false);
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
        notify_visibility(app, "main", true);
    }
}

/// 按真实可见性切换主窗（托盘菜单「打开主界面 / 隐藏主界面」）。
/// 隐藏路径要和主窗关闭按钮一致：`hide()` + 广播 `win-visibility`，
/// 否则前端不知道窗口已不可见、图表还在按帧重绘（§4.1 的硬性验收项）。
fn toggle_main(app: &tauri::AppHandle) {
    if main_shown(app) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
            notify_visibility(app, "main", false);
        }
    } else {
        // 最小化或已隐藏，两种都由 show_main 收拢（它带 unminimize）。
        show_main(app);
    }
}

#[cfg(test)]
mod tests {
    use super::{main_item_text, mini_item_text, pause_item_text, tooltip_text, tray_paused};

    /// 三个文案都必须是「一个状态一个词」，不能两边写成同一句 ——
    /// 那正是用户报的「托盘状态没跟实际同步」的样子。
    #[test]
    fn item_texts_flip_with_state() {
        assert_eq!(main_item_text(false), "打开主界面");
        assert_eq!(main_item_text(true), "隐藏主界面");
        assert_eq!(mini_item_text(false), "打开迷你窗");
        assert_eq!(mini_item_text(true), "关闭迷你窗");
        assert_eq!(pause_item_text(false), "暂停监控");
        assert_eq!(pause_item_text(true), "恢复监控");
    }

    /// 离线优先于暂停：服务没在跑时，哪怕上一次记下的状态是「已暂停」，
    /// 托盘也必须按未暂停呈现 —— 那种状态下没有快照会来纠正它。
    #[test]
    fn tray_paused_is_offline_first() {
        assert!(tray_paused(true, true));
        assert!(!tray_paused(true, false));
        assert!(!tray_paused(false, true), "离线时不该保留「恢复监控」");
        assert!(!tray_paused(false, false));
    }

    /// tooltip 三态互不相同。撞在一起就等于「离线」和「正常」在托盘上长得一样，
    /// 而窗口关到托盘时它是唯一的状态出口。
    #[test]
    fn tooltip_distinguishes_three_states() {
        let normal = tooltip_text(true, false);
        let paused = tooltip_text(true, true);
        let offline = tooltip_text(false, false);

        assert_ne!(normal, paused);
        assert_ne!(normal, offline);
        assert_ne!(paused, offline);
        assert!(offline.contains("未连接"));
        assert!(paused.contains("已暂停"));
        // 离线压过暂停：服务没跑就不该说「已暂停监控」
        assert_eq!(tooltip_text(false, true), offline);
    }
}
