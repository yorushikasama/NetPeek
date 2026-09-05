// NetPeek 历史数据：把采集服务每秒推来的快照在内存里按「进程 × 分钟」聚合，
// 整分钟翻转时批量事务写入 SQLite（app_data_dir/history.db）。
//
// 设计要点：
// - 聚合在 UI 侧（Rust）做：采集服务只管当前快照，历史是用户数据，归 UI 常驻进程管。
// - 表结构：minute_stats(ts, pid, start_ts, name, down, up)，主键 (ts, pid, start_ts)。
//   start_ts 是进程启动时间（unix 秒），与 pid 组成进程身份键，区分同分钟内的 PID 复用；
//   同一 (pid, start_ts) 再出现时 UPSERT 累加字节、更新名称。旧库由 migrate_schema 迁移。
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
const LOG_FILE: &str = "netpeek.log";
const DEFAULT_RETENTION_DAYS: i64 = 30;

/// 分钟聚合桶：(pid, 启动时间 unix 秒) -> (进程名, 本分钟下载字节, 本分钟上传字节)
/// 用 pid+start_ts 作身份键，区分同一分钟内被复用的 PID。
type Bucket = HashMap<(i64, i64), (String, i64, i64)>;

pub struct HistoryState {
    conn: Mutex<Connection>,
    bucket: Mutex<Bucket>,
    /// 当前聚合桶对应的分钟起点（unix 秒）；0 = 尚无数据。
    bucket_minute: AtomicI64,
    retention_days: Arc<AtomicI64>,
    /// 错误日志文件路径（app_data_dir/netpeek.log），init() 时设置。
    log_path: Mutex<std::path::PathBuf>,
}

impl HistoryState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            // 占位内存库，init() 打开真实文件库后替换。
            conn: Mutex::new(Connection::open_in_memory().expect("创建占位内存库失败")),
            bucket: Mutex::new(HashMap::new()),
            bucket_minute: AtomicI64::new(0),
            retention_days: Arc::new(AtomicI64::new(DEFAULT_RETENTION_DAYS)),
            log_path: Mutex::new(std::path::PathBuf::new()),
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

/// 把一条错误追加写入 netpeek.log（best-effort，日志写入失败也不影响主流程）。
pub(crate) fn log_error(state: &HistoryState, msg: &str) {
    use std::io::Write;
    let path = state.log_path.lock().unwrap().clone();
    if path.as_os_str().is_empty() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "[{}] {}", now_secs(), msg);
    }
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
    let dir = data_dir(app)?;
    let path = dir.join(DB_FILE);
    *state.log_path.lock().unwrap() = dir.join(LOG_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS minute_stats (
           ts       INTEGER NOT NULL,
           pid      INTEGER NOT NULL,
           start_ts INTEGER NOT NULL DEFAULT 0,
           name     TEXT NOT NULL,
           down     INTEGER NOT NULL,
           up       INTEGER NOT NULL,
           PRIMARY KEY (ts, pid, start_ts)
         );
         CREATE INDEX IF NOT EXISTS idx_minute_stats_ts ON minute_stats(ts);",
    )
    .map_err(|e| format!("初始化历史库失败: {e}"))?;
    migrate_schema(&conn).map_err(|e| format!("迁移历史库失败: {e}"))?;

    *state.conn.lock().unwrap() = conn;
    prune(state).map_err(|e| e.to_string())?;
    Ok(())
}

