// NetPeek 命名管道客户端：连接采集服务 \\.\pipe\NetPeekCollector，
// 按「4 字节小端长度 + UTF-8 JSON」帧格式读取，并把每帧快照通过 Tauri event 转发给前端。
//
// Windows 上 std::fs::File 可以直接打开命名管道路径（CreateFileW + OPEN_EXISTING），
// 因此无需引入 windows-sys。采集服务端（SnapshotPipeServer）用 PipeDirection.Out
// 创建管道并每秒推一帧；读到 EOF 即视为断开，稍后自动重连。

use std::fs::File;
use std::io::{Error, ErrorKind, Read};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::history;

const PIPE_PATH: &str = r"\\.\pipe\NetPeekCollector";
const CONTROL_PIPE_PATH: &str = r"\\.\pipe\NetPeekCollectorControl";
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const RECONNECT_DELAY: Duration = Duration::from_secs(1);

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
    std::thread::spawn(move || loop {
        match read_session(&app) {
            Ok(()) => {}
            Err(_) => {}
        }
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
        loop {
            file.read_exact(&mut len_buf)?;
            let len = i32::from_le_bytes(len_buf);
            if len <= 0 || len as usize > MAX_FRAME_BYTES {
                return Err(Error::new(ErrorKind::InvalidData, "帧长度非法"));
            }

            let mut buf = vec![0u8; len as usize];
            file.read_exact(&mut buf)?;

            // 帧为 JSON，原样解析后交给前端；解析失败只丢弃本帧，不中断读取。
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&buf) {
                let _ = app.emit("snapshot", value.clone());
                // 同一帧同时喂给历史聚合（内存分钟桶，整分钟落 SQLite）。
                let state = app.state::<std::sync::Arc<history::HistoryState>>();
                history::record(&state, &value);
            }
        }
    })();

    let _ = app.emit("pipe-status", "disconnected");
    result
}
