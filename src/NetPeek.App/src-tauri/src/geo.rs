// 离线 IP → 国家/地区。库文件默认用 DB-IP 的免费国家库（dbip-country-lite，
// CC BY 4.0 许可，来源 https://db-ip.com），编译期 include_bytes! 嵌进二进制，
// 运行零网络、零文件依赖。这个思路来自 Sniffnet（内嵌 MaxMind/DB-IP MMDB 做离线定位）。
//
// 内嵌库的问题是「发版即冻结」：DB-IP 每月更新，而装了旧版的用户永远停在
// 构建那天的数据。所以这里额外支持运行时换成用户自己的 MMDB（MaxMind GeoLite2 /
// DB-IP 任意版本），内嵌库退居 fallback。Sniffnet 对应的是 CustomCountryDb 消息。
//
// 换库只影响后续查询：写入后立刻替换全局 reader，下次查询即生效。

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

use maxminddb::{Metadata, Reader};

const BUILTIN_BYTES: &[u8] = include_bytes!("../resources/dbip-country-lite.mmdb");

/// 当前生效的库。内嵌库用 `&'static [u8]`（零拷贝），外部库必须自持 `Vec<u8>`，
/// 两者是不同类型，所以用枚举分派而不是统一成一种（统一就得把 8 MB 内嵌数据拷一遍）。
enum Db {
    Builtin(Box<Reader<&'static [u8]>>),
    Custom {
        reader: Box<Reader<Vec<u8>>>,
        path: PathBuf,
    },
    /// 连内嵌库都读不出来（构建产物损坏）。保留变体而不是 Option，
    /// 让查询路径只有一处「查不到」的分支。
    Broken,
}

static DB: OnceLock<RwLock<Db>> = OnceLock::new();

fn db() -> &'static RwLock<Db> {
    DB.get_or_init(|| {
        let builtin =
            Reader::from_source(BUILTIN_BYTES).map_or(Db::Broken, |r| Db::Builtin(Box::new(r)));
        RwLock::new(builtin)
    })
}

