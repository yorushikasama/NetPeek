// 主题系统持久化：配置文件读写 + 背景图文件管理。
// 配置文件：app_data_dir/theme-config.json（JS 侧统一为 camelCase 字段）。
// 背景图：app_data_dir/backgrounds/<hash>.png（前端传 base64 原图）。

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "theme-config.json";
const BG_DIR: &str = "backgrounds";

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir)
}

/// 读取主题配置；不存在时返回空字符串，前端用默认值。
///
/// 编码容错与 settings.rs 同源：Windows 上手工编辑 JSON 自带 BOM / UTF-16 坑
/// （记事本默认 UTF-8 带 BOM、PowerShell 5.1 的 -Encoding utf8 也加 BOM、另存为
/// Unicode 是 UTF-16），而 serde_json 不认 BOM。这里先按字节解码再交还前端解析。
///
/// 文件存在但**解码不出合法文本**（截断 / 二进制损坏）：备份到
/// `theme-config.json.corrupt-<时间戳>` 再返回空串，不抛错 —— 抛错会沿
/// configStorage.load → initTheme 一路 reject，主窗主题整块起不来（比静默回退
/// 更糟）。回退后用户自改的皮肤会丢在旧配置里，但文件本体保留可找回，且下一次
/// 保存写的是全新有效配置。
#[tauri::command]
pub fn load_theme_config(app: AppHandle) -> Result<String, String> {
    let path = data_dir(&app)?.join(CONFIG_FILE);
    if !path.exists() {
        return Ok(String::new());
    }
    let bytes = fs::read(&path).map_err(|e| format!("读取主题配置失败: {e}"))?;
    match decode_config_bytes(&bytes) {
        Some(text) => Ok(text),
        None => {
            backup_corrupt_config(&path);
            Ok(String::new())
        }
    }
}

/// 覆盖写入主题配置（整体保存，避免并发写局部字段）。
///
/// 落盘前先验证 JSON 可解析：前端把整份配置序列化后整体写回，写坏即丢全部皮肤
/// （读侧解析失败 → null → 全新默认配置，用户自改的全没了）。save_theme_config
/// 是公开命令，绕过界面直接 invoke 传垃圾的路径也在这里被拦下。
#[tauri::command]
pub fn save_theme_config(app: AppHandle, json: String) -> Result<(), String> {
    let path = data_dir(&app)?.join(CONFIG_FILE);
    write_config_file(&path, &json)
}

/// 校验并落盘（路径可注入，测试不走 AppHandle）。根必须是对象 —— 配置的合法
/// 形状是「皮肤对象的映射」；解析出数组 / 标量说明调用方传错了结构，同样不落盘。
fn write_config_file(path: &std::path::Path, json: &str) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("主题配置 JSON 解析失败: {e}"))?;
    if !value.is_object() {
        return Err("主题配置根节点必须是对象".into());
    }
    // 原子落盘：写一半崩溃会让配置截断，下次加载解析失败即被改名 .corrupt-* 后重置。
    crate::write_atomic(path, json.as_bytes()).map_err(|e| format!("保存主题配置失败: {e}"))
}

/// 配置字节解码：UTF-8（可选 BOM）/ UTF-16LE / UTF-16BE。
/// 解码不出合法文本返回 None，交给调用方决定怎么兜（主题配置是备份 + 回退）。
fn decode_config_bytes(bytes: &[u8]) -> Option<String> {
    match bytes {
        [0xEF, 0xBB, 0xBF, rest @ ..] => String::from_utf8(rest.to_vec()).ok(),
        [0xFF, 0xFE, rest @ ..] => utf16_to_string(rest, true),
        [0xFE, 0xFF, rest @ ..] => utf16_to_string(rest, false),
        _ => String::from_utf8(bytes.to_vec()).ok(),
    }
}

