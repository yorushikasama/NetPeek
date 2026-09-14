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
const HOUR: i64 = 3600;
const WEEK: i64 = 7 * 86400;

/// 建表 SQL。init() 用于真实库；单测用同一份 SQL 在内存库上建表，
/// 保证测试与生产的表结构永不漂移。
const SCHEMA_SQL: &str = "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS minute_stats (
           ts       INTEGER NOT NULL,
           pid      INTEGER NOT NULL,
           start_ts INTEGER NOT NULL DEFAULT 0,
           name     TEXT NOT NULL,
           down     INTEGER NOT NULL,
           up       INTEGER NOT NULL,
           PRIMARY KEY (ts, pid, start_ts)
         );
         CREATE INDEX IF NOT EXISTS idx_minute_stats_ts ON minute_stats(ts);";

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
    conn.execute_batch(SCHEMA_SQL)
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

// ---------- 查询侧 ----------

/// 打开历史库并设好忙等上限。读取命令统一走这里：聚合线程在整分钟提交时，
/// 新连接默认 `busy_timeout = 0` 会立刻拿不到锁，而调用侧常把错误吞成 0 行 ——
/// 界面上看起来就是「历史库是空的」。库文件路径一并返回，`history_stats` 要它的字节数。
fn open_db(app: &AppHandle) -> Result<(Connection, std::path::PathBuf), String> {
    let path = data_dir(app)?.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    Ok((conn, path))
}

