// NetPeek 设置：settings.json 持久化 + 开机自启（注册表 HKCU\...\Run）。
//
// 设置项与默认值：
//   rateUnit        "auto" | "kb" | "mb" | "gb"  速率显示单位（auto 自适应）
//   retentionDays   天数，0 = 永久保留             历史保留期
//   autostart       是否登录时启动 UI             真实状态以注册表为准
//   recordUnattributed  是否记录未归因流量（预留，采集端尚未分表）
//   downAlertMb / upAlertMb  网速提醒阈值（MB/s），0 = 关闭；pipe.rs 每帧判断
//   countryDbPath   自定义 MMDB 路径，空 = 用内嵌的 DB-IP 国家库
//
// 开机自启直接用 reg.exe 读写（不引 windows 注册表 crate，
// 避免 windows-sys feature 组合的坑，见 docs/开发进度.md 第 5 节）。

use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Manager};

const SETTINGS_FILE: &str = "settings.json";
const AUTOSTART_VALUE: &str = "NetPeek";

#[derive(Default)]
pub struct SettingsState {
    inner: Mutex<serde_json::Value>,
}

/// 读取网速提醒阈值（downAlertMb, upAlertMb），缺省 / 非数值一律按 0（关闭）。
/// pipe.rs 每帧调用，锁内只取两个字段。
pub fn rate_alert_thresholds(state: &SettingsState) -> (f64, f64) {
    let v = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let num = |key: &str| {
        v.get(key)
            .and_then(|x| x.as_f64().or_else(|| x.as_i64().map(|i| i as f64)))
            .unwrap_or(0.0)
    };
    (num("downAlertMb"), num("upAlertMb"))
}

fn data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir)
}

fn defaults() -> serde_json::Value {
    json!({
        "rateUnit": "auto",
        "retentionDays": 30,
        "autostart": false,
        "recordUnattributed": true,
        "downAlertMb": 0,
        "upAlertMb": 0,
        "countryDbPath": "",
    })
}

/// 保留期上限（天）。0 = 永久保留是特殊语义，必须放行；3650 天（10 年）之后没有真实意义。
const RETENTION_MAX_DAYS: i64 = 3650;

/// 网速提醒阈值上限（MB/s）。远超任何真实链路，用途只是挡住误填的 1e9。
const ALERT_MAX_MB: f64 = 100_000.0;

/// 修正「能解析但离谱」的设置值。
///
/// 与 merged_with_defaults 的分工：那一步保证字段存在且类型大致对，这一步保证取值范围合理。
/// 缺了它，手工把 settings.json 改坏就会真的出事——retentionDays = -5 会让 prune 算出未来的
/// cutoff 从而清空全部历史；99999 则每次清理都做一次无意义的全表扫描。
///
/// 非法值一律「退回默认」而不是钳到边界：用户意图已经不可靠，猜不如给个安全值。
fn sanitize(v: &mut serde_json::Value) {
    let Some(obj) = v.as_object_mut() else { return };
    let d = defaults();

    // rateUnit：白名单。前端 select 只认这四个，其他取值（含拼写错误）退回 auto。
    let unit_ok = obj
        .get("rateUnit")
        .and_then(|x| x.as_str())
        .is_some_and(|s| matches!(s, "auto" | "kb" | "mb" | "gb"));
    if !unit_ok {
        obj.insert("rateUnit".into(), d["rateUnit"].clone());
    }

    // retentionDays：整数且落在 [0, 3650]。
    let days_ok = obj
        .get("retentionDays")
        .and_then(|x| x.as_i64())
        .is_some_and(|n| (0..=RETENTION_MAX_DAYS).contains(&n));
    if !days_ok {
        obj.insert("retentionDays".into(), d["retentionDays"].clone());
    }

    // 提醒阈值：非有限值（NaN/Infinity）、负数、超上限都归零（= 关闭）。
    // 这里是「宁可少提醒，不可每帧狂弹」。
    for key in ["downAlertMb", "upAlertMb"] {
        let ok = obj
            .get(key)
            .and_then(|x| x.as_f64())
            .is_some_and(|n| n.is_finite() && (0.0..=ALERT_MAX_MB).contains(&n));
        if !ok {
            obj.insert(key.into(), serde_json::json!(0));
        }
    }

    // 布尔项：JSON 里写成 "true" / 1 都算非法，退回默认。
    for key in ["autostart", "recordUnattributed"] {
        if !obj.get(key).is_some_and(serde_json::Value::is_boolean) {
            obj.insert(key.into(), d[key].clone());
        }
    }

    // 自定义国家库路径：只保证是字符串。**不在这里判文件存不存在**——路径可能指向
    // 还没插上的移动硬盘，那种情况该由 geo::apply 报错并保留原库，
    // 而不是把用户的设置悄悄改成空串（他下次插上盘还得重填）。
    if !obj
        .get("countryDbPath")
        .is_some_and(serde_json::Value::is_string)
    {
        obj.insert("countryDbPath".into(), d["countryDbPath"].clone());
    }
}

