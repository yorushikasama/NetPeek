// NetPeek 小窗（屏 2）：能量球 ⇄ 迷你窗 双形态，共用 label="mini" 的同一个窗口。
// - 能量球形态：100x100 圆形（transparent 窗口），显示总下载/上传速率，点击展开为迷你窗。
// - 迷你窗形态：320x300 矩形面板，Top 3 应用 + 总速率 + 暂停/主界面/退出。
// - 页面 mini.html 独立文件（与主界面同 frontendDist，互不依赖）；
//   数据来自主进程广播的 snapshot 事件（app.emit 会广播到所有窗口）。
// - 形态切换 = 前端调 set_mini_shape：Rust 侧保持窗口中心不动并夹在屏幕内，再改尺寸。

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager};

const ORB_W: f64 = 100.0;
const ORB_H: f64 = 100.0;
const PANEL_W: f64 = 320.0;
const PANEL_H: f64 = 300.0;

/// 显示/隐藏小窗（托盘「打开迷你窗」）。
#[tauri::command]
pub fn toggle_mini(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mini") {
        if w.is_visible().unwrap_or(false) {
            w.hide().map_err(|e| e.to_string())?;
        } else {
            w.show().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 切换小窗形态：保持窗口中心不变，按目标尺寸夹取到屏幕内后 setSize。
/// shape: "orb" | "panel"
#[tauri::command]
pub fn set_mini_shape(app: AppHandle, shape: String) -> Result<(), String> {
    let Some(w) = app.get_webview_window("mini") else {
        return Ok(());
    };
    let (tw, th) = if shape == "panel" {
        (PANEL_W, PANEL_H)
    } else {
        (ORB_W, ORB_H)
    };

    // 当前窗口中心（逻辑坐标）
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let cx = pos.x as f64 + size.width as f64 / 2.0;
    let cy = pos.y as f64 + size.height as f64 / 2.0;

    // 新左上角（保持中心），夹取到当前显示器内
    let mut nx = cx - tw * scale / 2.0;
    let mut ny = cy - th * scale / 2.0;
    if let Ok(Some(mon)) = w.current_monitor() {
        let mb = mon.position();
        let ms = mon.size();
        let margin = 8.0 * scale;
        let min_x = mb.x as f64 + margin;
        let min_y = mb.y as f64 + margin;
        let max_x = mb.x as f64 + ms.width as f64 - tw * scale - margin;
        let max_y = mb.y as f64 + ms.height as f64 - th * scale - margin;
        nx = nx.clamp(min_x, max_x);
        ny = ny.clamp(min_y, max_y);
    }

    let _ = w.set_position(LogicalPosition::new(nx / scale, ny / scale));
    w.set_size(LogicalSize::new(tw, th))
        .map_err(|e| e.to_string())
}

/// 发送采集控制命令（pause / resume / toggle），供迷你窗「暂停」按钮复用。
#[tauri::command]
pub fn send_control_command(command: String) -> Result<(), String> {
    crate::pipe::send_control(&command);
    Ok(())
}

/// 唤出主界面（迷你窗「主界面」按钮）。
#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    Ok(())
}

/// 退出程序（迷你窗「退出」按钮）。
#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}
