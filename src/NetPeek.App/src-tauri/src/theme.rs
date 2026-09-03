// 主题系统持久化：配置文件读写 + 背景图文件管理。
// 配置文件：app_data_dir/theme-config.json（JS 侧统一为 camelCase 字段）。
// 背景图：app_data_dir/backgrounds/<hash>.png（前端传 base64 原图）。

use std::fs;
use std::io::Write;
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
#[tauri::command]
pub fn load_theme_config(app: AppHandle) -> Result<String, String> {
    let path = data_dir(&app)?.join(CONFIG_FILE);
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(&path).map_err(|e| format!("读取主题配置失败: {e}"))
}

/// 覆盖写入主题配置（整体保存，避免并发写局部字段）。
#[tauri::command]
pub fn save_theme_config(app: AppHandle, json: String) -> Result<(), String> {
    let path = data_dir(&app)?.join(CONFIG_FILE);
    fs::write(&path, json).map_err(|e| format!("保存主题配置失败: {e}"))
}

/// 把用户选择的背景图（base64 data URL）落盘，返回保存后的绝对路径。
/// 文件名用内容 SHA-1 前 16 位，同一张图多次选择只保留一份。
#[tauri::command]
pub fn save_background_image(app: AppHandle, data_url: String) -> Result<String, String> {
    let body = data_url
        .strip_prefix("data:image/")
        .ok_or("背景图格式必须是 data URL")?;
    let ext = body
        .split([';', ',']).next().unwrap_or("png")
        .to_string();
    let b64 = body.split(',').nth(1).ok_or("data URL 缺少 base64 内容")?;
    let bytes = base64_decode(b64)?;

    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    let name = format!("{:016x}.{}", hasher.finish(), ext);

    let bg_dir = data_dir(&app)?.join(BG_DIR);
    fs::create_dir_all(&bg_dir).map_err(|e| format!("创建背景目录失败: {e}"))?;
    let path = bg_dir.join(&name);
    if !path.exists() {
        let mut f = fs::File::create(&path).map_err(|e| format!("创建背景文件失败: {e}"))?;
        f.write_all(&bytes).map_err(|e| format!("写入背景文件失败: {e}"))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// 读取已保存的背景图，转回 data URL 供 CSS 使用。
#[tauri::command]
pub fn read_background_image(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("读取背景图失败: {e}"))?;
    let ext = PathBuf::from(&path)
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".into());
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
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
