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
docs/                     技术选型、执行计划、功能清单、UI 提示词
```

## 环境前提

- .NET 8 SDK（后端必需）
- Node 24 + npm（前端必需）
- Rust 工具链 + Cargo（Tauri 必需，当前未装）

## 构建与运行

### 后端（可直接运行）

```bash
dotnet build NetPeek.sln
# 调试运行（前台控制台）：
dotnet run --project src/NetPeek.Collector
# 安装为 Windows 服务：
# sc create NetPeekCollector binPath= "D:\NetPeek\src\NetPeek.Collector\bin\Debug\net8.0\NetPeek.Collector.exe"
```

### 前端（需先安装 Rust）

```bash
cd src/NetPeek.App
npm install
npm run dev      # 或 npm run build
```

> 首次 `npm run dev` 前需安装 Rust：`winget install Rustlang.Rustup`，然后重启终端使 cargo 生效。

## IPC 协议

命名管道 `\\.\pipe\NetPeekCollector`，帧格式 = 4 字节小端长度前缀 + UTF-8 JSON（`TrafficSnapshot`），推送周期 1000ms。详见 `src/NetPeek.Shared/Protocol/`。

## 状态

- 后端骨架已编译通过（0 警告 0 错误）。
- ETW 数据源待接入（当前用 `StubSnapshotSource` 假数据跑通链路）。
- UI 为占位实现，命名管道客户端待接入。
