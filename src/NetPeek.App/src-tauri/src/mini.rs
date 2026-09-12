// NetPeek 小窗（屏 2，§2.9）：能量球 ⇄ 迷你窗 双形态，共用 label="mini" 的同一个窗口。
// - 能量球形态：窗口 108×108（球 92，四周 8px 留给外发光，窗口再小发光就被边缘裁掉），
//   环形规显示下载/上传相对近 60 秒峰值的水位，点击展开为迷你窗。
// - 迷你窗形态：320×300 面板，Top 5 应用 + 总速率 + 暂停/主界面。
//   「退出」在托盘右键菜单，不在这里。
// - 页面 mini.html 独立文件（与主界面同 frontendDist，互不依赖）；
//   数据来自主进程广播的 snapshot 事件（app.emit 会广播到所有窗口）。
// - 初始落位 = 屏幕工作区右下角：由前端读 WebView 的 screen 对象（avail* 就是工作区）
//   调 place_mini_default 设一次；之后位置完全交给用户拖动，托盘反复开关不会拽回来。
// - 形态切换 = 前端调 set_mini_shape：Rust 侧按「离屏幕最近的边」锚定并夹在屏幕内，再改尺寸。

use serde::Deserialize;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager};

const ORB_W: f64 = 108.0;
const ORB_H: f64 = 108.0;
/// 面板窗口比面板本身四周各多 12px —— 那是留给 panel 外发光与投影的地方。
/// 原来窗口 = 面板 = 320×300（panel 用 inset:0），box-shadow 全落在窗口外被裁掉，
/// 圆角外的四个角反而被自己的投影填上色，看起来像「面板外面又套了一层边框」。
/// 面板内容尺寸不变（344-24 × 324-24 = 320×300），四段布局的定高一个都没动。
const PANEL_PAD: f64 = 12.0;
const PANEL_W: f64 = 320.0 + PANEL_PAD * 2.0;
const PANEL_H: f64 = 300.0 + PANEL_PAD * 2.0;

/// 球默认落位时距工作区左、下边缘的距离（逻辑 px）。
/// 与 set_mini_shape 里那个 8px 是两回事：8 是「别掉出屏幕」的兜底边距，
/// 这个是设计位置，球要离屏幕角有明显的一段距离才读得出是独立浮着的控件。
const ORB_MARGIN: f64 = 24.0;

