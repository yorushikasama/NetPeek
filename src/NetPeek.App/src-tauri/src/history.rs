// NetPeek 历史数据：把采集服务每秒推来的快照在内存里按「进程 × 分钟」聚合，
// 整分钟翻转时批量事务写入 SQLite（app_data_dir/history.db）。
//
// 设计要点：
// - 聚合在 UI 侧（Rust）做：采集服务只管当前快照，历史是用户数据，归 UI 常驻进程管。
// - 表结构：minute_stats(ts, pid, name, down, up)，主键 (ts, pid)。
//   pid 复用且同分钟再出现时 UPSERT 累加字节、更新名称。
// - 保留策略：retention_days 默认 30 天，启动时与每次整分钟翻转后清理过期行；
//   set_retention 可实时调整并立即清理。
// - 帧里 DownloadBytes/UploadBytes 是「本秒增量」，聚合即按分钟累加。
// - 并发：record 由管道线程调用，spawn 的清理线程每秒检查一次分钟翻转，
//   两者通过 HistoryState 内的 Mutex 共享聚合桶；连接锁只用于写。

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const DB_FILE: &str = "history.db";
const DEFAULT_RETENTION_DAYS: i64 = 30;

/// 分钟聚合桶：pid -> (进程名, 本分钟下载字节, 本分钟上传字节)
type Bucket = HashMap<i64, (String, i64, i64)>;

pub struct HistoryState {
    conn: Mutex<Connection>,
    bucket: Mutex<Bucket>,
    /// 当前聚合桶对应的分钟起点（unix 秒）；0 = 尚无数据。
    bucket_minute: AtomicI64,
    retention_days: Arc<AtomicI64>,
}

impl HistoryState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            // 占位内存库，init() 打开真实文件库后替换。
            conn: Mutex::new(Connection::open_in_memory().expect("创建占位内存库失败")),
            bucket: Mutex::new(HashMap::new()),
            bucket_minute: AtomicI64::new(0),
            retention_days: Arc::new(AtomicI64::new(DEFAULT_RETENTION_DAYS)),
        })
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn minute_of(ts_secs: i64) -> i64 {
    ts_secs / 60 * 60
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir)
}

/// 打开数据库并建表；由 setup 阶段调用一次，state 需 app.manage()。
pub fn init(app: &AppHandle, state: &Arc<HistoryState>) -> Result<(), String> {
    let path = data_dir(app)?.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS minute_stats (
           ts   INTEGER NOT NULL,
           pid  INTEGER NOT NULL,
           name TEXT NOT NULL,
           down INTEGER NOT NULL,
           up   INTEGER NOT NULL,
           PRIMARY KEY (ts, pid)
         );
         CREATE INDEX IF NOT EXISTS idx_minute_stats_ts ON minute_stats(ts);",
    )
    .map_err(|e| format!("初始化历史库失败: {e}"))?;

    *state.conn.lock().unwrap() = conn;
    prune(state).map_err(|e| e.to_string())?;
    Ok(())
}

/// 启动后台线程：每秒检查分钟翻转，整分钟批量落库 + 清理过期。
pub fn spawn(state: Arc<HistoryState>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let now_minute = minute_of(now_secs());
        let bm = state.bucket_minute.load(Ordering::Relaxed);
        if bm == 0 || bm == now_minute {
            continue;
        }
        // 取出桶内容，避免写库期间阻塞管道线程的 record。
        let bucket = {
            let mut b = state.bucket.lock().unwrap();
            let out = std::mem::take(&mut *b);
            state.bucket_minute.store(now_minute, Ordering::Relaxed);
            out
        };
        if !bucket.is_empty() {
            let mut conn = state.conn.lock().unwrap();
            let _ = flush_minute(&mut conn, &bucket, bm);
            drop(conn);
            let _ = prune(&state);
        }
    });
}

/// 把一帧快照的「本秒增量」累加进当前分钟桶；pipe.rs 每帧调用。
pub fn record(state: &Arc<HistoryState>, snap: &Value) {
    if snap.get("Status").and_then(Value::as_str) != Some("ok") {
        return; // 暂停 / 异常期间速率为 0，无增量可记
    }
    let ts = snap
        .get("TimestampUnixMs")
        .and_then(Value::as_i64)
        .map(|ms| ms / 1000)
        .unwrap_or_else(now_secs);
    let minute = minute_of(ts);
    let mut bucket = state.bucket.lock().unwrap();
    if bucket.is_empty() {
        state.bucket_minute.store(minute, Ordering::Relaxed);
    }
    let Some(procs) = snap.get("Processes").and_then(Value::as_array) else {
        return;
    };
    for p in procs {
        let Some(pid) = p.get("Pid").and_then(Value::as_i64) else {
            continue;
        };
        let down = p.get("DownloadBytes").and_then(Value::as_i64).unwrap_or(0);
        let up = p.get("UploadBytes").and_then(Value::as_i64).unwrap_or(0);
        if down <= 0 && up <= 0 {
            continue; // 无流量进程不占行，控制历史库体积
        }
        let name = p
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        bucket
            .entry(pid)
            .and_modify(|(n, d, u)| {
                *d += down;
                *u += up;
                if !name.is_empty() {
                    *n = name.clone();
                }
            })
            .or_insert((name, down, up));
    }
}