fn query<S: AsRef<[u8]>>(reader: &Reader<S>, addr: IpAddr) -> String {
    // 用 serde_json::Value 接记录，不依赖 crate 的 geoip2 类型集，少一个 feature 顾虑。
    let Ok(record) = reader.lookup::<serde_json::Value>(addr) else {
        return String::new();
    };
    record
        .get("country")
        .and_then(|c| c.get("iso_code"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_uppercase()
}

/// 查询国家/地区 ISO 3166-1 二字码（如 "JP"、"US"）。
/// 查不到（保留 IP / 私网 / 库缺记录）一律返回空串，调用方按「未知」处理。
pub fn country_code(ip: &str) -> String {
    let Ok(addr) = ip.parse::<IpAddr>() else {
        return String::new();
    };
    // pipe.rs 每帧为带对端的进程各查一次（每秒几十次），读锁无争用、开销可忽略；
    // 之所以要锁，是因为用户可以在运行中换库（见 apply）。
    let guard = db().read().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        Db::Builtin(r) => query(r, addr),
        Db::Custom { reader, .. } => query(reader, addr),
        Db::Broken => String::new(),
    }
}

/// 当前生效库的描述，供设置屏展示。
#[derive(serde::Serialize)]
pub struct DbInfo {
    /// builtin | custom | broken
    pub mode: &'static str,
    pub path: String,
    pub database_type: String,
    /// 库构建日期 YYYY-MM-DD（MMDB 元数据里的 `build_epoch`）
    pub build_date: String,
    pub node_count: u32,
}

fn describe(mode: &'static str, path: String, meta: &Metadata) -> DbInfo {
    DbInfo {
        mode,
        path,
        database_type: meta.database_type.clone(),
        build_date: iso_date(meta.build_epoch),
        node_count: meta.node_count,
    }
}

/// Unix 秒 → YYYY-MM-DD（UTC）。为这一个格式化引入 chrono 不值当。
fn iso_date(epoch: u64) -> String {
    // build_epoch 是 u64 秒。用 try_from 而不是 `as`：`as` 在 2^63 之后会翻成负数，
    // 直接印出一个公元前的年份，比饱和到上限更难查。
    let days = i64::try_from(epoch / 86_400).unwrap_or(i64::MAX);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 天数（1970-01-01 起）→ 公历年月日。Howard Hinnant 的 `civil_from_days`，纯整数运算。
///
/// 全程用 i64 走完：中间量本是「非负」，但混用 u64/i64 会引入一串无谓的转换告警；
/// 末尾两处 `as u32` 的取值域由算法本身保证在 [1,31] 与 [1,12]，所以显式放行截断/符号告警。
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// 从字节构造 reader。单独抽出来是为了能在不改全局状态的前提下测「坏文件」路径。
fn open(bytes: Vec<u8>) -> Result<Reader<Vec<u8>>, String> {
    Reader::from_source(bytes).map_err(|e| format!("不是有效的 MMDB 文件：{e}"))
}

/// 切换到指定库；`None` / 空串表示用回内嵌库。
///
/// 先构造成功再替换，失败时全局状态保持原样——设置里填了一个坏路径不该
/// 让国家解析整个瘫掉（那种表现是「所有对端突然都变成未知」）。
pub fn apply(path: Option<&str>) -> Result<DbInfo, String> {
    let wanted = path.map(str::trim).filter(|p| !p.is_empty());
    let mut guard = db().write().unwrap_or_else(|e| e.into_inner());

    match wanted {
        None => {
            let reader =
                Reader::from_source(BUILTIN_BYTES).map_err(|e| format!("内嵌国家库损坏：{e}"))?;
            let info = describe("builtin", "（内嵌）".into(), &reader.metadata);
            *guard = Db::Builtin(Box::new(reader));
            Ok(info)
        }
        Some(p) => {
            let file = PathBuf::from(p);
            let bytes = std::fs::read(&file).map_err(|e| format!("读取失败：{e}"))?;
            let reader = open(bytes)?;
            let info = describe(
                "custom",
                file.to_string_lossy().to_string(),
                &reader.metadata,
            );
            *guard = Db::Custom {
                reader: Box::new(reader),
                path: file,
            };
            Ok(info)
        }
    }
}

/// 当前生效库的描述。额外做一次内嵌回退的探测，好在设置屏说清「为什么外面看没有国家」。
pub fn info() -> DbInfo {
    let guard = db().read().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        Db::Builtin(r) => describe("builtin", "（内嵌）".into(), &r.metadata),
        Db::Custom { reader, path } => describe(
            "custom",
            path.to_string_lossy().to_string(),
            &reader.metadata,
        ),
        Db::Broken => DbInfo {
            mode: "broken",
            path: "（内嵌）".into(),
            database_type: String::new(),
            build_date: String::new(),
            node_count: 0,
        },
    }
}

/// 路径是否指向一个能打开的 MMDB（供设置校验，不改全局状态）。
pub fn probe(path: &Path) -> Result<DbInfo, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取失败：{e}"))?;
    let reader = open(bytes)?;
    Ok(describe(
        "custom",
        path.to_string_lossy().to_string(),
        &reader.metadata,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_dns_is_us() {
        assert_eq!(country_code("8.8.8.8"), "US");
    }

    #[test]
    fn private_ip_is_empty() {
        assert_eq!(country_code("192.168.1.1"), "");
        assert_eq!(country_code("::1"), "");
    }

    #[test]
    fn garbage_is_empty() {
        assert_eq!(country_code("not-an-ip"), "");
        assert_eq!(country_code(""), "");
    }

    #[test]
    fn builtin_info_is_usable() {
        let i = info();
        assert_eq!(i.mode, "builtin");
        assert!(
            i.database_type.to_lowercase().contains("country"),
            "{}",
            i.database_type
        );
        assert!(i.node_count > 0);
        // 构建日期必须是 2000 年之后：这个断言同时守住 iso_date 的整数换算
        assert!(i.build_date.starts_with("20"), "{}", i.build_date);
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // 闰日当天
                                                            // 2024 是闰年，所以 2024-12-31 到 2025-01-01 差 1 天：两天各钉一个断言
        assert_eq!(civil_from_days(20_088), (2024, 12, 31));
        assert_eq!(civil_from_days(20_089), (2025, 1, 1));
        // 千年边界（2000 是闰年）与纪元前的负数天
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
    }

    #[test]
    fn iso_date_formats_as_expected() {
        assert_eq!(iso_date(0), "1970-01-01");
        assert_eq!(iso_date(1_735_689_600), "2025-01-01");
    }

    #[test]
    fn bad_files_are_rejected() {
        assert!(open(vec![0u8; 64]).is_err(), "全零不是 MMDB");
        assert!(open(b"not a database".to_vec()).is_err());
        assert!(
            probe(Path::new("Z:\\definitely\\missing.mmdb")).is_err(),
            "缺失文件"
        );
    }

    #[test]
    fn switching_db_takes_effect_and_restores() {
        // 用内嵌库自己当「外部库」：既不依赖外网，也能验证切换真的换了 reader。
        let tmp = std::env::temp_dir().join("netpeek-geo-switch-test.mmdb");
        std::fs::write(&tmp, BUILTIN_BYTES).expect("写临时库");

        let info = apply(Some(&tmp.to_string_lossy())).expect("切换应成功");
        assert_eq!(info.mode, "custom");
        assert_eq!(country_code("8.8.8.8"), "US", "换库后查询仍应正常");

        // 换回内嵌
        let back = apply(None).expect("复位应成功");
        assert_eq!(back.mode, "builtin");
        assert_eq!(country_code("8.8.8.8"), "US");

        // 空串与纯空白等价于「用回内嵌」，不该被当成文件名
        assert_eq!(apply(Some("   ")).expect("空白应复位").mode, "builtin");

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn failed_switch_keeps_previous_db() {
        // 关键性质：填入坏路径不能让国家解析瘫掉
        let tmp = std::env::temp_dir().join("netpeek-geo-broken-test.mmdb");
        std::fs::write(&tmp, b"garbage").expect("写坏文件");
        assert!(apply(Some(&tmp.to_string_lossy())).is_err());
        assert_eq!(country_code("8.8.8.8"), "US", "失败后仍在用旧库");
        let _ = std::fs::remove_file(&tmp);
    }
}
