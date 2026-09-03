// NetPeek 设置：settings.json 持久化 + 开机自启（注册表 HKCU\...\Run）。
//
// 设置项与默认值：
//   rateUnit        "auto" | "kb" | "mb" | "gb"  速率显示单位（auto 自适应）
//   retentionDays   天数，0 = 永久保留             历史保留期
//   autostart       是否登录时启动 UI             真实状态以注册表为准
//   recordUnattributed  是否记录未归因流量（预留，采集端尚未分表）
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
    })
}

/// 启动时加载 settings.json 到内存（缺字段补默认值），返回就绪状态供 app.manage()。
pub fn init(app: &AppHandle) -> Result<SettingsState, String> {
    let path = data_dir(app)?.join(SETTINGS_FILE);
    let mut inner = defaults();
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            for (k, dv) in defaults().as_object().unwrap() {
                if !v.get(k).is_some() {
                    inner.as_object_mut().unwrap().insert(k.clone(), dv.clone());
                }
            }
            for (k, vv) in v.as_object().unwrap() {
                inner.as_object_mut().unwrap().insert(k.clone(), vv.clone());
            }
        }
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
            let mut v = defaults();
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(file) = serde_json::from_str::<serde_json::Value>(&text) {
                    for (k, dv) in defaults().as_object().unwrap() {
                        if !file.get(k).is_some() {
                            v.as_object_mut().unwrap().insert(k.clone(), dv.clone());
                        }
                    }
                    for (k, vv) in file.as_object().unwrap() {
                        v.as_object_mut().unwrap().insert(k.clone(), vv.clone());
                    }
                }
            }
            v
        }
    };
    serde_json::to_string(&inner).map_err(|e| format!("设置序列化失败: {e}"))
}

/// 覆盖保存设置（整体写入，避免并发写局部字段），并同步注册表 autostart。
#[tauri::command]
pub fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&json).map_err(|e| format!("设置 JSON 解析失败: {e}"))?;

    // autostart 写注册表（真实生效点）；其余字段落 settings.json。
    if let Some(autostart) = value.get("autostart").and_then(|v| v.as_bool()) {
        set_autostart_impl(autostart)?;
    }

    if let Some(state) = app.try_state::<SettingsState>() {
        *state.inner.lock().unwrap() = value.clone();
    }
    let path = data_dir(&app)?.join(SETTINGS_FILE);
    std::fs::write(&path, serde_json::to_string_pretty(&value).unwrap())
        .map_err(|e| format!("保存设置失败: {e}"))
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
