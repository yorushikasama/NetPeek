// 托盘右键菜单的深浅跟随（§37）。
//
// 用户报的：「右键的弹框不要 windows 默认的，需要同步当前主题」。查证结论：
// - Tauri 2.11.5 的 `TrayIcon` 没有任何主题 API（§34.7 查过一次，这次复核仍然如此）；
// - muda 的 `set_theme_for_hwnd` 只作用于**窗口菜单栏**，文档原文写着
//   "the theme only affects the menu bar itself and not submenus or context menu"，
//   而且它的 Windows 实现里根本没调用过 `SetPreferredAppMode`；
// - 所以唯一通路是 uxtheme 的那个进程级开关，由 `netpeek-uxtheme` 那个 shim 包着。
//
// 它能做到什么、做不到什么：菜单还是系统画的，跟着**深浅**变（深灰 / 浅灰），
// 但琥珀色、玻璃漆、底图这些皮肤信息进不去。要完全跟皮肤只能自绘一个菜单窗口
// （§37 里评估过：定位、点击外关闭、键盘、无障碍都要自建，而托盘菜单是唯一的
// 退出入口，风险不对等）。

use std::sync::atomic::{AtomicU8, Ordering};

use netpeek_uxtheme::AppMode;

/// 前端上报的有效深浅。`UNSET` 表示前端还没说过话 —— 此时**不干预**，
/// 让菜单保持系统默认行为（那反而是不撒谎的答案）。
///
/// 为什么不自己读系统设置：皮肤能把深浅方向钉死（跟系统设置无关），
/// 有效深浅只有皮肤引擎知道 —— 它同时写着 `color-scheme`，两边是同一个判断。
/// 前端在每次主题生效时上报，所以这里只有「等前端说」这一条路。
static REPORTED: AtomicU8 = AtomicU8::new(UNSET);

const UNSET: u8 = 0;
const DARK: u8 = 1;
const LIGHT: u8 = 2;

fn byte_of(dark: bool) -> u8 {
    if dark {
        DARK
    } else {
        LIGHT
    }
}

fn mode_of(dark: bool) -> AppMode {
    if dark {
        AppMode::Dark
    } else {
        AppMode::Light
    }
}

/// 去重决策：这次上报要不要真的去动系统设置。
///
/// 纯函数，单测直接钉住。存在的理由很具体：主题屏里拖动「界面不透明度」滑杆会让
/// `applyTokens` 每帧跑一次，也就是每帧调一次 `set_tray_theme` —— 每次都去冲一遍
/// 菜单主题缓存是白扔的。（前端也做了同一层去重，这里是不信任调用方的第二层。）
fn next_reported(current: u8, dark: bool) -> Option<u8> {
    let want = byte_of(dark);
    if current == want {
        None
    } else {
        Some(want)
    }
}

/// 前端上报有效深浅（每次主题生效都会调一次）。返回这次有没有真的写进系统。
///
/// 这里是**进程级**设置：改完之后本进程所有原生弹出菜单都跟着变，
/// 包括文件对话框等系统控件 —— 它们本来就该跟应用主题一致，不是副作用。
pub fn apply(dark: bool) -> bool {
    let Some(want) = next_reported(REPORTED.load(Ordering::SeqCst), dark) else {
        return false;
    };
    let wrote = netpeek_uxtheme::set_app_mode(mode_of(dark));
    // 记的是「应用当前的深浅」，不是「系统真的改了没」：uxtheme 取不到时
    // （Windows 10 1809 之前）反复上报同一个值也没意义，不该反复走 FFI。
    REPORTED.store(want, Ordering::SeqCst);
    wrote
}

/// 菜单弹出前重写一次。返回这次有没有真的写进系统。
///
/// **为什么要有这一步**：`TrackPopupMenu` 用的是**弹出那一刻**的系统状态，
/// 而正常写入发生在主题变化时（可能几分钟前）。微软 PowerToys 给 ZoomIt 做同一件事
/// 时也是每次弹菜单前重写一次，那是唯一在生产里被验证过的做法。
///
/// **调用位置**：托盘事件回调里，右键那一支。tray-icon 的 Windows 实现是
/// 先 `TrayIconEvent::send(event)`、后 `show_tray_menu()`（→ `TrackPopupMenu`），
/// 所以这是我们唯一能「赶在菜单前面」的位置。
///
/// **只能调裸 FFI**：托盘回调跑在主线程，任何走 `run_on_main_thread` 的 tauri 调用
/// （`set_text` / `is_visible` 那一类）都会自锁把界面冻死（§34.4）。
/// 这里两次 FFI 调用不碰 tauri，是安全的。
pub fn reassert() -> bool {
    let current = REPORTED.load(Ordering::SeqCst);
    if current == UNSET {
        return false;
    }
    netpeek_uxtheme::reassert_app_mode(if current == DARK {
        AppMode::Dark
    } else {
        AppMode::Light
    })
}

/// 前端在每次主题生效时上报有效深浅。
#[tauri::command]
pub fn set_tray_theme(dark: bool) {
    apply(dark);
}

#[cfg(test)]
mod tests {
    use super::{byte_of, next_reported, DARK, LIGHT, UNSET};

    /// 深浅必须映射到三个互不相同的字节，且 `UNSET` 不被任何一次上报占用 ——
    /// 撞了就会把「前端还没上报」误判成「已经是深色」，菜单在开机后会一直停在
    /// 上一次的深浅上（而这个 bug 只在托盘菜单里看得见，界面上完全正常）。
    #[test]
    fn reported_bytes_are_distinct() {
        assert_eq!(UNSET, 0, "UNSET 必须是 0，它是 AtomicU8 的初始值");
        assert_ne!(byte_of(true), byte_of(false));
        assert_ne!(byte_of(true), UNSET);
        assert_ne!(byte_of(false), UNSET);
        assert_eq!(byte_of(true), DARK);
        assert_eq!(byte_of(false), LIGHT);
    }

    /// 第一次上报永远要落笔（`current == UNSET` 与两个有效值都不相等）。
    #[test]
    fn first_report_always_applies() {
        assert_eq!(next_reported(UNSET, true), Some(DARK));
        assert_eq!(next_reported(UNSET, false), Some(LIGHT));
    }

    /// 重复上报同一个值必须被吃掉：拖滑杆时 `applyTokens` 每帧都会调到这里。
    #[test]
    fn repeated_report_is_deduped() {
        assert_eq!(next_reported(DARK, true), None);
        assert_eq!(next_reported(LIGHT, false), None);
        // 反向必须穿透
        assert_eq!(next_reported(DARK, false), Some(LIGHT));
        assert_eq!(next_reported(LIGHT, true), Some(DARK));
    }
}
