// NetPeek 历史数据：把采集服务每秒推来的快照在内存里按「进程 × 分钟」聚合，
// 整分钟翻转时批量事务写入 SQLite（app_data_dir/history.db）。
//
// 设计要点：
// - 聚合在 UI 侧（Rust）做：采集服务只管当前快照，历史是用户数据，归 UI 常驻进程管。
// - 表结构：minute_stats(ts, pid, start_ts, name, down, up)，主键 (ts, pid, start_ts)。
//   start_ts 是进程启动时间（unix 秒），与 pid 组成进程身份键，区分同分钟内的 PID 复用；
//   同一 (pid, start_ts) 再出现时 UPSERT 累加字节、更新名称。旧库由 migrate_schema 迁移。
// - 保留策略：retention_days 由启动时的 settings.retentionDays 灌入（见 lib.rs setup），
//   启动时与每次整分钟翻转后清理过期行；set_retention 可实时调整并立即清理。
//   注意这里**不能**用硬编码默认值顶着跑：用户选了「永久保留」而内存里还是 30 天，
//   prune 会在下次启动时真的把超过 30 天的历史删掉，且不可恢复。
// - 帧里 DownloadBytes/UploadBytes 是「本秒增量」，聚合即按分钟累加。
// - 并发：record 由管道线程调用，spawn 的落库线程每秒把「已经过去的分钟」写出去，
//   两者通过 HistoryState 内的 Mutex 共享聚合桶；连接锁只用于写。
//   聚合桶按分钟分层（minute -> 进程桶），帧归哪一分钟只由帧自己的时间戳决定 ——
//   早先的实现只维护「当前分钟」这一个标量，落库线程每秒才发现翻转，
//   于是新一分钟的头几帧会被写进上一分钟的 ts；跨零点那一帧因此被记到前一天，
//   历史屏所有按天分桶的查询都会跟着错一格。

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde_json::Value;
use tauri::{AppHandle, Manager};

const DB_FILE: &str = "history.db";
const LOG_FILE: &str = "netpeek.log";
const DEFAULT_RETENTION_DAYS: i64 = 30;

/// 保留期上限（天）。与 settings.rs 的同名常量一致（10 年之后没有真实意义）。
/// 上限必须钳死：prune 用 `now - days*86_400`，release 档 `panic=abort` 且未开
/// overflow-checks，一个越界的 days 会静默溢出回绕成未来 cutoff，把整库删空。
/// set_retention 是公开命令，前端可直接 invoke 传任意 i64，故这里必须自带钳位，
/// 不能只依赖 settings 侧的 sanitize（那条链走 save_settings，绕不到 set_retention）。
const RETENTION_MAX_DAYS: i64 = 3650;

/// 库未就绪时最多攒多少分钟的数据。正常情况下 init 在几十毫秒内完成，
/// 这里攒的是那一小段时间的帧；但 init 也可能真的失败（磁盘满、目录不可写），
/// 那时候不能无限攒下去把内存吃光 —— 超出就丢最老的分钟并留一条日志。
/// 120 分钟足够覆盖任何正常的启动延迟，又不会让常驻进程的内存无界增长。
const MAX_PENDING_MINUTES: usize = 120;
const HOUR: i64 = 3600;
const WEEK: i64 = 7 * 86400;

/// 单进程单帧增量的上限（字节）。一帧 = 1 秒（IpcConstants::SnapshotIntervalMs），
/// 所以这个值就是「该进程这一秒最多能走多少」的物理上界。
///
/// 为什么要设这条（2026-09-21，在用户库里查到 2.32 GB 被记到一个分钟上）：
/// 采集服务重启后第一帧读到的是**停机期间累积的全部增量**，那一帧带着「现在」的
/// 时间戳落库，整段停机流量就被记到重启那一分钟。这类帧的增量不是「一秒的量」，
/// 而是「几十分钟的量」，与本常量差着三个数量级。
///
/// 阈值取 1 GiB/s：实测本机正常峰值是单进程单分钟 160 MB（≈2.7 MB/s 持续），
/// 异常帧单进程 631 MB/分钟（≈10.5 MB/s），两者都远在阈值之下 ——
/// 也就是说这条**不会误伤任何真实流量**（本机网卡也跑不到 1 GiB/s），
/// 只在「帧增量明显不是一秒的量」时才拦。
///
/// 拦下来是丢弃而不是钳到阈值：钳位会把一段来路不明的量伪装成一次合法的突发，
/// 那比丢掉更糟 —— 丢掉至少是诚实的缺失，钳位是编造。
const MAX_FRAME_DELTA_BYTES: i64 = 1_000_000_000;

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