/// UTF-16 字节转字符串；奇数字节判失败（截断的文件不该当成「几乎正确」）。
fn utf16_to_string(bytes: &[u8], little_endian: bool) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|p| {
            if little_endian {
                u16::from_le_bytes([p[0], p[1]])
            } else {
                u16::from_be_bytes([p[0], p[1]])
            }
        })
        .collect();
    String::from_utf16(&units).ok()
}

/// 把损坏的配置挪走，保留现场供人工找回。时间戳用进程启动时间，
/// 避免与历史备份撞名。
fn backup_corrupt_config(path: &std::path::Path) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = path.with_file_name(format!("{CONFIG_FILE}.corrupt-{stamp}"));
    if let Err(e) = fs::rename(path, &backup) {
        eprintln!("[NetPeek] 主题配置损坏，备份失败（保留原文件）: {e}");
    } else {
        eprintln!(
            "[NetPeek] 主题配置无法解码，已备份到 {}，回退默认值",
            backup.display()
        );
    }
}

/// 把用户选择的背景图（base64 data URL）落盘，返回保存后的绝对路径。
/// 文件名用内容 SHA-256 前 8 字节，同一张图多次选择只保留一份（且跨版本稳定）。
#[tauri::command]
pub fn save_background_image(app: AppHandle, data_url: String) -> Result<String, String> {
    let body = data_url
        .strip_prefix("data:image/")
        .ok_or("背景图格式必须是 data URL")?;
    // MIME 子类型 → 扩展名白名单。直接拿子类型当扩展名的话，svg 会落盘成
    // "*.svg+xml"，读回时对不上 MIME 表、按 image/png 返回，图必坏。
    let ext = match body.split([';', ',']).next().unwrap_or("png") {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "svg+xml" => "svg",
        other => return Err(format!("不支持的背景图格式: {other}")),
    };
    let b64 = body.split(',').nth(1).ok_or("data URL 缺少 base64 内容")?;
    let bytes = base64_decode(b64)?;

    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = hasher.finalize();
    // 取 SHA-256 前 8 字节（16 位十六进制）做文件名，跨 Rust 版本稳定，保证同图去重。
    let name = format!(
        "{:016x}.{}",
        u64::from_be_bytes(digest[..8].try_into().unwrap()),
        ext
    );

    let bg_dir = data_dir(&app)?.join(BG_DIR);
    fs::create_dir_all(&bg_dir).map_err(|e| format!("创建背景目录失败: {e}"))?;
    let path = bg_dir.join(&name);
    if !path.exists() {
        // 原子落盘：文件名是内容哈希，若写一半崩溃会留下一个「名字合法但内容截断」的文件，
        // 之后 path.exists() 命中就再也不会重写它 —— 背景图永久损坏。temp+rename 杜绝半截文件。
        crate::write_atomic(&path, &bytes).map_err(|e| format!("写入背景文件失败: {e}"))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 读取已保存的背景图，转回 data URL 供 CSS 使用。
///
/// 路径必须落在背景目录（data_dir/BG_DIR）内：这个命令会把任意路径的文件内容 base64
/// 回吐给前端，若不做限制就是一个通用的任意文件读取原语（私钥、.env、浏览器数据等
/// 凡进程可读的都能被读走并转成 data URL）。虽然 Tauri 命令通常只有本应用 webview 可达，
/// 但一旦发生 XSS 或将来加载远端内容，它就变成磁盘外泄通道。canonicalize 后校验前缀，
/// 越界即拒。
#[tauri::command]
pub fn read_background_image(app: AppHandle, path: String) -> Result<String, String> {
    let bg_dir = data_dir(&app)?.join(BG_DIR);
    // canonicalize 解析 .. 与符号链接，杜绝用 ..\..\ 逃逸出背景目录。
    let canon_dir = fs::canonicalize(&bg_dir).map_err(|e| format!("定位背景目录失败: {e}"))?;
    let canon_path = fs::canonicalize(&path).map_err(|e| format!("读取背景图失败: {e}"))?;
    if !canon_path.starts_with(&canon_dir) {
        return Err("背景图路径越界，拒绝读取".into());
    }
    let bytes = fs::read(&canon_path).map_err(|e| format!("读取背景图失败: {e}"))?;
    let ext = PathBuf::from(&path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".into());
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "image/png",
    };
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_plain_utf8() {
        let text = decode_config_bytes(br#"{"themes":{}}"#).unwrap();
        assert_eq!(text, r#"{"themes":{}}"#);
    }

    #[test]
    fn decode_utf8_with_bom() {
        // 记事本默认写 UTF-8 带 BOM；serde_json 不认 BOM，解码层必须先剥掉。
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(br#"{"themes":{}}"#);
        let text = decode_config_bytes(&bytes).unwrap();
        assert_eq!(text, r#"{"themes":{}}"#);
    }

    #[test]
    fn decode_utf16() {
        let cjk = r#"{"ai":{"provider":{"apiKey":"密钥"}}}"#;
        let mut le = vec![0xFF, 0xFE];
        for unit in cjk.encode_utf16() {
            le.extend_from_slice(&unit.to_le_bytes());
        }
        let text = decode_config_bytes(&le).expect("UTF-16LE 应当能解码");
        assert!(text.contains("密钥"), "UTF-16LE 解码后中文保留：{text}");

        let mut be = vec![0xFE, 0xFF];
        for unit in cjk.encode_utf16() {
            be.extend_from_slice(&unit.to_be_bytes());
        }
        let text = decode_config_bytes(&be).expect("UTF-16BE 应当能解码");
        assert!(text.contains("密钥"), "UTF-16BE 解码后中文保留：{text}");
    }

    #[test]
    fn decode_rejects_truncated_utf16() {
        // 奇数字节 = 截断文件，不该被当成「几乎正确」。
        assert!(decode_config_bytes(&[0xFF, 0xFE, 0x7B, 0x00, 0x41]).is_none());
    }

    #[test]
    fn decode_rejects_binary_garbage() {
        // 非 UTF-8 的二进制内容由 from_utf8 拦下。
        assert!(decode_config_bytes(&[0x00, 0x01, 0x02, 0x03, 0xFF, 0xFE]).is_none());
    }

    #[test]
    fn save_rejects_invalid_json() {
        let dir = tmp_dir();
        let path = dir.join(CONFIG_FILE);

        assert!(
            write_config_file(&path, "{ not json").is_err(),
            "写坏 JSON 必须拒绝落盘（写坏即丢全部皮肤）"
        );
        assert!(
            write_config_file(&path, "[1,2,3]").is_err(),
            "根节点不是对象也必须拒绝（合法形状是皮肤映射）"
        );
        assert!(!path.exists(), "被拒绝的写入没有留下任何文件");
    }

    #[test]
    fn save_accepts_valid_object() {
        let dir = tmp_dir();
        let path = dir.join(CONFIG_FILE);

        write_config_file(&path, r#"{"themes":{"plain":{}},"skin":"plain"}"#).unwrap();
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(saved.contains("\"skin\""), "合法对象原样落盘：{saved}");
    }

    #[test]
    fn backup_renames_corrupt_file() {
        let dir = tmp_dir();
        let path = dir.join(CONFIG_FILE);
        std::fs::write(&path, [0x00, 0x01, 0x02, 0x03]).unwrap();

        backup_corrupt_config(&path);
        assert!(!path.exists(), "损坏的原文件被挪走");
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(backups.len(), 1, "恰好一份备份");
        assert!(
            backups[0].starts_with("theme-config.json.corrupt-"),
            "备份文件名带 corrupt 前缀：{}",
            backups[0]
        );
    }

    /// 每个用例独占一个临时目录，互不干扰；用例结束后由系统清理。
    fn tmp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "netpeek-theme-test-{}-{}",
            std::process::id(),
            // 用文件系统的唯一计数代替随机：同进程内多次调用不撞名
            rand_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rand_suffix() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }
}