/// 旧版表缺 start_ts 列（主键 (ts, pid)）。SQLite 无法直接给主键加列，
/// 采用重建：建新表 → 拷数据（start_ts 填 0）→ 删旧表 → 改名 → 重建索引。
fn migrate_schema(conn: &Connection) -> rusqlite::Result<()> {
    let has_start_ts: bool = {
        let mut stmt = conn.prepare("PRAGMA table_info(minute_stats)")?;
        let cols = stmt.query_map([], |r| r.get::<_, String>(1))?;
        let mut found = false;
        for c in cols {
            if c? == "start_ts" {
                found = true;
                break;
            }
        }
        found
    };
    if has_start_ts {
        return Ok(());
    }

    conn.execute_batch(
        "BEGIN;
         CREATE TABLE minute_stats_new (
           ts       INTEGER NOT NULL,
           pid      INTEGER NOT NULL,
           start_ts INTEGER NOT NULL DEFAULT 0,
           name     TEXT NOT NULL,
           down     INTEGER NOT NULL,
           up       INTEGER NOT NULL,
           PRIMARY KEY (ts, pid, start_ts)
         );
         INSERT INTO minute_stats_new (ts, pid, start_ts, name, down, up)
           SELECT ts, pid, 0, name, down, up FROM minute_stats;
         DROP TABLE minute_stats;
         ALTER TABLE minute_stats_new RENAME TO minute_stats;
         CREATE INDEX idx_minute_stats_ts ON minute_stats(ts);
         COMMIT;",
    )
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
            if let Err(e) = flush_minute(&mut conn, &bucket, bm) {
                log_error(&state, &format!("历史落库失败（分钟 {bm}）：{e}"));
            }
            drop(conn);
            if let Err(e) = prune(&state) {
                log_error(&state, &format!("历史清理失败：{e}"));
            }
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
        // 启动时间（unix 毫秒）转秒，与 pid 组成身份键，区分同一分钟内被复用的 PID。
        let start_ts = p
            .get("StartTimeUnixMs")
            .and_then(Value::as_i64)
            .map(|ms| ms / 1000)
            .unwrap_or(0);
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
            .entry((pid, start_ts))
            .and_modify(|(n, d, u)| {
                *d += down;
                *u += up;
                // 名字几乎每帧不变，只有变化时才 clone，避免每帧无谓的 String 分配。
                if !name.is_empty() && *n != name {
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
            "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(ts, pid, start_ts) DO UPDATE SET
               name = excluded.name,
               down = minute_stats.down + excluded.down,
               up   = minute_stats.up + excluded.up",
        )?;
        for ((pid, start_ts), (name, down, up)) in bucket {
            stmt.execute(params![ts, pid, start_ts, name, down, up])?;
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
            "SELECT ts, pid, start_ts, name, down, up FROM minute_stats
             WHERE ts >= ?1 ORDER BY ts ASC, pid ASC",
        )
        .map_err(|e| format!("查询历史失败: {e}"))?;
    let rows = stmt
        .query_map(params![cutoff], |r| {
            Ok(serde_json::json!({
                "ts": r.get::<_, i64>(0)?,
                "pid": r.get::<_, i64>(1)?,
                "startTs": r.get::<_, i64>(2)?,
                "name": r.get::<_, String>(3)?,
                "down": r.get::<_, i64>(4)?,
                "up": r.get::<_, i64>(5)?,
            }))
        })
        .map_err(|e| format!("读取历史失败: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("历史行解析失败: {e}"))?);
    }
    serde_json::to_string(&out).map_err(|e| format!("历史序列化失败: {e}"))
}

/// 按天聚合（本地时区）：返回 `[{day:"2026-05-18", name, down, up}]`。
/// 检查栏「30 天下载」按 name 过滤，历史屏日柱图按 day 求和，两处共用这一次查询。
/// 不返回分钟级原始行 —— 30 天 × 1440 分钟 × N 进程的 JSON 前端解析不动。
#[tauri::command]
pub fn history_daily(app: AppHandle, days: i64) -> Result<String, String> {
    let path = data_dir(&app)?.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    let cutoff = now_secs() - days.max(1) * 86_400;
    let mut stmt = conn
        .prepare(
            "SELECT date(ts, 'unixepoch', 'localtime') AS day, name,
                    SUM(down) AS down, SUM(up) AS up
             FROM minute_stats WHERE ts >= ?1
             GROUP BY day, name
             ORDER BY day ASC, down DESC",
        )
        .map_err(|e| format!("查询日聚合失败: {e}"))?;
    let rows = stmt
        .query_map(params![cutoff], |r| {
            Ok(serde_json::json!({
                "day": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "down": r.get::<_, i64>(2)?,
                "up": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(|e| format!("读取日聚合失败: {e}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("日聚合行解析失败: {e}"))?);
    }
    serde_json::to_string(&out).map_err(|e| format!("日聚合序列化失败: {e}"))
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