/// 取自定义国家库路径（空串 = 用内嵌库）。
pub fn country_db_path(state: &SettingsState) -> String {
    state
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get("countryDbPath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 按设置内容切换国家库。失败只回错误串，不动全局状态（见 geo::apply 的说明）。
fn apply_country_db(value: &serde_json::Value) -> Result<crate::geo::DbInfo, String> {
    crate::geo::apply(value.get("countryDbPath").and_then(|v| v.as_str()))
}

/// 读 settings.json（不存在或解析失败都返回 None，交给上层补默认值）。
fn read_settings_file(path: &std::path::Path) -> Option<serde_json::Value> {
    let bytes = std::fs::read(path).ok()?;
    parse_settings(&decode_settings_bytes(&bytes)?)
}

/// 设置文件解码。Windows 上「手工编辑 JSON」自带一串编码坑：
/// 记事本默认写 UTF-8 **带 BOM**，PowerShell 5.1 的 `-Encoding utf8` 也加 BOM，
/// 「另存为 Unicode」则是 UTF-16LE/BE。
///
/// 而 serde_json 不认 BOM —— 它把 `EF BB BF` 当成非法首字符，
/// 报 "expected value at line 1 column 1"。原来的写法是 `.ok()?` 一路吞掉，
/// 结果是**整份设置静默退回默认值**：用户改完 rateUnit / 保留期 / 提醒阈值，
/// 重启发现全白改了，还没有任何提示。（真机实测复现，见 docs/开发进度.md §19.1）
///
/// 非 UTF-8 的二进制内容由 `from_utf8` 拦下，落在同一个 None 分支。
fn decode_settings_bytes(bytes: &[u8]) -> Option<String> {
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8(rest.to_vec()).ok(),
        [0xFF, 0xFE, rest @ ..] => utf16_to_string(rest, true),
        [0xFE, 0xFF, rest @ ..] => utf16_to_string(rest, false),
        _ => String::from_utf8(bytes.to_vec()).ok(),
    }
}

/// UTF-16 字节转字符串。奇数字节直接判失败（截断的文件不该当成「几乎正确」）。
fn utf16_to_string(bytes: &[u8], little_endian: bool) -> Option<String> {
    let mut units = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        units.push(if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        });
    }
    if bytes.len() % 2 != 0 {
        return None;
    }
    String::from_utf16(&units).ok()
}

