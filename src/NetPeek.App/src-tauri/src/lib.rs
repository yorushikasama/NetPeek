// NetPeek UI 入口。
// 阶段 3 会在此接入命名管道客户端，把采集服务推来的 TrafficSnapshot
// 通过 Tauri event 转发给前端。当前为占位实现。

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running NetPeek UI");
}