/// 未落库的分钟集合：分钟起点（unix 秒）-> 该分钟的进程桶。
/// 用 BTreeMap 而不是 HashMap：落库要按时间顺序取「已经过去的分钟」，
/// 有序容器让 take_due 只看前缀、不必每秒遍历全部键。
/// 正常情况下里面只有 1～2 个分钟（当前分钟 + 刚翻过去还没写出的那个）。
type Pending = BTreeMap<i64, Bucket>;

pub struct HistoryState {
    conn: Mutex<Connection>,
    /// 按分钟分层的待落库数据。帧归哪一分钟由帧的时间戳决定，不受落库线程的轮询节奏影响。
    pending: Mutex<Pending>,
    retention_days: Arc<AtomicI64>,
    /// 真实文件库是否已就绪。init() 成功后置 true；仍为 false 时落库线程不写 ——
    /// 占位内存库没有建表，写进去只会每分钟产生一条 "no such table" 日志、数据全丢，
    /// 而前端把查不到数据渲染成「这个区间还没有落库的流量」，与真的没上网无法区分。
    db_ready: AtomicBool,
    /// 错误日志文件路径（app_data_dir/netpeek.log），init() 时设置。
    log_path: Mutex<std::path::PathBuf>,
}

impl HistoryState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            // 占位内存库，init() 打开真实文件库后替换。
            conn: Mutex::new(Connection::open_in_memory().expect("创建占位内存库失败")),
            pending: Mutex::new(BTreeMap::new()),
            retention_days: Arc::new(AtomicI64::new(DEFAULT_RETENTION_DAYS)),
            db_ready: AtomicBool::new(false),
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
    let path = state.log_path.lock().unwrap_or_else(|e| e.into_inner()).clone();
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
    *state.log_path.lock().unwrap_or_else(|e| e.into_inner()) = dir.join(LOG_FILE);
    let conn = Connection::open(&path).map_err(|e| format!("打开历史库失败: {e}"))?;
    conn.busy_timeout(Duration::from_secs(3))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    conn.execute_batch(SCHEMA_SQL)
        .map_err(|e| format!("初始化历史库失败: {e}"))?;
    migrate_schema(&conn).map_err(|e| format!("迁移历史库失败: {e}"))?;

    *state.conn.lock().unwrap_or_else(|e| e.into_inner()) = conn;
    // 真实库就绪必须在 prune 之前置位：prune 读 conn，而落库线程只看这个标志。
    state.db_ready.store(true, Ordering::SeqCst);
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

/// 取出所有「已经结束」的分钟（< 截止分钟）。当前分钟留在桶里继续累加。
/// 传 i64::MAX 表示连当前分钟一起取走（退出前的收尾落库）。
fn take_due(state: &HistoryState, before_minute: i64) -> Vec<(i64, Bucket)> {
    let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
    // BTreeMap 有序，due 的分钟一定是前缀，split_off 一刀切开即可。
    let mut due = std::mem::take(&mut *pending);
    let keep = due.split_off(&before_minute);
    *pending = keep;
    due.into_iter().collect()
}

/// 把若干个整分钟写进库并清理过期行。落库线程与退出收尾共用。
fn flush_due(state: &Arc<HistoryState>, due: Vec<(i64, Bucket)>) {
    if due.is_empty() {
        return;
    }
    // 库还没就绪就把数据放回去等下一轮：占位内存库没有建表，写进去等于丢。
    // init 是在后台线程里开库的，正常只需等几十毫秒；但它也可能彻底失败
    //（磁盘满、目录不可写），那时候不能无限攒 —— 只保留最近 MAX_PENDING_MINUTES 分钟，
    // 更早的丢掉并记一条日志，宁可丢一段历史也不能把内存吃穿。
    if !state.db_ready.load(Ordering::SeqCst) {
        let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
        for (minute, bucket) in due {
            let slot = pending.entry(minute).or_default();
            for (key, (name, down, up)) in bucket {
                let e = slot.entry(key).or_insert_with(|| (String::new(), 0, 0));
                e.0 = name;
                e.1 += down;
                e.2 += up;
            }
        }
        // log_error 锁的是 log_path，与 pending 是两把不相干的锁，这里不会自锁。
        while pending.len() > MAX_PENDING_MINUTES {
            let oldest = *pending.keys().next().expect("len > 0 时必有首键");
            pending.remove(&oldest);
            log_error(
                state,
                &format!(
                    "历史库未就绪，丢弃积压分钟 {oldest}（超出 {MAX_PENDING_MINUTES} 分钟上限）"
                ),
            );
        }
        return;
    }
    let mut conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
    for (minute, bucket) in &due {
        if bucket.is_empty() {
            continue;
        }
        if let Err(e) = flush_minute(&mut conn, bucket, *minute) {
            log_error(state, &format!("历史落库失败（分钟 {minute}）：{e}"));
        }
    }
    drop(conn);
    if let Err(e) = prune(state) {
        log_error(state, &format!("历史清理失败：{e}"));
    }
}