/// 解析设置文本。除 BOM 之外的空白照旧交给 serde_json（它本来就允许前导空白）。
fn parse_settings(text: &str) -> Option<serde_json::Value> {
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

/// 文件内容并入默认值：缺字段补默认、未知字段原样保留（向后兼容旧版本多出的项）。
/// init 与 load_settings 共用 —— 合并规则只此一份，两处各写一遍迟早漂移。
fn merged_with_defaults(file: Option<serde_json::Value>) -> serde_json::Value {
    let mut out = defaults();
    let Some(v) = file else { return out };
    let (Some(src), Some(dst)) = (v.as_object(), out.as_object_mut()) else {
        return out;
    };
    for (k, dv) in defaults().as_object().unwrap() {
        dst.entry(k.clone()).or_insert(dv.clone());
    }
    for (k, vv) in src {
        dst.insert(k.clone(), vv.clone());
    }
    // 补默认值之后再做范围修正：顺序不能反，sanitize 以「字段已存在」为前提。
    // 合并与修正都收口在这里，init / load_settings / save_settings 三条路径共享同一套规则。
    sanitize(&mut out);
    out
}

/// 启动时加载 settings.json 到内存（缺字段补默认值），返回就绪状态供 app.manage()。
pub fn init(app: &AppHandle) -> Result<SettingsState, String> {
    let path = data_dir(app)?.join(SETTINGS_FILE);
    let inner = merged_with_defaults(read_settings_file(&path));
    // 内嵌国家库是默认；配了外部库就在这里换掉。失败不影响启动——
    // 国家解析退回内嵌库，设置屏会显示实际生效的是哪一个。
    if let Err(e) = apply_country_db(&inner) {
        eprintln!("[NetPeek] 自定义国家库加载失败，改用内嵌库：{e}");
    }
    Ok(SettingsState {
        inner: Mutex::new(inner),
    })
}

/// 读取设置（内存态 JSON 字符串）。
#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<String, String> {
    // 窗口页面可能在 setup 完成前就 invoke（如 visible 的窗口提前加载），
    // 此时 state 尚未 manage：回退到文件/默认值，不 panic。
    let inner = match app.try_state::<SettingsState>() {
        Some(state) => state.inner.lock().unwrap().clone(),
        None => {
            let path = data_dir(&app)?.join(SETTINGS_FILE);
            merged_with_defaults(read_settings_file(&path))
        }
    };
    serde_json::to_string(&inner).map_err(|e| format!("设置序列化失败: {e}"))
}

/// 覆盖保存设置（整体写入，避免并发写局部字段），并同步注册表 autostart。
#[tauri::command]
pub fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("设置 JSON 解析失败: {e}"))?;

    // 落盘前走同一套「补默认 + 范围修正」：前端只发它认识的字段，补齐后
    // 文件内容 = 内存态 = 下次 init 的结果，三者不会漂移；同时也挡住了绕过界面
    // 直接 invoke 传越界值的路径（save_settings 是公开命令）。
    let value = merged_with_defaults(Some(value));

    // 先落 settings.json，后写注册表：文件写失败时注册表保持原样，不会出现
    // 「注册表已改、文件还是旧值」的半失败状态。autostart 的真实状态以注册表为准
    // （get_autostart 每次重读），文件里那份只是缓存，两者短暂不一致能自愈。
    let old_db = app
        .try_state::<SettingsState>()
        .map(|s| country_db_path(&s))
        .unwrap_or_default();
    if let Some(state) = app.try_state::<SettingsState>() {
        *state.inner.lock().unwrap() = value.clone();
    }
    let path = data_dir(&app)?.join(SETTINGS_FILE);
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap())
        .map_err(|e| format!("保存设置失败: {e}"))?;

    // 国家库只在路径真的变了才重载：MMDB 有 8 MB，每次改滑块都读一遍没有意义。
    let new_db = value
        .get("countryDbPath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if new_db != old_db {
        apply_country_db(&value)?;
    }

    if let Some(autostart) = value.get("autostart").and_then(|v| v.as_bool()) {
        set_autostart_impl(autostart)?;
    }
    Ok(())
}

/// 当前生效的国家库描述（JSON）：模式、路径、库类型、构建日期、节点数。
#[tauri::command]
pub fn country_db_info() -> String {
    serde_json::to_string(&crate::geo::info()).unwrap_or_else(|_| "{}".into())
}

/// 指定自定义国家库路径（空串 = 用回内嵌库）。
///
/// 顺序是「先验证、再写设置、最后生效」：probe 用独立的 reader 试打开，
/// 坏文件在这里就被挡住，不会先写进设置再失败留下一个下次启动仍会报错的配置。
#[tauri::command]
pub fn set_country_db(app: AppHandle, path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if !trimmed.is_empty() {
        crate::geo::probe(std::path::Path::new(trimmed))?;
    }
    let mut value = match app.try_state::<SettingsState>() {
        Some(state) => state.inner.lock().unwrap().clone(),
        None => merged_with_defaults(read_settings_file(&data_dir(&app)?.join(SETTINGS_FILE))),
    };
    value["countryDbPath"] = serde_json::Value::String(trimmed.to_string());
    save_settings(
        app,
        serde_json::to_string(&value).map_err(|e| e.to_string())?,
    )?;
    Ok(country_db_info())
}