/// 屏幕**工作区**（排除任务栏后的可用区域），单位与 CSS px 一致，由前端提供。
/// 右边缘 = x + width，下边缘 = y + height，两者一凑就是右下角。
/// tao 的 Monitor 只有整屏尺寸、没有 work area；正确取 work area 要走 Win32
/// （`GetMonitorInfoW` 的 rcWork 或 `SPI_GETWORKAREA`），而本 crate 的工程约束是
/// `unsafe_code = "forbid"`，跨不过去。WebView 的 screen.availLeft/availTop/
/// availWidth/availHeight 天生就是工作区，是唯一既准确又不过线的来源，
/// 前端零成本就能读到。
#[derive(Deserialize)]
pub struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 初始落位：工作区右下角。由 mini.js 在页面加载时调一次 —— 那时窗口还没显示
/// （配置里 visible: false），落位对用户是不可见的，不会有「先闪一下中间再跳走」。
/// 只在页面加载时调，所以拖动后的位置在托盘反复开关之间保持不变。
#[tauri::command]
pub fn place_mini_default(app: AppHandle, area: WorkArea) -> Result<(), String> {
    let Some(w) = app.get_webview_window("mini") else {
        return Ok(());
    };
    // 纵坐标用 ORB_H 常量而不是 w.outer_size()：调用发生在窗口显示之前，
    // 那一刻的 outer_size 可能还带着 tao 的尺寸校正没落定（见下），常量才是确定的。
    let x = area.x + area.width - ORB_MARGIN - ORB_W;
    let y = area.y + area.height - ORB_MARGIN - ORB_H;

    // 顺带把尺寸落定。tao 创建这种未装饰窗口时会把宽度多算一段 —— 实测窗口逻辑宽
    // 135 而配置写的是 108（高度 108 是对的），要显式 set_size 一次才收得回来。
    // 不收的后果有两个：球在超宽窗口里居中，实际离屏幕右边缘比 24px 近得多；
    // 而且直到第一次显示、mini-shown 触发重新对齐时才被纠正，那一瞬间球会横跳 13px。
    let _ = w.set_size(LogicalSize::new(ORB_W, ORB_H));
    w.set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// 显示/隐藏小窗（托盘「打开迷你窗」）。
#[tauri::command]
pub fn toggle_mini(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("mini") {
        if w.is_visible().unwrap_or(false) {
            w.hide().map_err(|e| e.to_string())?;
        } else {
            w.show().map_err(|e| e.to_string())?;
            // 首次显示时窗口尺寸会被 tao 的阴影 inset 撑大（实测逻辑宽 135 而非 108，
            // 切一次形态后才会被 set_mini_shape 纠正）。这里主动通知前端按当前形态
            // 重新对齐一次，免得第一次打开时球偏在一边。
            let _ = app.emit_to("mini", "mini-shown", ());
        }
    }
    Ok(())
}

/// 切换小窗形态：按**离屏幕最近的边**锚定换尺寸，再夹取到当前显示器内。
/// shape: "orb" | "panel"
///
/// 为什么不是「保持中心」：球默认停在右下角，保持中心会把 344 宽的面板向右推
/// 118px、随即被屏幕右边缘 clamp 回来 —— 展开的一瞬间球横跳 110px、上跳 108px。
/// 锚定离屏幕边缘最近的那两条边之后，球在右下角展开时右、下边缘都不动，
/// 面板朝左上方长出来，球待在原地；拖到左上角则朝右下长，同样不跳。
/// 窗口完整在屏内且尺寸不变时（托盘显示后 mini-shown 触发的重新对齐、
/// 以及「收起 → 展开 → 收起」的往返），这个算法算出的位置与当前位置完全相同，
/// 是个不动点，不会把用户的拖动位置一点点推走。
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

    // 当前窗口几何（均为物理坐标）
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let (px, py) = (pos.x as f64, pos.y as f64);
    let (sw, sh) = (size.width as f64, size.height as f64);

    // 没有显示器信息时退回「保持中心」（原来的行为），并完全跳过夹取。
    let mon = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());

    let mut nx = px + sw / 2.0 - tw * scale / 2.0;
    let mut ny = py + sh / 2.0 - th * scale / 2.0;

    if let Some(mon) = mon {
        let mb = mon.position();
        let ms = mon.size();
        let (mx, my) = (mb.x as f64, mb.y as f64);
        let (mw, mh) = (ms.width as f64, ms.height as f64);

        // 就近边锚定：窗口中心落在显示器哪一半，就固定那一侧的边
        nx = if px + sw / 2.0 <= mx + mw / 2.0 {
            px
        } else {
            px + sw - tw * scale
        };
        ny = if py + sh / 2.0 <= my + mh / 2.0 {
            py
        } else {
            py + sh - th * scale
        };

        let margin = 8.0 * scale;
        let min_x = mx + margin;
        let min_y = my + margin;
        let max_x = mx + mw - tw * scale - margin;
        let max_y = my + mh - th * scale - margin;
        // 目标窗口 + 边距可能大于显示器（极小屏/投影），此时 max < min，clamp 会 panic。
        // 退化为贴边（取 min），而不是崩溃。
        nx = if max_x > min_x {
            nx.clamp(min_x, max_x)
        } else {
            min_x
        };
        ny = if max_y > min_y {
            ny.clamp(min_y, max_y)
        } else {
            min_y
        };
    }

    let _ = w.set_position(LogicalPosition::new(nx / scale, ny / scale));
    w.set_size(LogicalSize::new(tw, th))
        .map_err(|e| e.to_string())
}

/// 发送采集控制命令（pause / resume / toggle），供迷你窗「暂停」按钮复用。
/// 失败原因（采集服务未运行、管道权限不匹配等）原样返回给前端 —— 这里曾经是
/// 「失败也返回 Ok」，前端拿不到任何信号，按钮点了没反应却查不出原因。
#[tauri::command]
pub fn send_control_command(command: String) -> Result<(), String> {
    crate::pipe::send_control(&command)
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