/// 启动后台线程：每秒把已经过去的分钟批量落库 + 清理过期。
pub fn spawn(state: Arc<HistoryState>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let due = take_due(&state, minute_of(now_secs()));
        flush_due(&state, due);
    });
}

/// 退出前的收尾落库：把**所有**待落库分钟（含当前这个不完整的分钟）写出去。
///
/// 没有这一步的话，每次退出都稳定丢 0～59 秒的全量流量 —— 落库只在分钟翻转时发生，
/// 而托盘退出走 app.exit(0)，当前分钟的桶直接随进程消失。单次不多，
/// 但它每次退出都发生，日累计量会长期偏低。
pub fn flush_on_exit(state: &Arc<HistoryState>) {
    let due = take_due(state, i64::MAX);
    flush_due(state, due);
}

/// 把一帧快照的「本秒增量」累加进当前分钟桶；pipe.rs 每帧调用。
pub fn record(state: &Arc<HistoryState>, snap: &Value) {
    if snap.get("Status").and_then(Value::as_str) != Some("ok") {
        return; // 暂停 / 异常期间速率为 0，无增量可记
    }
    // 本帧被判定为「增量不是一秒的量」而丢弃的进程数，帧末统一留痕（见下）。
    let mut dropped_frame_bytes = 0usize;
    let now = now_secs();
    let ts = snap
        .get("TimestampUnixMs")
        .and_then(Value::as_i64)
        .map(|ms| ms / 1000)
        .unwrap_or(now);
    // 帧时间戳现在决定落库的 ts，所以它必须先过一道合理性检查。采集服务与 UI 是
    // 两个进程，服务端时钟异常（或帧在管道里积压很久）会带来一个离谱的时间戳，
    // 而它会原样变成库里的 ts —— 未来的 ts 永远不会被 prune 清掉，历史屏也画不到它。
    // 偏离当前时间超过一小时就按「现在」记账：宁可把这一帧的分钟归错，
    // 也不要在库里留一行永久的脏数据。
    let ts = if (ts - now).abs() > HOUR { now } else { ts };
    let minute = minute_of(ts);
    let Some(procs) = snap.get("Processes").and_then(Value::as_array) else {
        return;
    };
    // 先把这一帧解析成「有流量的进程」列表，再上锁合并。两个好处：
    // 一是 JSON 解析不占着锁（record 由管道线程每秒调一次，锁的另一头是落库线程）；
    // 二是整帧没有流量时压根不碰 pending —— 绝大多数分钟里整台机器一个字节都没走
    //（空闲、锁屏），进循环前先 entry(minute) 会给每一分钟留一个空 HashMap。
    // 空桶落库时被 flush_due 跳过，看似无害，但它占着 MAX_PENDING_MINUTES 的名额：
    // init 真的失败时，一串空分钟会把**真正有流量**的那几分钟挤出积压上限。
    let mut frame: Vec<((i64, i64), (String, i64, i64))> = Vec::new();
    for p in procs {
        let Some(pid) = p.get("Pid").and_then(Value::as_i64) else {
            continue;
        };
        // 增量来自不可信的管道快照：钳到非负，负值没有物理意义，放进去会污染
        // 每进程/每日的 SUM 聚合（列上没有 CHECK 约束拦得住）。
        let down = p
            .get("DownloadBytes")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let up = p
            .get("UploadBytes")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        if down <= 0 && up <= 0 {
            // 无流量进程不占行，控制历史库体积。这一条同时挡掉了重连后的基线帧：
            // 采集端在 UI 断开重连后会先发一帧「只把基线拉到当前值、速率报 0」的快照
            //（见 EtwSnapshotSource.GetSnapshot 的 baseline 分支），它的 Status 是 ok，
            // 靠上面那个 Status 检查拦不住 —— 但它的每个增量都是 0，到这里被跳过。
            continue;
        }
        // 单帧增量过大 = 这一帧装的不是「一秒的量」（停机期间累积的存量、
        // 或采集端基线逻辑失效）。丢弃并留痕，理由见 MAX_FRAME_DELTA_BYTES。
        // 这里只挡超额的那一项，另一项（通常是正常量级）照记 ——
        // 把整行丢掉会连正常的那一半一起损失。
        let (down, up) = (
            if down > MAX_FRAME_DELTA_BYTES { 0 } else { down },
            if up > MAX_FRAME_DELTA_BYTES { 0 } else { up },
        );
        if down <= 0 && up <= 0 {
            dropped_frame_bytes += 1;
            continue;
        }
        // 启动时间（unix 毫秒）转秒，与 pid 组成身份键，区分同一分钟内被复用的 PID。
        let start_ts = p
            .get("StartTimeUnixMs")
            .and_then(Value::as_i64)
            .map(|ms| ms / 1000)
            .unwrap_or(0);
        let name = p
            .get("Name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        frame.push(((pid, start_ts), (name, down, up)));
    }
    if frame.is_empty() {
        return;
    }
    // 按帧自己的分钟取桶：归属只由帧的时间戳决定，与落库线程的轮询节奏无关。
    // 落库线程只取走「已经结束」的分钟，所以这里即使写进一个刚翻过去的分钟也不会丢。
    let mut pending = state.pending.lock().unwrap_or_else(|e| e.into_inner());
    let bucket = pending.entry(minute).or_default();
    for (key, (name, down, up)) in frame {
        bucket
            .entry(key)
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
    drop(pending);

    // 丢帧留痕。写进库那一刻就没法分辨「这行是正常的还是被钳过的」，
    // 所以必须在这里说一声 —— 事后对不上账时能查到是这里丢的，而不是去怀疑采集。
    // 频率上它只在异常时出现（正常帧不会有任何进程越过 MAX_FRAME_DELTA_BYTES）。
    if dropped_frame_bytes > 0 {
        log_error(
            state,
            &format!(
                "丢弃 {dropped_frame_bytes} 个进程的本帧增量：单帧超过 {MAX_FRAME_DELTA_BYTES} 字节，疑似含停机期间累积的存量"
            ),
        );
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
    let conn = state.conn.lock().unwrap_or_else(|e| e.into_inner());
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
    // 夹到 [1 天, 10 年]，与 history_process_totals 的上下限钳位口径一致：
    // 只 max(1) 不设上限时，一个超大 days 会算出远古下界（返回全部数据），是个 foot-gun。
    let cutoff = now_secs() - days.clamp(1, 3660) * 86_400;
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
/// 3600 = 本地整点（同下一条的理由：`(ts/3600)*3600` 是 UTC 整点，
/// 只在整小时偏移的时区里碰巧等于本地整点，半小时偏移的时区会整体偏半小时）、
/// 604800 = 7 天、0 = 本地日（按本地零点分组，跨夏令时也对）。
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
        // 本地整点桶：先取「当天已走过的本地秒数」（见下面日桶那条注释的推导），
        // 再对 3600 取模得到「本小时已走过的秒数」，减掉就是本地整点。
        // 不能用 (ts/3600)*3600：那是 UTC 整点，UTC+8 下碰巧相等，
        // 但 UTC+5:30 这类时区会整体偏半小时，前端按本地小时排的骨架就一格都填不上。
        "SELECT ts - (CAST(strftime('%s', ts, 'unixepoch', 'localtime') AS INTEGER) % 3600) AS bts,
                name, SUM(down) AS down, SUM(up) AS up
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

/// 任意时间区间的聚合查询：历史屏「自定义区间 ≤ 3 天」那一档的数据源
/// （前端 planQuery 判粒度，bucket 传 3600）。
/// 与 history_daily / history_range_days（按本地日聚合、给日柱图用）不同，
/// 这条支持小时粒度 —— 所以它返回的是 `ts` 数值键，由前端换算成本地小时串。
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
    // DELETE 是真正要保证的操作；VACUUM 只是回收磁盘空间，属 best-effort。
    // 分两步执行：并发写入时 VACUUM 可能撞 busy_timeout 返回 Err，但此时 DELETE 已提交
    // ——若一并 map_err 会向用户报「清空失败」，而数据其实已经清掉了（口径与事实相反）。
    conn.execute("DELETE FROM minute_stats", [])
        .map_err(|e| format!("清空历史失败: {e}"))?;
    // VACUUM 失败不致命：数据已清，空间回收可等下次；只记日志不向用户报错。
    if let Err(e) = conn.execute_batch("VACUUM") {
        eprintln!("[netpeek] VACUUM 失败（空间未回收，数据已清空）: {e}");
    }
    Ok(())
}

/// 启动时把 settings.json 里的保留期灌进内存态。
///
/// 必须在 init()（它结尾会 prune 一次）之前调用，否则那次清理按硬编码的 30 天跑：
/// 用户选了「永久保留」也会被删掉超过 30 天的历史，而且不可恢复。
/// 语义与 set_retention 一致：负数按 0（永久保留）处理。
pub fn apply_retention(state: &Arc<HistoryState>, days: i64) {
    state
        .retention_days
        .store(days.clamp(0, RETENTION_MAX_DAYS), Ordering::SeqCst);
}

/// 调整保留天数（0 = 永久保留），并立即清理一次。
#[tauri::command]
pub fn set_retention(app: AppHandle, days: i64) -> Result<(), String> {
    // 用 try_state：窗口页面可能在 setup 完成前就 invoke，state 未就绪时仅落文件。
    if let Some(state) = app.try_state::<Arc<HistoryState>>() {
        // 钳到 [0, RETENTION_MAX_DAYS]：0 = 永久保留，上限挡住越界值算出未来 cutoff 清空全库。
        state
            .retention_days
            .store(days.clamp(0, RETENTION_MAX_DAYS), Ordering::SeqCst);
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

    /// 帧时间戳现在要过一道「偏离现在不超过一小时」的合理性检查（见 record），
    /// 所以测试数据必须贴着当前时间构造，不能再写死 2023 年的常量。
    /// 返回当前分钟的起点。
    fn this_minute() -> i64 {
        minute_of(now_secs())
    }

    /// 取出 state 里某一分钟的桶副本，断言用。
    fn bucket_at(state: &Arc<HistoryState>, minute: i64) -> Bucket {
        state
            .pending
            .lock()
            .unwrap()
            .get(&minute)
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn record_accumulates_within_minute() {
        let state = HistoryState::new();
        let minute = this_minute();
        let snap = json!({
            "Status": "ok",
            "TimestampUnixMs": (minute + 10) * 1000,
            "Processes": [
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": 100, "UploadBytes": 10},
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": 50, "UploadBytes": 0},
            ],
        });
        record(&state, &snap);

        let bucket = bucket_at(&state, minute);
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
        let pending = state.pending.lock().unwrap();
        assert!(
            pending.values().all(HashMap::is_empty),
            "暂停帧与零流量进程不应占行"
        );
    }

    /// 整帧没有流量时不能留下一个空分钟桶。空桶落库时会被 flush_due 跳过，
    /// 所以它不会写脏数据 —— 但它占着 MAX_PENDING_MINUTES 的名额：机器空闲一小时
    /// 就攒下 60 个空分钟，init 真的失败时这些空分钟会把真正有流量的分钟挤出上限。
    #[test]
    fn record_leaves_no_empty_minute_when_frame_has_no_traffic() {
        let state = HistoryState::new();
        // 全零增量（空闲，或重连后的基线帧：Status 是 ok 但每个增量都是 0）
        record(
            &state,
            &json!({"Status": "ok", "Processes": [
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": 0, "UploadBytes": 0},
                {"Pid": 2, "StartTimeUnixMs": 2000, "Name": "b.exe", "DownloadBytes": 0, "UploadBytes": 0},
            ]}),
        );
        assert!(
            state.pending.lock().unwrap().is_empty(),
            "零流量帧不应建出空分钟桶"
        );

        // 有一个字节就要建桶，别把上面那条优化做成「丢数据」。
        record(
            &state,
            &json!({"Status": "ok", "Processes": [
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": 0, "UploadBytes": 1},
            ]}),
        );
        assert_eq!(
            bucket_at(&state, this_minute()).get(&(1, 1)).map(|v| v.2),
            Some(1),
            "只有上传的进程也要落进桶"
        );
    }

    #[test]
    fn record_distinguishes_reused_pid_by_start_ts() {
        let state = HistoryState::new();
        let snap = json!({"Status": "ok", "Processes": [
            {"Pid": 7, "StartTimeUnixMs": 1000, "Name": "old.exe", "DownloadBytes": 1, "UploadBytes": 0},
            {"Pid": 7, "StartTimeUnixMs": 2000, "Name": "new.exe", "DownloadBytes": 2, "UploadBytes": 0},
        ]});
        record(&state, &snap);
        let bucket = bucket_at(&state, this_minute());
        assert_eq!(bucket.len(), 2, "PID 复用按启动时间拆分为两个身份");
        assert!(bucket.contains_key(&(7, 1)));
        assert!(bucket.contains_key(&(7, 2)));
    }

    /// 这条钉住的是用户会直接看到的那个 bug：跨分钟（尤其跨零点）的帧必须按
    /// **自己的时间戳**归账。老实现只维护「当前分钟」一个标量，落库线程每秒才发现
    /// 翻转，于是新一分钟的头几帧被写进上一分钟的 ts —— 跨零点那一帧因此记到前一天，
    /// 历史屏所有按天分桶的查询都跟着错一格。
    #[test]
    fn record_attributes_each_frame_to_its_own_minute() {
        let state = HistoryState::new();
        let prev = this_minute() - 60;
        let cur = this_minute();
        let frame = |ts: i64, down: i64| {
            json!({
                "Status": "ok",
                "TimestampUnixMs": ts * 1000,
                "Processes": [
                    {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": down, "UploadBytes": 0},
                ],
            })
        };
        // 先记新分钟，再记上一分钟的一帧（管道里积压晚到的那种）：顺序不影响归属。
        record(&state, &frame(cur + 5, 30));
        record(&state, &frame(prev + 30, 70));

        assert_eq!(bucket_at(&state, cur).get(&(1, 1)).unwrap().1, 30);
        assert_eq!(bucket_at(&state, prev).get(&(1, 1)).unwrap().1, 70);
    }

    /// 离谱的时间戳（采集服务时钟异常）不能原样变成库里的 ts：未来的 ts 永远
    /// 不会被 prune 清掉，历史屏也画不到它，等于一行永久脏数据。
    #[test]
    fn record_clamps_absurd_timestamp_to_now() {
        let state = HistoryState::new();
        let snap = json!({
            "Status": "ok",
            "TimestampUnixMs": (now_secs() + 400 * 86_400) * 1000i64,
            "Processes": [
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "a.exe", "DownloadBytes": 5, "UploadBytes": 0},
            ],
        });
        record(&state, &snap);
        let pending = state.pending.lock().unwrap();
        let minutes: Vec<i64> = pending.keys().copied().collect();
        assert_eq!(minutes.len(), 1);
        assert!(
            (minutes[0] - this_minute()).abs() <= 60,
            "越界时间戳应按「现在」记账，实际分钟：{}",
            minutes[0]
        );
    }

    /// 单帧增量超过上限时丢弃该进程本帧的量。
    ///
    /// 起因（2026-09-21）：采集服务重启后第一帧读到的是停机期间累积的全部增量，
    /// 那一帧带着「现在」的时间戳落库，整段停机流量被记到重启那一分钟 ——
    /// 实测用户库里 09:00–09:48 连续 49 分钟无数据，09:49 突然 372 行 / 2.32 GB。
    /// 采集端已修（首帧当基线丢弃），这里是第二道防线：即使基线逻辑失效，
    /// 也不能让「不是一秒的量」写进库里。
    #[test]
    fn record_drops_frame_delta_beyond_physical_limit() {
        let state = HistoryState::new();
        let snap = json!({
            "Status": "ok",
            "TimestampUnixMs": now_secs() * 1000,
            "Processes": [
                // 越界：这一帧装了远超一秒的量（停机期间累积的存量）
                {"Pid": 1, "StartTimeUnixMs": 1000, "Name": "big.exe",
                 "DownloadBytes": MAX_FRAME_DELTA_BYTES + 1, "UploadBytes": 0},
                // 同帧的正常进程必须照记 —— 丢的是那一项，不是整帧
                {"Pid": 2, "StartTimeUnixMs": 2000, "Name": "ok.exe",
                 "DownloadBytes": 1234, "UploadBytes": 7},
            ],
        });
        record(&state, &snap);

        let pending = state.pending.lock().unwrap();
        let bucket = pending.values().next().expect("应有分钟桶");
        assert!(
            !bucket.contains_key(&(1, 1)),
            "越界的进程不该落库（否则 2.32 GB 会被记成一分钟内的流量）"
        );
        let ok = bucket.get(&(2, 2)).expect("正常进程应照记");
        assert_eq!(ok.1, 1234, "正常进程的下载量");
        assert_eq!(ok.2, 7, "正常进程的上传量");
    }

    /// 边界：正好等于上限的量要放行（阈值是「超过才丢」，不是「达到就丢」）。
    /// 写错成 >= 会把一次恰好一 GiB/s 的合法突发一起丢掉。
    #[test]
    fn record_keeps_frame_delta_at_exact_limit() {
        let state = HistoryState::new();
        let snap = json!({
            "Status": "ok",
            "TimestampUnixMs": now_secs() * 1000,
            "Processes": [
                {"Pid": 9, "StartTimeUnixMs": 500, "Name": "edge.exe",
                 "DownloadBytes": MAX_FRAME_DELTA_BYTES, "UploadBytes": 0},
            ],
        });
        record(&state, &snap);
        let pending = state.pending.lock().unwrap();
        let bucket = pending.values().next().expect("应有分钟桶");
        assert!(bucket.contains_key(&(9, 0)), "等于上限应放行");
    }

    /// 落库线程只带走「已经结束」的分钟，当前分钟留在桶里继续累加 ——
    /// 否则每秒轮询都会把正在累加的这一分钟切一刀写出去（虽然 UPSERT 会累加，
    /// 但那让「一分钟一行」退化成「一秒一次写」）。
    #[test]
    fn take_due_keeps_current_minute() {
        let state = HistoryState::new();
        {
            let mut pending = state.pending.lock().unwrap();
            pending
                .entry(600)
                .or_default()
                .insert((1, 0), ("a".into(), 1, 0));
            pending
                .entry(660)
                .or_default()
                .insert((1, 0), ("a".into(), 2, 0));
            pending
                .entry(720)
                .or_default()
                .insert((1, 0), ("a".into(), 3, 0));
        }
        let due = take_due(&state, 720);
        assert_eq!(due.len(), 2, "只取走 720 之前的分钟");
        assert_eq!(due[0].0, 600, "按时间顺序取出");
        assert_eq!(due[1].0, 660);
        let pending = state.pending.lock().unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending.contains_key(&720), "当前分钟留在桶里");
    }

    /// 退出收尾要把当前这个不完整的分钟也带走，否则每次退出稳定丢 0～59 秒。
    #[test]
    fn take_due_max_takes_current_minute_too() {
        let state = HistoryState::new();
        {
            let mut pending = state.pending.lock().unwrap();
            pending
                .entry(720)
                .or_default()
                .insert((1, 0), ("a".into(), 3, 0));
        }
        let due = take_due(&state, i64::MAX);
        assert_eq!(due.len(), 1, "收尾落库连当前分钟一起取");
        assert!(state.pending.lock().unwrap().is_empty());
    }

    /// 库没就绪时数据必须留在桶里等，不能写进没有建表的占位内存库。
    /// 老实现在 init 失败后照旧起落库线程，结果每分钟一条 "no such table"、
    /// 数据全丢，而前端把查不到渲染成「这个区间还没有落库的流量」。
    #[test]
    fn flush_due_retains_data_until_db_ready() {
        let state = HistoryState::new();
        // 用「当前分钟」而不是一个 1970 的小数字：flush_due 落库后会 prune，
        // 保留期默认 30 天，远古的 ts 会被立刻删掉，断言就查不到行了。
        let minute = minute_of(now_secs());
        let mut bucket: Bucket = HashMap::new();
        bucket.insert((1, 100), ("a.exe".into(), 10, 1));
        flush_due(&state, vec![(minute, bucket)]);

        assert!(!state.db_ready.load(Ordering::SeqCst));
        let kept = bucket_at(&state, minute);
        assert_eq!(
            kept.get(&(1, 100)).map(|v| (v.1, v.2)),
            Some((10, 1)),
            "库未就绪时数据应留在桶里等，而不是被写丢"
        );

        // 库就绪后同一批数据要能真的落进去。
        {
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(SCHEMA_SQL).unwrap();
        }
        state.db_ready.store(true, Ordering::SeqCst);
        let due = take_due(&state, i64::MAX);
        flush_due(&state, due);
        let conn = state.conn.lock().unwrap();
        let (down, up): (i64, i64) = conn
            .query_row(
                "SELECT down, up FROM minute_stats WHERE ts = ?1",
                params![minute],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((down, up), (10, 1));
    }

    /// 库一直不就绪（磁盘满、目录不可写）时不能无限攒，否则内存会被吃穿。
    #[test]
    fn flush_due_caps_backlog_when_db_never_ready() {
        let state = HistoryState::new();
        for i in 0..(MAX_PENDING_MINUTES as i64 + 50) {
            let mut bucket: Bucket = HashMap::new();
            bucket.insert((1, 0), ("a.exe".into(), 1, 0));
            flush_due(&state, vec![(i * 60, bucket)]);
        }
        let pending = state.pending.lock().unwrap();
        assert_eq!(pending.len(), MAX_PENDING_MINUTES, "积压分钟数封顶");
        // 丢的是最早的那些，留下的是最近的 —— 近期数据比远期更有价值。
        assert!(pending.contains_key(&((MAX_PENDING_MINUTES as i64 + 49) * 60)));
    }

    /// 保留期必须能从设置灌进来。老实现里 settings.retentionDays 只在用户改动
    /// 那一刻推给后端，重启后内存态永远从硬编码的 30 天起步：选了「永久保留」的
    /// 用户会在下次启动时被真删掉 30 天前的历史，且不可恢复。
    #[test]
    fn apply_retention_accepts_forever_and_clamps_negative() {
        let state = HistoryState::new();
        assert_eq!(
            state.retention_days.load(Ordering::SeqCst),
            DEFAULT_RETENTION_DAYS
        );

        apply_retention(&state, 0); // 0 = 永久保留，不能被当成 falsy 修掉
        assert_eq!(state.retention_days.load(Ordering::SeqCst), 0);

        apply_retention(&state, 7);
        assert_eq!(state.retention_days.load(Ordering::SeqCst), 7);

        apply_retention(&state, -5); // 负数会让 prune 算出未来的 cutoff
        assert_eq!(state.retention_days.load(Ordering::SeqCst), 0);

        // 上限钳制：越界的大 days 会让 `now - days*86_400` 在 release（panic=abort、
        // 无 overflow-checks）下溢出回绕成未来 cutoff，把整库删空。必须被夹到上限。
        apply_retention(&state, i64::MAX);
        assert_eq!(
            state.retention_days.load(Ordering::SeqCst),
            RETENTION_MAX_DAYS
        );
    }

    /// 越界的大保留期不能清库：钳到上限后 cutoff 必然落在过去（远早于任何真实数据），
    /// prune 一行都不删。这道回归钉死「set_retention 传 i64::MAX 清空全库」那条路。
    #[test]
    fn prune_does_not_wipe_when_retention_is_absurdly_large() {
        let state = HistoryState::new();
        {
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(SCHEMA_SQL).unwrap();
            // 一行「现在」的数据：cutoff 若因溢出跑到未来，这行会被删。
            conn.execute(
                "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up)
                 VALUES (?1, 1, 0, 'a.exe', 1, 0)",
                params![now_secs()],
            )
            .unwrap();
        }
        apply_retention(&state, i64::MAX);
        assert_eq!(prune(&state).unwrap(), 0, "钳到上限后不应删任何行");
    }

    /// 永久保留（0）时 prune 一行都不能删。
    #[test]
    fn prune_keeps_everything_when_retention_is_forever() {
        let state = HistoryState::new();
        {
            let conn = state.conn.lock().unwrap();
            conn.execute_batch(SCHEMA_SQL).unwrap();
            conn.execute(
                "INSERT INTO minute_stats (ts, pid, start_ts, name, down, up)
                 VALUES (?1, 1, 0, 'a.exe', 1, 0)",
                params![now_secs() - 400 * 86_400],
            )
            .unwrap();
        }
        apply_retention(&state, 0);
        assert_eq!(prune(&state).unwrap(), 0, "永久保留时不应删任何行");

        apply_retention(&state, 30);
        assert_eq!(prune(&state).unwrap(), 1, "30 天保留期应删掉 400 天前的行");
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

        // 桶键是**本地**整点，不是 UTC 整点。(ts/3600)*3600 在 UTC+8 下碰巧相等，
        // 拿它当期望值会把「本地对齐」这件事测成「UTC 对齐」—— 而半小时偏移的
        // 时区里，前端按本地小时排的骨架会一格都填不上。所以按行为断言。
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

        let rows = query_range_buckets(&conn, base - 60, base + 7200, HOUR, 0).unwrap();
        assert!(!rows.is_empty());
        assert_eq!(rows.iter().map(|r| r.down).sum::<i64>(), 70, "分桶后总量守恒");
        for r in &rows {
            let hms: String = conn
                .query_row(
                    "SELECT strftime('%M:%S', ?1, 'unixepoch', 'localtime')",
                    params![r.ts],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(hms, "00:00", "小时桶键必须落在本地整点");
        }

        // 前两行同一小时、第三行在下一小时（是否跨越由本地时区决定，所以按
        // 本地小时名自己判一次，而不是写死 2）。
        let hour_of = |ts: i64| -> String {
            conn.query_row(
                "SELECT strftime('%Y-%m-%d %H', ?1, 'unixepoch', 'localtime')",
                params![ts],
                |row| row.get(0),
            )
            .unwrap()
        };
        if hour_of(base) == hour_of(base + 3660) {
            assert_eq!(rows.len(), 1, "三行同属一个本地小时就只有一个桶");
            assert_eq!(rows[0].down, 70);
        } else {
            assert_eq!(rows.len(), 2, "跨本地小时分成两个桶");
            assert_eq!(rows[0].down, 30, "同一小时内的两行合并");
            assert_eq!((rows[1].down, rows[1].up), (40, 4));
        }
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
        let hms: String = conn
            .query_row(
                "SELECT strftime('%M:%S', ?1, 'unixepoch', 'localtime')",
                params![rows[0].ts],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(hms, "00:00", "桶键落在本地整点");
        assert!(rows[0].ts <= base && base - rows[0].ts < HOUR, "base 落在它的桶内");
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
