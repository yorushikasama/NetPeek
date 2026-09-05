// NetPeek 命名管道客户端：连接采集服务 \\.\pipe\NetPeekCollector，
// 按「4 字节小端长度 + UTF-8 JSON」帧格式读取，并把每帧快照通过 Tauri event 转发给前端。
//
// Windows 上 std::fs::File 可以直接打开命名管道路径（CreateFileW + OPEN_EXISTING），
// 因此无需引入 windows-sys。采集服务端（SnapshotPipeServer）用 PipeDirection.Out
// 创建管道并每秒推一帧；读到 EOF 即视为断开，稍后自动重连。

use std::collections::HashMap;
use std::fs::File;
use std::io::{Error, ErrorKind, Read};
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::history;

const PIPE_PATH: &str = r"\\.\pipe\NetPeekCollector";
const CONTROL_PIPE_PATH: &str = r"\\.\pipe\NetPeekCollectorControl";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

/// 图标表：IconId -> base64 data URL。
///
/// 采集服务对每条连接只发送一次某个图标的 base64（静态数据每秒重传会让帧体积涨一个数量级），
/// 后续帧只带 IconId。这里按 id 记住 base64，并在转发给前端之前回填到每一帧，
/// 于是主窗与迷你窗（两个独立的 JS 上下文，且迷你窗可能在图标发送后才打开）
/// 都不必各自处理增量语义。表随连接重置：重连后采集服务会重新发一轮全量。
struct IconTable {
    map: Mutex<HashMap<String, String>>,
}

impl IconTable {
    fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    /// 记住本帧新携带的 base64，并给只有 IconId 的条目回填。
    fn rehydrate(&self, snap: &mut serde_json::Value) {
        let Some(procs) = snap.get_mut("Processes").and_then(|p| p.as_array_mut()) else {
            return;
        };
        let mut map = self.map.lock().unwrap();
        for p in procs {
            let Some(id) = p.get("IconId").and_then(|v| v.as_str()) else {
                continue;
            };
            if id.is_empty() {
                continue;
            }
            let id = id.to_string();
            match p.get("IconBase64").and_then(|v| v.as_str()) {
                // 本帧带了 base64：记下来供后续帧复用。
                Some(b64) if !b64.is_empty() => {
                    map.insert(id, b64.to_string());
                }
                // 本帧只有 id：从表里回填。
                _ => {
                    if let Some(b64) = map.get(&id) {
                        p["IconBase64"] = serde_json::Value::String(b64.clone());
                    }
                }
            }
        }
    }
}

/// 向采集服务发送反向控制命令（pause / resume / toggle）。
/// 短连接：新建客户端写一行命令后立即关闭；采集服务未运行则静默忽略（状态由快照驱动）。
pub fn send_control(command: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .open(CONTROL_PIPE_PATH)
    {
        let _ = writeln!(file, "{command}");
        let _ = file.flush();
    }
}

/// 启动后台线程：连接管道并持续读取快照，断线后自动重连。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let icons = IconTable::new();
        // 服务未启动时每秒重连一次属常态，但不能静默到底 —— 故障会无从排查。
        // 同一条错误 60 秒内只记一次日志，避免采集服务离线时把日志刷爆。
        let mut last_err = String::new();
        let mut last_logged: Option<std::time::Instant> = None;
        loop {
            if let Err(e) = read_session(&app, &icons) {
                let msg = e.to_string();
                let should_log = last_logged
                    .map(|t| t.elapsed() >= Duration::from_secs(60))
                    .unwrap_or(true)
                    || msg != last_err;
                if should_log {
                    log_pipe_error(&app, &format!("管道会话失败：{msg}"));
                    last_err = msg;
                    last_logged = Some(std::time::Instant::now());
                }
            }
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

fn read_session(app: &AppHandle, icons: &IconTable) -> std::io::Result<()> {
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
            if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&buf[..len as usize]) {
                // 图标 base64 每条连接只传一次，这里先回填再分发，
                // 两个窗口（主窗/迷你窗）拿到的都是完整帧，无需各自处理增量语义。
                icons.rehydrate(&mut value);
                // 先喂历史聚合（借用），再把所有权交给 emit，避免每帧深拷贝整棵 JSON 树。
                let state = app.state::<std::sync::Arc<history::HistoryState>>();
                history::record(&state, &value);
                let _ = app.emit("snapshot", value);
            }
        }
    })();

    let _ = app.emit("pipe-status", "disconnected");
    result
}