/// 弹出系统文件选择框挑一个 MMDB，选中即生效（取消返回空串，调用方无动作）。
#[tauri::command]
pub async fn pick_country_db(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;

    // spawn_blocking 要拿走所有权，而 app 后面还要用来落盘，所以克隆一份进去。
    let for_dialog = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        for_dialog
            .dialog()
            .file()
            .add_filter("MaxMind 数据库", &["mmdb"])
            .set_title("选择国家/地区数据库（.mmdb）")
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("打开文件选择框失败：{e}"))?;

    let Some(p) = picked else {
        return Ok("".into());
    };
    set_country_db(app, p.to_string())
}

/// 应用数据目录的绝对路径。设置屏「关于」列展示它，用户要找日志和 history.db 时有个去处。
#[tauri::command]
pub fn data_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().to_string())
}

/// 采集服务日志的绝对路径（%ProgramData%\NetPeek\collector.log）。
/// 服务以 LocalSystem 身份运行，界面拿不到它的标准输出；ETW 会话启动失败、
/// 采集主循环异常、进程崩溃堆栈都只落在这个文件里——它是排查「界面永远离线」的唯一入口。
fn collector_log_file() -> std::path::PathBuf {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
    std::path::Path::new(&base)
        .join("NetPeek")
        .join("collector.log")
}

/// 日志路径（设置屏展示用，此时文件可能尚未生成）。
#[tauri::command]
pub fn collector_log_path() -> String {
    collector_log_file().to_string_lossy().to_string()
}

/// 在资源管理器中定位采集服务日志。
#[tauri::command]
pub fn open_collector_log() -> Result<String, String> {
    let path = collector_log_file();
    if !path.exists() {
        return Err("采集日志尚未生成：采集服务还没启动过，或 %ProgramData% 不可写".into());
    }
    // /select 直接把文件高亮出来，比单开目录少一步点击。
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .spawn()
        .map_err(|e| format!("打开资源管理器失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 读取注册表确认开机自启真实状态（settings.json 可能过时）。
#[tauri::command]
pub fn get_autostart() -> Result<bool, String> {
    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            AUTOSTART_VALUE,
        ])
        .output()
        .map_err(|e| format!("读取开机自启失败: {e}"))?;
    Ok(out.status.success())
}

/// 设置/取消开机自启：写/删 HKCU\...\Run\NetPeek，值为当前 exe 路径。
#[tauri::command]
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    set_autostart_impl(enabled)
}

