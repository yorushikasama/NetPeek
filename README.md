# NetPeek

轻量 Windows 桌面工具，实时监控各软件的网络流量（按进程归因上传/下载）。

## 架构

```text
NetPeek.App (Tauri 2, 普通权限)  ←—Named Pipe—→  NetPeek.Collector (.NET 8 Windows Service, LocalSystem)
        UI 渲染                                                   ETW 采集 + 聚合
```

采集服务订阅 `Microsoft-Windows-Kernel-Network`，按 payload PID 聚合字节，每秒通过命名管道推送一帧快照给 UI。

## 目录

```text
src/NetPeek.Shared/       IPC 协议 DTO 与帧格式常量（服务与 UI 共用契约）
src/NetPeek.Collector/    .NET 8 Windows Service（ETW + 聚合 + 命名管道服务端）
src/NetPeek.App/          Tauri 2（src-tauri Rust 外壳 + ui 前端）
scripts/                  真机验证脚本（采集链路、暂停链路）
docs/                     技术选型、执行计划、功能清单、开发进度、UI 提示词
```

## 环境前提

- .NET 8 SDK（后端必需）
- Rust 工具链 + Cargo（Tauri 必需）
- Node + npm（仅用于安装 `@tauri-apps/cli`）
- PowerShell 7（`pwsh`，运行验证脚本；5.1 会因 UTF-8 无 BOM 导致中文乱码）

## 构建与运行

### 采集服务（需管理员，否则 ETW 会话开不起来）

```bash
dotnet build NetPeek.sln
pwsh -NoProfile -Command "Start-Process 'src\NetPeek.Collector\bin\Debug\net8.0\NetPeek.Collector.exe' -Verb RunAs -WindowStyle Hidden"
```

### UI（普通权限运行）

```bash
cd src/NetPeek.App && npm install          # 首次
cd src-tauri && cargo build
explorer.exe "target\debug\netpeek-app.exe"
```

前端无打包器，`ui/` 下的静态文件由 `tauri.conf.json` 的 `frontendDist` 直接加载。

### 验证脚本

```bash
pwsh -ExecutionPolicy Bypass -File scripts/verify-collection.ps1   # 打印 10 帧真机快照
pwsh -ExecutionPolicy Bypass -File scripts/verify-pause.ps1        # 暂停/恢复链路断言
```

## IPC 协议

- 快照管道 `\\.\pipe\NetPeekCollector`（服务端单向 Out）：帧格式 = 4 字节小端长度前缀 + UTF-8 JSON（`TrafficSnapshot`），推送周期 1000ms。
- 控制管道 `\\.\pipe\NetPeekCollectorControl`（服务端单向 In）：单行 UTF-8 文本命令 `pause` / `resume` / `toggle`，UI 每条命令建一次短连接。

详见 `src/NetPeek.Shared/Protocol/`。

## 状态

端到端链路已在真机跑通：ETW 采集 → 命名管道 → Tauri UI，含反向控制通道。

已完成：ETW 分进程归因（TCP/UDP、IPv4/IPv6、重传单独统计、PID 复用处理）、命名管道推送、托盘常驻、进程表虚拟化、实时速率折线图（uPlot）、排序与搜索、按应用聚合/按进程明细切换、暂停监控、深浅色主题跟随系统。

进度明细、换机环境准备、踩坑记录与待办顺序见 [docs/开发进度.md](docs/开发进度.md)。
