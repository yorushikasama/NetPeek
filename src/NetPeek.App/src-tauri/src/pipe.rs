// NetPeek 命名管道客户端：连接采集服务 \\.\pipe\NetPeekCollector，
// 按「4 字节小端长度 + UTF-8 JSON」帧格式读取，并把每帧快照通过 Tauri event 转发给前端。
//
// Windows 上 std::fs::File 可以直接打开命名管道路径（CreateFileW + OPEN_EXISTING），
// 因此无需引入 windows-sys。采集服务端（SnapshotPipeServer）用 PipeDirection.Out
// 创建管道并每秒推一帧；读到 EOF 即视为断开，稍后自动重连。

use std::fs::File;
use std::io::{Error, ErrorKind, Read};
use std::sync::{Condvar, Mutex};
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

/// 反向握手的兜底超时：等前端就绪信号最多等这么久。正常情况下 main.js 在
/// `listen('snapshot')` 登记完就发信号（约在启动后一两秒内），远早于上限；
/// 真超时说明前端崩溃或加载失败，此时照常连接 —— 宁可丢首帧图标，也不能
/// 因为前端起不来而永远不连采集服务。
const READY_TIMEOUT: Duration = Duration::from_secs(10);

/// 网速提醒的每方向冷却状态。pipe 线程独占访问，但放 Mutex 便于 app.manage 共享。
#[derive(Default)]
pub struct AlertState {
    last_down: Mutex<Option<Instant>>,
    last_up: Mutex<Option<Instant>>,
}

/// 前端「快照监听已登记」的就绪信号（main.js 经 `frontend_ready` 命令点亮）。
///
/// 为什么要等：采集端连上就推首帧，而首帧是唯一带全量图标的一帧（图标只对
/// 「没发过的路径」下发，每次接受连接前重置已发集合）；Tauri 事件即发即弃、
/// 不缓冲 —— 管道线程若在前端登记监听之前就连上，首帧发出去没人接，已运行
/// 进程的图标整会话只剩占位牌（`iconCache` 没有补发机制）。
///
/// 为什么是 Condvar 而不是轮询：管道线程本来就是阻塞式的（`read_exact` 挂住
/// 等帧），多一次阻塞等待不增加任何线程，轮询反而引入最长一个周期的延迟。
/// 信号只需要等一次（首次连接前）；之后页面重载再发 `frontend_ready` 无副作用。
#[derive(Default)]
pub struct FrontendReady {
    ready: Mutex<bool>,
    cond: Condvar,
}

impl FrontendReady {
    fn signal(&self) {
        if let Ok(mut ready) = self.ready.lock() {
            *ready = true;
        }
        self.cond.notify_all();
    }

    /// 阻塞直到信号点亮或超时；返回是否在超时前收到了信号。
    fn wait_for(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        while !*ready {
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (guard, _) = self
                .cond
                .wait_timeout(ready, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            ready = guard;
        }
        true
    }
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

/// 前端把 `listen('snapshot')` 登记完就调用（main.js 的 boot 链，两个监听之后）：
/// 点亮就绪信号，管道线程由此开始连接。多发无害（幂等）—— 页面重载会再调一次，
/// 而信号本来就只在首次连接前等一次。
#[tauri::command]
pub fn frontend_ready(app: AppHandle) {
    if let Some(ready) = app.try_state::<FrontendReady>() {
        ready.signal();
    }
}

/// 启动后台线程：连接管道并持续读取快照，断线后自动重连。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        // 反向握手：等前端把 `listen('snapshot')` 挂上再连管道。不等的话，从
        // 这里到前端登记之间的帧全部丢失，而首帧恰好是唯一带全量图标的那一帧
        // （Tauri 事件即发即弃，iconCache 没有补发机制）。超时兜底见 READY_TIMEOUT：
        // 信号永远不来也照常连，宁可丢首帧图标，也不能永远不连采集服务。
        if let Some(ready) = app.try_state::<FrontendReady>() {
            if !ready.wait_for(READY_TIMEOUT) {
                log_pipe_error(
                    &app,
                    "前端就绪信号 10s 未到达，按兜底直接连接管道（前端可能崩溃或加载失败）",
                );
            }
        }
        // 就绪状态未注册（初始化顺序异常）时不等待直接连，行为等同旧版。

        // 服务未启动时每秒重连一次属常态，但不能静默到底 —— 故障会无从排查。
        // 同一条错误 60 秒内只记一次日志，避免采集服务离线时把日志刷爆。
        let mut last_err = String::new();
        let mut last_logged: Option<Instant> = None;
        loop {
            if let Err(e) = read_session(&app) {
                let msg = e.to_string();
                let should_log = last_logged
                    .map(|t| t.elapsed() >= Duration::from_secs(60))
                    .unwrap_or(true)
                    || msg != last_err;
                if should_log {
                    log_pipe_error(&app, &format!("管道会话失败：{msg}"));
                    last_err = msg;
                    last_logged = Some(Instant::now());
                }
            }
            // 离线复位放在这一层，而不是只放在 read_session 的收尾：`File::open`
            // 失败时它用 `?` 提前返回，收尾那段根本执行不到 —— 服务没启动时
            // 托盘会一直停在上一次的在线状态（曾经就是这样）。
            crate::set_collector_online(&app, false);
            std::thread::sleep(RECONNECT_DELAY);
        }
    });
}

/// 管道错误落盘到 netpeek.log（复用历史模块的日志设施；历史状态未就绪时静默跳过）。
fn log_pipe_error(app: &AppHandle, msg: &str) {
    if let Some(state) = app.try_state::<std::sync::Arc<history::HistoryState>>() {
        history::log_error(&state, msg);
    }
}

fn read_session(app: &AppHandle) -> std::io::Result<()> {
    // 服务端未监听时 CreateFileW 会立即失败（ERROR_FILE_NOT_FOUND），由外层重连循环处理。
    // 注意 os error 231（ERROR_PIPE_BUSY）和「服务未运行」是两回事：管道存在、但
    // 唯一的实例被别的客户端占着 —— 典型成因是安装版与开发版并存（单实例守卫按
    // 可执行文件路径区分，拦不住），或任何别的程序打开了这条管道。单消费者设计
    // 没有排队，只能等占位者退出。混报成「服务不可用」会引导用户去重启一个
    // 活得好好的服务，所以这里必须分开说。
    let mut file = File::open(PIPE_PATH).map_err(|e| {
        if e.raw_os_error() == Some(231) {
            Error::new(
                ErrorKind::Other,
                "采集管道被其他客户端占用（os error 231），采集服务本身在运行；可能是安装版与开发版同时开着",
            )
        } else {
            Error::new(ErrorKind::NotFound, format!("采集服务命名管道不可用: {e}"))
        }
    })?;

    // 托盘「暂停监控」的可用性跟着这个标志走：管道没通时它置灰，
    // 免得用户点了半天没反应还不知道为什么。
    crate::set_collector_online(app, true);
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
                    crate::set_collector_paused(app, status == "paused");
                }
                check_rate_alerts(app, &value);
                let _ = app.emit("snapshot", value);
            }
        }
    })();

    // 断开即视为采集服务退出：重启后的服务从「未暂停」起步，离线标志一并置下，
    // 托盘的暂停文案与置灰状态都由同步线程按 online 收敛（不在这里直接改菜单 ——
    // 菜单是 explorer 的原生对象，改它要走主线程，pipe 线程只写状态）。
    crate::set_collector_online(app, false);
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