fn set_autostart_impl(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位程序路径失败: {e}"))?;
    if enabled {
        let out = std::process::Command::new("reg")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                AUTOSTART_VALUE,
                "/t",
                "REG_SZ",
                "/d",
                &exe.to_string_lossy(),
                "/f",
            ])
            .output()
            .map_err(|e| format!("设置开机自启失败: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "设置开机自启失败: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    } else {
        let _ = std::process::Command::new("reg")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                AUTOSTART_VALUE,
                "/f",
            ])
            .output()
            .map_err(|e| format!("取消开机自启失败: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 走完整的「合并 + 修正」管线，和 init / save_settings 路径一致。
    fn merged(file: serde_json::Value) -> serde_json::Value {
        merged_with_defaults(Some(file))
    }

    #[test]
    fn retention_days_out_of_range_falls_back_to_default() {
        // -5 会让 prune 算出未来的 cutoff 从而清空历史；99999 只是无意义的全表扫描。
        assert_eq!(
            merged(json!({ "retentionDays": -5 }))["retentionDays"].as_i64(),
            Some(30)
        );
        assert_eq!(
            merged(json!({ "retentionDays": 99999 }))["retentionDays"].as_i64(),
            Some(30)
        );
        // 类型不对（字符串）同样退回默认。
        assert_eq!(
            merged(json!({ "retentionDays": "30" }))["retentionDays"].as_i64(),
            Some(30)
        );
    }

    #[test]
    fn retention_days_boundaries_are_accepted() {
        // 0 = 永久保留，是合法值，不能被当成 falsy 修掉。
        assert_eq!(
            merged(json!({ "retentionDays": 0 }))["retentionDays"].as_i64(),
            Some(0)
        );
        assert_eq!(
            merged(json!({ "retentionDays": 365 }))["retentionDays"].as_i64(),
            Some(365)
        );
        assert_eq!(
            merged(json!({ "retentionDays": RETENTION_MAX_DAYS }))["retentionDays"].as_i64(),
            Some(RETENTION_MAX_DAYS)
        );
    }

    #[test]
    fn rate_unit_whitelist() {
        assert_eq!(
            merged(json!({ "rateUnit": "tb" }))["rateUnit"].as_str(),
            Some("auto")
        );
        // 大小写敏感："MB" 不是白名单成员，退回 auto。
        assert_eq!(
            merged(json!({ "rateUnit": "MB" }))["rateUnit"].as_str(),
            Some("auto")
        );
        assert_eq!(
            merged(json!({ "rateUnit": "gb" }))["rateUnit"].as_str(),
            Some("gb")
        );
    }

    #[test]
    fn alert_thresholds_non_finite_and_negative_go_to_zero() {
        assert_eq!(
            merged(json!({ "downAlertMb": -1 }))["downAlertMb"].as_f64(),
            Some(0.0)
        );
        assert_eq!(
            merged(json!({ "upAlertMb": 1e9 }))["upAlertMb"].as_f64(),
            Some(0.0)
        );
        assert_eq!(
            merged(json!({ "upAlertMb": ALERT_MAX_MB + 1.0 }))["upAlertMb"].as_f64(),
            Some(0.0)
        );
        // 正常值原样保留。
        assert_eq!(
            merged(json!({ "downAlertMb": 12.5 }))["downAlertMb"].as_f64(),
            Some(12.5)
        );
    }

    #[test]
    fn booleans_with_wrong_type_fall_back_to_default() {
        assert_eq!(
            merged(json!({ "autostart": "true" }))["autostart"].as_bool(),
            Some(false)
        );
        assert_eq!(
            merged(json!({ "recordUnattributed": 1 }))["recordUnattributed"].as_bool(),
            Some(true)
        );
        assert_eq!(
            merged(json!({ "autostart": true }))["autostart"].as_bool(),
            Some(true)
        );
    }

    #[test]
    fn unknown_fields_survive_sanitize() {
        // 向后兼容：旧版本多出来的字段不能因为修正流程被吃掉。
        assert_eq!(
            merged(json!({ "futureFlag": 7 }))["futureFlag"].as_i64(),
            Some(7)
        );
        // 缺字段时补齐默认值。
        assert_eq!(merged(json!({}))["rateUnit"].as_str(), Some("auto"));
    }

    #[test]
    fn country_db_path_is_string_or_default() {
        assert_eq!(
            merged(json!({ "countryDbPath": 7 }))["countryDbPath"].as_str(),
            Some("")
        );
        assert_eq!(
            merged(json!({ "countryDbPath": null }))["countryDbPath"].as_str(),
            Some("")
        );
        assert_eq!(
            merged(json!({ "countryDbPath": "D:\\geo\\GeoLite2-Country.mmdb" }))["countryDbPath"]
                .as_str(),
            Some("D:\\geo\\GeoLite2-Country.mmdb")
        );
        // 不存在的路径要原样保留：可能只是移动硬盘还没插上，
        // 悄悄清空会让用户下次插上盘还得重填一遍。
        assert_eq!(
            merged(json!({ "countryDbPath": "Z:\\暂时没有\\x.mmdb" }))["countryDbPath"].as_str(),
            Some("Z:\\暂时没有\\x.mmdb")
        );
    }

    #[test]
    fn collector_log_path_matches_collector_side() {
        // 采集端（C#）写的是 %ProgramData%\NetPeek\collector.log，
        // 这里必须拼出同一个位置，否则「查看日志」会指向一个永远不存在的文件。
        let text = collector_log_file().to_string_lossy().to_string();
        assert!(text.ends_with("collector.log"), "实际路径：{text}");
        assert!(text.contains("NetPeek"), "实际路径：{text}");
    }

    // ---- 设置文件编码（真机实测踩到的坑，见 §19.1）----

    #[test]
    fn utf8_bom_is_stripped() {
        let body = r#"{"retentionDays": 7, "rateUnit": "gb"}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(body.as_bytes());
        let text = decode_settings_bytes(&bytes).expect("带 BOM 的 UTF-8 应当能解码");
        assert_eq!(text, body);
        // 关键一步：解码后的文本要能真的被 serde_json 吃下。
        // 只断言「解出了字符串」是不够的——原来的写法就是能读出字符串、
        // 但 from_str 直接失败，于是整份设置静默退回默认值。
        assert_eq!(parse_settings(&text).unwrap()["retentionDays"], 7);
    }

    #[test]
    fn bom_free_utf8_still_works() {
        let text = decode_settings_bytes(br#"{"rateUnit":"mb"}"#).unwrap();
        assert_eq!(parse_settings(&text).unwrap()["rateUnit"], "mb");
        // 中文路径也要能过（BOM 剥离不能顺手按字节切片切坏多字节字符）。
        // 注意用 `"..."` + as_bytes()：`br#"..."#` 只接受 ASCII，写不进中文。
        let cjk = r#"{"countryDbPath":"D:\\国家库\\x.mmdb"}"#;
        let text = decode_settings_bytes(cjk.as_bytes()).unwrap();
        assert_eq!(
            parse_settings(&text).unwrap()["countryDbPath"],
            "D:\\国家库\\x.mmdb"
        );
    }

    #[test]
    fn utf16_settings_are_decoded() {
        let body = r#"{"retentionDays": 90}"#;
        // UTF-16LE（记事本「另存为 Unicode」）
        let mut le = vec![0xFF, 0xFE];
        for u in body.encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        let text = decode_settings_bytes(&le).expect("UTF-16LE 应当能解码");
        assert_eq!(parse_settings(&text).unwrap()["retentionDays"], 90);

        // UTF-16BE（带 BOM，少见但要认）
        let mut be = vec![0xFE, 0xFF];
        for u in body.encode_utf16() {
            be.extend_from_slice(&u.to_be_bytes());
        }
        let text = decode_settings_bytes(&be).expect("UTF-16BE 应当能解码");
        assert_eq!(parse_settings(&text).unwrap()["retentionDays"], 90);
    }

    #[test]
    fn broken_encodings_fall_through_to_none() {
        // 非法 UTF-8（0xFF 单独出现）既不是 BOM 也不是合法序列，必须失败而不是乱码通过。
        assert!(decode_settings_bytes(&[0xFF, 0x00, 0x41]).is_none());
        // 截断的 UTF-16：奇数字节直接判失败，不当成「差不多能用」。
        assert!(decode_settings_bytes(&[0xFF, 0xFE, 0x7B, 0x00, 0x41]).is_none());
        // 空文件不是合法 JSON，落到 None 由上层补默认值。
        assert!(parse_settings("").is_none());
        assert!(parse_settings("\u{feff}").is_none());
    }

    #[test]
    fn bom_file_end_to_end_keeps_user_values() {
        // 端到端：带 BOM 的文件内容走完整「解码 → 解析 → 补默认 → 修正」管线，
        // 用户改过的值必须活下来。这是真机上丢掉设置的那条路径。
        let body =
            r#"{"retentionDays": 7, "rateUnit": "gb", "downAlertMb": 1.5, "upAlertMb": 2.5}"#;
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(body.as_bytes());
        let text = decode_settings_bytes(&bytes).unwrap();
        let out = merged_with_defaults(parse_settings(&text));
        assert_eq!(out["retentionDays"], 7, "保留期被 BOM 吃掉了");
        assert_eq!(out["rateUnit"], "gb", "速率单位被 BOM 吃掉了");
        assert_eq!(out["downAlertMb"], 1.5);
        assert_eq!(out["upAlertMb"], 2.5);
        // 缺的字段照旧补默认值。
        assert_eq!(out["autostart"], false);
    }
}
