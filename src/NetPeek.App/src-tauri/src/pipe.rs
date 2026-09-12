// NetPeek 命名管道客户端：连接采集服务 \\.\pipe\NetPeekCollector，
// 按「4 字节小端长度 + UTF-8 JSON」帧格式读取，并把每帧快照通过 Tauri event 转发给前端。
//
// Windows 上 std::fs::File 可以直接打开命名管道路径（CreateFileW + OPEN_EXISTING），
// 因此无需引入 windows-sys。采集服务端（SnapshotPipeServer）用 PipeDirection.Out
// 创建管道并每秒推一帧；读到 EOF 即视为断开，稍后自动重连。

use std::fs::File;
use std::io::{Error, ErrorKind, Read};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::history;

const PIPE_PATH: &str = r"\\.\pipe\NetPeekCollector";
const CONTROL_PIPE_PATH: &str = r"\\.\pipe\NetPeekCollectorControl";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// 网速提醒触发后的冷却时间：同一方向 5 分钟内不重复打扰（借鉴 Sniffnet 的
/// 通知节流思路；它按「数值回归正常再重新武装」节流，冷却窗实现更简单直观）。
const ALERT_COOLDOWN: Duration = Duration::from_secs(300);

/// 网速提醒的每方向冷却状态。pipe 线程独占访问，但放 Mutex 便于 app.manage 共享。
#[derive(Default)]
pub struct AlertState {
    last_down: Mutex<Option<Instant>>,
    last_up: Mutex<Option<Instant>>,
}

/// 向采集服务发送反向控制命令（pause / resume / toggle）。
/// 短连接：新建客户端写一行命令后立即关闭；采集服务未运行则返回错误（状态由快照驱动）。
///
/// **必须用 `access_mode` 精确指定，不能只写 `write(true)`**：Rust 在 Windows 上会把
/// write-only 推导成 `GENERIC_WRITE`，而它展开后还包含 `FILE_APPEND_DATA`、`FILE_WRITE_EA`、
/// `READ_CONTROL` 等位；采集端给控制管道客户端的 ACL 是「写数据 + 读属性 + 同步」的最小集，
/// 请求里多出一位就被整体拒绝（`ERROR_ACCESS_DENIED`），命令被静默丢弃 ——
/// 表现就是「暂停按钮点了没反应」，而采集端日志里连一条记录都不会有。
/// 另外内核打开任何文件对象时都要读基本属性，`FILE_READ_ATTRIBUTES` 少一位也会同样被拒。
pub fn send_control(command: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::windows::fs::OpenOptionsExt;

    // winnt.h 的访问位。三位与采集端 ACL 授予客户端的集合逐位对应。
    const FILE_WRITE_DATA: u32 = 0x0002;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    // access_mode 一旦设置就会覆盖 read/write 推导出的访问掩码，所以这里不再写 write(true)。
    let mut file = std::fs::OpenOptions::new()
        .access_mode(FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .open(CONTROL_PIPE_PATH)
        .map_err(|e| format!("打开控制管道失败：{e}"))?;
    writeln!(file, "{command}").map_err(|e| format!("写入控制命令失败：{e}"))?;
    file.flush().map_err(|e| format!("刷新控制管道失败：{e}"))
}

/// 启动后台线程：连接管道并持续读取快照，断线后自动重连。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || loop {
        // 断开原因（服务未装 / 帧错误 / 客户端重启）都走同一秒重连，无需区分。
        let _ = read_session(&app);
        std::thread::sleep(RECONNECT_DELAY);
    });
}