/// 把一条日聚合查询的游标收成 JSON 数组。两个日聚合命令共用，
/// 免得同一份行映射写两遍再各自漂移。
fn collect_daily(
    stmt: &mut rusqlite::Statement<'_>,
    bindings: impl rusqlite::Params,
) -> Result<String, String> {
    let rows = stmt
        .query_map(bindings, |r| {
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

/// `YYYY-MM-DD` 形状检查。合法性交给 SQLite 的 strftime 判，
/// 这里只挡住明显不是日期的输入 —— strftime 拿到坏输入会返回 NULL，
/// 而 NULL 比较不成立，查询会静默变空，界面读起来像「那几天没有流量」。
fn is_iso_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// 按天聚合（本地时区），最近 `days` 天：返回 `[{day:"2026-05-18", name, down, up}]`。
/// 检查栏「30 天下载」按 name 过滤，历史屏日柱图按 day 求和，两处共用这一次查询。
/// 不返回分钟级原始行 —— 30 天 × 1440 分钟 × N 进程的 JSON 前端解析不动。
#[tauri::command]
pub fn history_daily(app: AppHandle, days: i64) -> Result<String, String> {
    let (conn, _) = open_db(&app)?;
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
    collect_daily(&mut stmt, params![cutoff])
}

/// 按任意起止本地日期（含两端）聚合成**日**行（`{day, name, down, up}`）。
///
/// 与 `history_range` 的分工：那条按桶（小时/本地日/周）返回 `ts` 数值键，
/// 是统计屏的数据源；这条返回 ISO 日期串，给按 `day` 取值的调用方用。
/// 都不能拿 `history_daily(days)` 顶替：`days` 只能表达「从今天往前数 N 天」，
/// 选一个已经过去的区间（8 月 1 日到 8 月 10 日）会取回与所选窗口零重叠的数据，
/// 柱图整片是空的 —— 而这种空和「那几天确实没上网」在界面上长得一模一样。
#[tauri::command]
pub fn history_range_days(app: AppHandle, start: String, end: String) -> Result<String, String> {
    if !is_iso_day(&start) || !is_iso_day(&end) {
        return Err("日期格式应为 YYYY-MM-DD".into());
    }
    if start > end {
        return Err("开始日期不能晚于结束日期".into());
    }
    let (conn, _) = open_db(&app)?;
    // 边界交给 strftime：'utc' 修饰符把「本地墙上时间」换算成 unix 秒，
    // 与 SELECT 里的 'localtime' 正好互逆，时区口径和 ts 的写入端一致，
    // 也省掉为了算本地零点再引一个日期库。下界取当天零点，上界取次日零点的开区间。
    let mut stmt = conn
        .prepare(
            "SELECT date(ts, 'unixepoch', 'localtime') AS day, name,
                    SUM(down) AS down, SUM(up) AS up
             FROM minute_stats
             WHERE ts >= CAST(strftime('%s', ?1 || ' 00:00:00', 'utc') AS INTEGER)
               AND ts <  CAST(strftime('%s', ?2 || ' 00:00:00', 'utc') AS INTEGER) + 86400
             GROUP BY day, name
             ORDER BY day ASC, down DESC",
        )
        .map_err(|e| format!("查询日聚合失败: {e}"))?;
    collect_daily(&mut stmt, params![start, end])
}

/// 历史概览：行数、最早/最晚时间、库文件字节数。用于设置屏展示与清空确认。
#[tauri::command]
pub fn history_stats(app: AppHandle) -> Result<String, String> {
    let (conn, path) = open_db(&app)?;
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

/// 任意时间区间的聚合查询：按桶（秒）分组。bucket 取值：
/// 3600 = 小时（整小时偏移的时区下与本地小时对齐）、604800 = 7 天、
/// 0 = 本地日（按本地零点分组，跨夏令时也对）。
/// anchor 只对周桶有意义：UTC 周（(ts/604800)*604800，1970 周四对齐）在
/// 非 UTC 时区下会从周四 08:00 这种边界开始，标签对不上用户预期的周一；
/// 前端把区间起点的「本地周一零点」算好传进来，SQL 以它为锚做整周对齐。
/// SQL 抽成独立函数供单测直接打内存库。
fn query_range_buckets(
    conn: &Connection,
    start: i64,
    end: i64,
    bucket: i64,
    anchor: i64,
) -> rusqlite::Result<Vec<RangeRow>> {
    let sql = if bucket == HOUR {
        "SELECT (ts/3600)*3600 AS bts, name, SUM(down) AS down, SUM(up) AS up
         FROM minute_stats WHERE ts >= ?1 AND ts < ?2
         GROUP BY bts, name ORDER BY bts"
    } else if bucket == WEEK {
        "SELECT ((ts - ?3)/604800)*604800 + ?3 AS bts, name, SUM(down) AS down, SUM(up) AS up
         FROM minute_stats WHERE ts >= ?1 AND ts < ?2
         GROUP BY bts, name ORDER BY bts"
    } else {
        // 本地日桶：ts 减去「当天已走过的本地秒数」，得到本地零点（unix 秒）。
        // 不能写成 strftime('%s', ts, 'unixepoch', 'localtime', 'start of day')——
        // 那条链会先把 ts 转成 UTC 日期再截到 UTC 零点，结果整体偏出本地时区差
        // （UTC+8 下偏 8 小时），和前端 localMidnight 的键对不上，日桶数据会
        // 被前端 buildBuckets 的补零骨架全部丢掉（合计 0、图空、排行却有数）。
        "SELECT ts - (CAST(strftime('%s', ts, 'unixepoch', 'localtime') AS INTEGER) % 86400) AS bts,
                name, SUM(down) AS down, SUM(up) AS up
         FROM minute_stats WHERE ts >= ?1 AND ts < ?2
         GROUP BY bts, name ORDER BY bts"
    };
    let mut stmt = conn.prepare(sql)?;
    // 只有周桶 SQL 引用 ?3（锚点），其他桶多绑参数会触发 SQLITE_RANGE
    let map_row = |r: &rusqlite::Row| -> rusqlite::Result<RangeRow> {
        Ok(RangeRow {
            ts: r.get(0)?,
            name: r.get(1)?,
            down: r.get(2)?,
            up: r.get(3)?,
        })
    };
    let rows = if bucket == WEEK {
        stmt.query_map(params![start, end, anchor], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![start, end], map_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

/// 区间聚合结果行。ts 为桶起点（本地日桶 = 本地零点）。
#[derive(serde::Serialize)]
pub struct RangeRow {
    ts: i64,
    name: String,
    down: i64,
    up: i64,
}

/// 任意时间区间的聚合查询：统计屏「自定义时间」的数据源。
/// 与 history_daily（按天、给检查栏 30 天小图复用）不同，这里支持小时粒度。
/// anchor = 周桶锚点（区间起点所在周的本地周一零点），非周桶传 0 即可。
#[tauri::command]
pub fn history_range(
    app: AppHandle,
    start: i64,
    end: i64,
    bucket: i64,
    anchor: i64,
) -> Result<String, String> {
    let path = data_dir(&app)?.join(DB_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    let rows = query_range_buckets(&conn, start, end, bucket, anchor)
        .map_err(|e| format!("查询区间聚合失败: {e}"))?;
    serde_json::to_string(&rows).map_err(|e| format!("区间聚合序列化失败: {e}"))
}

/// 近 N 小时按**进程实例**聚合的结果行。pid + start_ts 就是进程身份键，
/// 与库里的主键、前端的行 key 是同一套（见文件头「表结构」）。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessTotalRow {
    name: String,
    pid: i64,
    start_ts: i64,
    down: i64,
    up: i64,
}

/// 近 N 小时按进程实例聚合。SQL 抽成独立函数供单测直接打内存库。
///
/// 为什么不只按 name 分组：监控屏每一行就是一个进程实例（行 key 也是
/// `pid:启动时刻`），按名字合并会让同一应用的多个实例显示同一个数 ——
/// 看起来像「每个 chrome 进程都用了 3 GB」。
/// name 仍留在分组键里：进程改名（少见）时两个名字各留一行，前端按身份键
/// 把同键行累加，不会因为换个名字就丢掉前半段数据。
fn query_process_totals(conn: &Connection, since: i64) -> rusqlite::Result<Vec<ProcessTotalRow>> {
    let mut stmt = conn.prepare(
        "SELECT name, pid, start_ts, SUM(down) AS down, SUM(up) AS up
         FROM minute_stats WHERE ts >= ?1
         GROUP BY name, pid, start_ts
         ORDER BY down DESC",
    )?;
    let rows = stmt.query_map(params![since], |r| {
        Ok(ProcessTotalRow {
            name: r.get(0)?,
            pid: r.get(1)?,
            start_ts: r.get(2)?,
            down: r.get(3)?,
            up: r.get(4)?,
        })
    })?;
    rows.collect()
}

/// 监控屏「近 24 小时」列的数据源：最近 `hours` 小时里每个进程实例的合计流量。
/// 口径与 `history_daily` 完全一致（同一张 minute_stats、同一批 SUM），
/// 只是分组键从「天 × 名字」换成「进程身份」—— 两处对不上时，同一份数据在
/// 表格和 30 天图里会给出不同的数，那是这个项目里最难查的一类 bug。
#[tauri::command]
pub fn history_process_totals(app: AppHandle, hours: i64) -> Result<String, String> {
    let (conn, _) = open_db(&app)?;
    // 夹到 [1 小时, 30 天]：传 0 会退化成「全部历史」，传一个巨大的数会算出
    // 未来的下界（结果恒为空，界面看起来像「历史库没数据」）。
    let since = now_secs() - hours.clamp(1, 24 * 30) * HOUR;
    let rows = query_process_totals(&conn, since).map_err(|e| format!("查询进程聚合失败: {e}"))?;
    serde_json::to_string(&rows).map_err(|e| format!("进程聚合序列化失败: {e}"))
}

/// 清空全部历史并 VACUUM 回收空间。
#[tauri::command]
pub fn clear_history(app: AppHandle) -> Result<(), String> {
    let (conn, _) = open_db(&app)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn minute_of_floors_to_minute_boundary() {
        assert_eq!(minute_of(0), 0);
        assert_eq!(minute_of(59), 0);
        assert_eq!(minute_of(60), 60);
        assert_eq!(minute_of(119), 60);
        assert_eq!(minute_of(120), 120);
    }

    #[test]
    fn record_accumulates_within_minute() {
        let state = HistoryState::new();
        let snap = json!({
            "Status": "ok",
            "TimestampUnixMs": 1_700_000_050_000i64,
            "Processes": [
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": 100, "UploadBytes": 10},
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": 50, "UploadBytes": 0},
            ],
        });
        record(&state, &snap);

        let bucket = state.bucket.lock().unwrap();
        assert_eq!(bucket.len(), 1, "同 (pid, start_ts) 应合并为一行");
        let (name, down, up) = bucket.get(&(1, 1)).expect("应有该进程条目");
        assert_eq!((name.as_str(), *down, *up), ("a.exe", 150, 10));
    }

    #[test]
    fn record_skips_paused_and_zero_traffic() {
        let state = HistoryState::new();
        record(&state, &json!({"Status": "paused", "Processes": []}));
        record(
            &state,
            &json!({"Status": "ok", "Processes": [
                {"Pid": 1, "DownloadBytes": 0, "UploadBytes": 0},
            ]}),
        );
        let bucket = state.bucket.lock().unwrap();
        assert!(bucket.is_empty(), "暂停帧与零流量进程不应占行");
    }

    #[test]
    fn record_distinguishes_reused_pid_by_start_ts() {
        let state = HistoryState::new();
        let snap = json!({"Status": "ok", "Processes": [
            {"Pid": 7, "StartTimeUnixMs": 1000, "Name": "old.exe", "DownloadBytes": 1, "UploadBytes": 0},
            {"Pid": 7, "StartTimeUnixMs": 2000, "Name": "new.exe", "DownloadBytes": 2, "UploadBytes": 0},
        ]});
        record(&state, &snap);
        let bucket = state.bucket.lock().unwrap();
        assert_eq!(bucket.len(), 2, "PID 复用按启动时间拆分为两个身份");
        assert!(bucket.contains_key(&(7, 1)));
        assert!(bucket.contains_key(&(7, 2)));
    }

    #[test]
    fn flush_minute_upserts_cumulatively() {
        let state = HistoryState::new();
        let mut conn = state.conn.lock().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        let ts = 1_700_000_040;
        let mut first: Bucket = HashMap::new();
        first.insert((1, 100), ("a.exe".into(), 100, 10));
        flush_minute(&mut conn, &first, ts).unwrap();

        let mut second: Bucket = HashMap::new();
        second.insert((1, 100), ("a.exe".into(), 50, 5));
        flush_minute(&mut conn, &second, ts).unwrap();

        let (down, up): (i64, i64) = conn
            .query_row(
                "SELECT down, up FROM minute_stats WHERE ts = ?1 AND pid = 1 AND start_ts = 100",
                params![ts],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((down, up), (150, 15), "同分钟重复落库应累加而非覆盖");
    }
}

#[cfg(test)]
mod range_tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn query_range_buckets_groups_by_hour() {
        let state = HistoryState::new();
        let conn = state.conn.lock().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        // 小时桶与时区无关，可精确断言。三行分钟数据落在两个相邻小时。
        let base = 1_700_000_040; // 分钟对齐
        for (ts, down, up) in [
            (base, 10i64, 1i64),
            (base + 60, 20, 2),
            (base + 3660, 40, 4),
        ] {
            conn.execute(
                "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up) VALUES (?1, 1, 0, 'a.exe', ?2, ?3)",
                params![ts, down, up],
            )
            .unwrap();
        }

        let b0 = (base / HOUR) * HOUR;
        let b1 = ((base + 3660) / HOUR) * HOUR;
        let rows = query_range_buckets(&conn, base - 60, base + 7200, HOUR, 0).unwrap();
        assert_eq!(rows.len(), 2, "两个小时的桶");
        assert_eq!((rows[0].ts, rows[0].down, rows[0].up), (b0, 30, 3));
        assert_eq!((rows[1].ts, rows[1].down, rows[1].up), (b1, 40, 4));
        assert!(rows[1].ts % HOUR == 0, "桶起点对齐到整小时");
    }

    #[test]
    fn query_range_buckets_filters_out_of_range() {
        let state = HistoryState::new();
        let conn = state.conn.lock().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();
        let base = 1_700_000_040;
        for ts in [base - 3600, base, base + 3600] {
            conn.execute(
                "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up) VALUES (?1, 1, 0, 'a.exe', 1, 0)",
                params![ts],
            )
            .unwrap();
        }
        // 左闭右开：只包含 [base, base+3600)
        let rows = query_range_buckets(&conn, base, base + 3600, HOUR, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].ts, (base / HOUR) * HOUR);
    }

    #[test]
    fn query_range_buckets_week_uses_anchor() {
        let state = HistoryState::new();
        let conn = state.conn.lock().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        // 锚点 = 区间起点所在周的本地周一零点（前端 Date.getDay 算出后传入）。
        // 同一锚点下，任意 ts 都归到「距锚点整周」的桶，不再按 UTC 周四对齐。
        let anchor = 1_700_000_000; // 周一零点
        let ts1 = anchor + 3600; // 第 0 周
        let ts2 = anchor + WEEK + 1800; // 第 1 周
        for (ts, down) in [(ts1, 10i64), (ts2, 20i64)] {
            conn.execute(
                "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up) VALUES (?1, 1, 0, 'a.exe', ?2, 0)",
                params![ts, down],
            )
            .unwrap();
        }
        let rows =
            query_range_buckets(&conn, anchor - 60, anchor + 2 * WEEK, WEEK, anchor).unwrap();
        assert_eq!(rows.len(), 2, "两个周桶");
        assert_eq!((rows[0].ts, rows[0].down), (anchor, 10));
        assert_eq!((rows[1].ts, rows[1].down), (anchor + WEEK, 20));
        assert_eq!(rows[0].ts % WEEK, anchor % WEEK, "桶对齐到锚点而非 UTC 周");
    }

    #[test]
    fn aggregations_totals_agree_across_buckets() {
        // 同一份分钟数据分别按日/小时/周聚合，总量必须一致——
        // 任何一档少算或多算，统计页的合计数字就会和另一档打架。
        let state = HistoryState::new();
        let conn = state.conn.lock().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        let base = 1_700_000_000; // 本地对齐的某天（周一起点附近）
        let mut total = 0i64;
        for day in 0..3i64 {
            for m in 0..5i64 {
                let ts = base + day * 86400 + m * 1200; // 每 20 分钟一行
                conn.execute(
                    "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up) VALUES (?1, 1, 0, 'a.exe', 100, 10)",
                    params![ts],
                )
                .unwrap();
                conn.execute(
                    "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up) VALUES (?1, 2, 0, 'b.exe', 50, 5)",
                    params![ts],
                )
                .unwrap();
                total += 150;
            }
        }
        let end = base + 3 * 86400;
        let day_sum: i64 = query_range_buckets(&conn, base, end, 0, 0)
            .unwrap()
            .iter()
            .map(|r| r.down)
            .sum();
        let hour_sum: i64 = query_range_buckets(&conn, base, end, HOUR, 0)
            .unwrap()
            .iter()
            .map(|r| r.down)
            .sum();
        let week_sum: i64 = query_range_buckets(&conn, base, end, WEEK, base)
            .unwrap()
            .iter()
            .map(|r| r.down)
            .sum();
        assert_eq!(day_sum, total, "日桶总量");
        assert_eq!(hour_sum, total, "小时桶总量");
        assert_eq!(week_sum, total, "周桶总量");
    }

    #[test]
    fn query_range_buckets_day_key_is_local_midnight() {
        // 日桶键必须是「本地零点」的 unix 秒。老实现用 strftime(...,'localtime','start of day')
        // 会先转 UTC 再截 UTC 零点，在 UTC+8 下偏 8 小时，和前端 localMidnight 对不上。
        // 这里断言：无论 ts 落在本地几点，桶键按本地时区格式化出来的小时必须是 00。
        let state = HistoryState::new();
        let conn = state.conn.lock().unwrap();
        conn.execute_batch(SCHEMA_SQL).unwrap();

        // 取一个「本地非零点」的时间戳（此处 2026-09-05 20:12 本地），
        // 以及一个跨天边界的相邻分钟，确保不是靠恰好落在零点蒙混过关。
        let ts1 = 1_786_610_320;
        for ts in [ts1, ts1 + 60, ts1 + 86400] {
            conn.execute(
                "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up) VALUES (?1, 1, 0, 'a.exe', 10, 1)",
                params![ts],
            )
            .unwrap();
        }
        let rows = query_range_buckets(&conn, ts1 - 60, ts1 + 86400 + 120, 0, 0).unwrap();
        assert_eq!(rows.len(), 2, "两个本地日桶");

        for r in &rows {
            let hh: String = conn
                .query_row(
                    "SELECT strftime('%H', ?1, 'unixepoch', 'localtime')",
                    params![r.ts],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(hh, "00", "日桶键必须落在本地零点（本地小时 00）");
        }
    }
}

#[cfg(test)]
mod process_total_tests {
    use super::*;

    /// 建表 + 灌入 (ts, pid, start_ts, name, down, up)，返回可用的 state。
    fn seeded(rows: &[(i64, i64, i64, &str, i64, i64)]) -> Arc<HistoryState> {
        let state = HistoryState::new();
        {
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(SCHEMA_SQL).unwrap();
            for &(ts, pid, start_ts, name, down, up) in rows {
                conn.execute(
                    "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![ts, pid, start_ts, name, down, up],
                )
                .unwrap();
            }
        }
        state
    }

    #[test]
    fn query_process_totals_accumulates_across_minutes() {
        let state = seeded(&[
            (1_700_000_040, 7, 100, "a.exe", 10, 1),
            (1_700_000_100, 7, 100, "a.exe", 20, 2),
            (1_700_000_160, 7, 100, "a.exe", 30, 3),
            (1_700_000_160, 8, 200, "b.exe", 5, 5),
        ]);
        let conn = state.conn.lock().unwrap();
        let rows = query_process_totals(&conn, 0).unwrap();
        assert_eq!(rows.len(), 2, "两个进程身份两行");
        // 按下载降序：合成一个数才是「近 24 小时用了多少」
        assert_eq!(
            (rows[0].name.as_str(), rows[0].pid, rows[0].start_ts),
            ("a.exe", 7, 100)
        );
        assert_eq!((rows[0].down, rows[0].up), (60, 6), "同一实例跨分钟累加");
        assert_eq!((rows[1].down, rows[1].up), (5, 5));
    }

    #[test]
    fn query_process_totals_keeps_reused_pid_apart() {
        // 窗口内同一个 PID 先后被两个进程用过：必须给两行。合并了就是把
        // 后一个进程的流量算到前一个头上，而「谁是罪魁祸首」正是这张表要回答的。
        let state = seeded(&[
            (1_700_000_040, 7, 100, "old.exe", 10, 0),
            (1_700_000_640, 7, 200, "new.exe", 20, 0),
        ]);
        let conn = state.conn.lock().unwrap();
        let rows = query_process_totals(&conn, 0).unwrap();
        assert_eq!(rows.len(), 2, "PID 复用按启动时间拆成两个身份");
        let sum: i64 = rows.iter().map(|r| r.down).sum();
        assert_eq!(sum, 30, "拆行后总量守恒");
    }

    #[test]
    fn query_process_totals_respects_window() {
        // 「近 24 小时」是滚动窗口，不是累计：窗口外的行一字节都不能进来，
        // 否则这个数会悄悄变成「自安装以来的总量」。
        let base = 1_700_000_000;
        let state = seeded(&[
            (base - 3600, 7, 100, "a.exe", 999, 0),
            (base, 7, 100, "a.exe", 10, 1),
        ]);
        let conn = state.conn.lock().unwrap();
        let rows = query_process_totals(&conn, base).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].down, 10, "只统计 ts >= since 的行");
    }

    #[test]
    fn query_process_totals_agrees_with_range_totals() {
        // 同一份数据按「进程身份」和按「小时桶」分组，总量必须相等。
        // 对不上时表格里的近 24 小时会和历史屏的合计打架，
        // 而用户没有任何办法判断哪边是对的。
        let base = 1_700_000_000;
        let mut seed_rows = Vec::new();
        for i in 0..40i64 {
            seed_rows.push((base + i * 60, 7, 100, "a.exe", 10, 1));
            seed_rows.push((base + i * 60, 8, 200, "b.exe", 7, 2));
        }
        let state = seeded(&seed_rows);
        let conn = state.conn.lock().unwrap();
        let end = base + 40 * 60;
        let by_proc: i64 = query_process_totals(&conn, base)
            .unwrap()
            .iter()
            .map(|r| r.down)
            .sum();
        let by_hour: i64 = query_range_buckets(&conn, base, end, HOUR, 0)
            .unwrap()
            .iter()
            .map(|r| r.down)
            .sum();
        assert_eq!(by_proc, by_hour, "两种分组的总量必须相等");
        assert_eq!(by_proc, 40 * 17, "40 分钟 × 17 字节/分钟");
    }
}