/// 批量写入一个整分钟的聚合结果（单事务）。
fn flush_minute(conn: &mut Connection, bucket: &Bucket, ts: i64) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO minute_stats (ts, pid, name, down, up)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(ts, pid) DO UPDATE SET
               name = excluded.name,
               down = minute_stats.down + excluded.down,
               up   = minute_stats.up + excluded.up",
        )?;
        for (pid, (name, down, up)) in bucket {
            stmt.execute(params![ts, pid, name, down, up])?;
        }
    }
    tx.commit()
}

/// 删除超出保留期的行。retention_days <= 0 表示永久保留。
fn prune(state: &HistoryState) -> rusqlite::Result<usize> {
    let days = state.retention_days.load(Ordering::SeqCst);
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = now_secs() - days * 86_400;
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM minute_stats WHERE ts < ?1", params![cutoff])
}

/// 查询历史：返回按分钟 x 进程的原始行（前端自行聚合展示）。
#[tauri::command]
pub fn query_history(app: AppHandle, hours: i64) -> Result<String, String> {
    let path = data_dir(&app)?.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    let cutoff = now_secs() - hours * 3600;
    let mut stmt = conn
        .prepare(
            "SELECT ts, pid, name, down, up FROM minute_stats
             WHERE ts >= ?1 ORDER BY ts ASC, pid ASC",
        )
        .map_err(|e| format!("查询历史失败: {e}"))?;
    let rows = stmt
        .query_map(params![cutoff], |r| {
            Ok(serde_json::json!({
                "ts": r.get::<_, i64>(0)?,
                "pid": r.get::<_, i64>(1)?,
                "name": r.get::<_, String>(2)?,
                "down": r.get::<_, i64>(3)?,
                "up": r.get::<_, i64>(4)?,
            }))
        })
        .map_err(|e| format!("读取历史失败: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("历史行解析失败: {e}"))?);
    }
    serde_json::to_string(&out).map_err(|e| format!("历史序列化失败: {e}"))
}

/// 历史概览：行数、最早/最晚时间、库文件字节数。用于设置屏展示与清空确认。
#[tauri::command]
pub fn history_stats(app: AppHandle) -> Result<String, String> {
    let path = data_dir(&app)?.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM minute_stats", [], |r| r.get(0))
        .map_err(|e| format!("历史行数查询失败: {e}"))?;
    let first: Option<i64> = conn
        .query_row("SELECT MIN(ts) FROM minute_stats", [], |r| r.get(0))
        .map_err(|e| format!("历史最早时间查询失败: {e}"))?;
    let last: Option<i64> = conn
        .query_row("SELECT MAX(ts) FROM minute_stats", [], |r| r.get(0))
        .map_err(|e| format!("历史最晚时间查询失败: {e}"))?;
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    serde_json::to_string(&serde_json::json!({
        "rows": count,
        "firstTs": first.unwrap_or(0),
        "lastTs": last.unwrap_or(0),
        "bytes": bytes,
    }))
    .map_err(|e| format!("历史概览序列化失败: {e}"))
}

/// 清空全部历史并 VACUUM 回收空间。
#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<(), String> {
    let path = data_dir(&app)?.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    conn.execute_batch("DELETE FROM minute_stats; VACUUM;")
        .map_err(|e| format!("清空历史失败: {e}"))
}

/// 调整保留天数（0 = 永久保留），并立即清理一次。
#[tauri::command]
pub fn set_retention(app: AppHandle, days: i64) -> Result<(), String> {
    // 用 try_state：窗口页面可能在 setup 完成前就 invoke，state 未就绪时仅落文件。
    if let Some(state) = app.try_state::<Arc<HistoryState>>() {
        state.retention_days.store(days.max(0), Ordering::SeqCst);
        prune(&state).map_err(|e| format!("按保留期清理失败: {e}"))?;
    }
    Ok(())
}