fn read_session(app: &AppHandle) -> std::io::Result<()> {
    // 服务端未监听时 CreateFileW 会立即失败（ERROR_FILE_NOT_FOUND），由外层重连循环处理。
    let mut file = File::open(PIPE_PATH)
        .map_err(|e| Error::new(ErrorKind::NotFound, format!("采集服务命名管道不可用: {e}")))?;

    let _ = app.emit("pipe-status", "connected");

    let result = (|| {
        let mut len_buf = [0u8; 4];
        // 跨帧复用读取缓冲区，避免每帧 vec![0u8; len] 新分配。
        let mut buf: Vec<u8> = Vec::new();
        loop {
            file.read_exact(&mut len_buf)?;
            let len = i32::from_le_bytes(len_buf);
            if len <= 0 || len as usize > MAX_FRAME_BYTES {
                return Err(Error::new(ErrorKind::InvalidData, "帧长度非法"));
            }

            if buf.len() < len as usize {
                buf.resize(len as usize, 0);
            }
            file.read_exact(&mut buf[..len as usize])?;

            // 帧为 JSON，原样解析后交给前端；解析失败只丢弃本帧，不中断读取。
            if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&buf[..len as usize])
            {
                augment_countries(&mut value);
                // 先喂历史聚合（借用），再把所有权交给 emit，避免每帧深拷贝整棵 JSON 树。
                let state = app.state::<std::sync::Arc<history::HistoryState>>();
                history::record(&state, &value);
                // 托盘菜单文案跟随采集服务的真实暂停状态：迷你窗 / 设置界面从别的
                // 入口暂停时，快照 Status 变了，这里就是唯一的同步点。
                if let Some(status) = value.get("Status").and_then(|v| v.as_str()) {
                    crate::sync_tray_pause(app, status == "paused");
                }
                check_rate_alerts(app, &value);
                let _ = app.emit("snapshot", value);
            }
        }
    })();

    // 断开即视为采集服务退出：重启后的服务从「未暂停」起步，托盘文案一并复位，
    // 避免「服务已重开、托盘还挂着『恢复监控』」的漂移。
    crate::sync_tray_pause(app, false);
    let _ = app.emit("pipe-status", "disconnected");
    result
}

/// 给每个进程的 TopRemoteIp 补 TopRemoteCountry（ISO 二字码）。
/// maxminddb 查询是纯内存前缀树走查（微秒级），每帧几十个进程开销可忽略；
/// 私网地址 / 查不到时不补字段，前端按「未知」显示。
fn augment_countries(value: &mut serde_json::Value) {
    // 先把 (下标, IP) 收出来放开不可变借用，再回填 —— 同一循环里又借又改借不动。
    // IP 串成对复制（远端 IP 串都很短），免得借用横跨可变段。
    let targets: Vec<(usize, String)> = value
        .get("Processes")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .enumerate()
                .filter_map(|(i, p)| {
                    p.get("TopRemoteIp")
                        .and_then(|v| v.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| (i, s.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default();
    if targets.is_empty() {
        return;
    }

    let Some(processes) = value.get_mut("Processes").and_then(|v| v.as_array_mut()) else {
        return;
    };
    for (i, ip) in targets {
        let cc = crate::geo::country_code(&ip);
        if cc.is_empty() {
            continue;
        }
        if let Some(obj) = processes.get_mut(i).and_then(|v| v.as_object_mut()) {
            obj.insert("TopRemoteCountry".into(), serde_json::Value::String(cc));
        }
    }
}

/// 网速阈值提醒：设置里 downAlertMb / upAlertMb（MB/s，0 = 关闭）任一超限，
/// 弹系统通知，同一方向 5 分钟冷却。只在采集状态 ok 时判断，暂停/异常不打扰。
fn check_rate_alerts(app: &AppHandle, value: &serde_json::Value) {
    // 两个方向都没配阈值就整个跳过：不锁设置、不读速率。
    let (down_thr, up_thr) = match app.try_state::<crate::settings::SettingsState>() {
        Some(state) => crate::settings::rate_alert_thresholds(&state),
        None => return,
    };
    if down_thr <= 0.0 && up_thr <= 0.0 {
        return;
    }
    if value.get("Status").and_then(|v| v.as_str()) != Some("ok") {
        return;
    }
    let down_mbs = value
        .get("TotalDownloadBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as f64
        / 1e6;
    let up_mbs = value
        .get("TotalUploadBytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as f64
        / 1e6;

    let alerts = app.state::<AlertState>();
    let now = Instant::now();
    if down_thr > 0.0 && down_mbs >= down_thr && cooldown_ready(&alerts.last_down, now) {
        notify(
            app,
            &format!("下载速率 {down_mbs:.1} MB/s，超过提醒阈值 {down_thr:.0} MB/s"),
        );
    }
    if up_thr > 0.0 && up_mbs >= up_thr && cooldown_ready(&alerts.last_up, now) {
        notify(
            app,
            &format!("上传速率 {up_mbs:.1} MB/s，超过提醒阈值 {up_thr:.0} MB/s"),
        );
    }
}

fn cooldown_ready(since: &Mutex<Option<Instant>>, now: Instant) -> bool {
    let mut guard = since.lock().unwrap_or_else(|e| e.into_inner());
    let ready = guard.is_none_or(|t| now.duration_since(t) >= ALERT_COOLDOWN);
    if ready {
        *guard = Some(now);
    }
    ready
}

fn notify(app: &AppHandle, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("NetPeek 网速提醒")
        .body(body)
        .show();
}
