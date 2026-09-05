# NetPeek

轻量 Windows 桌面工具，实时监控**每个应用**的网络流量，按进程归因上传与下载。

- 每秒一帧的进程级速率与累计量，TCP/UDP、IPv4/IPv6 全覆盖，重传单独统计
- 四屏主界面（实时 / 历史 / 外观 / 设置）+ 常驻托盘 + 可拖动的桌面能量球
- 历史按天入库（SQLite，默认留 30 天），可看区间合计与应用排行
- 界面跟随自选背景图取色，或用 AI 生成配色，或手工调令牌

## 为什么要装一个服务

Windows 的 ETW 内核网络会话（`Microsoft-Windows-Kernel-Network`）只有管理员能开。
如果把采集放进 UI 进程，那 UI 就得永远以管理员运行——它要能拖窗、能读你的图片当背景，
不该有这个权限。所以拆成两个进程：

```text
NetPeek.App (Tauri 2, 普通权限)  ←—Named Pipe—→  NetPeek.Collector (.NET 8 服务, LocalSystem)
        UI 渲染 / 历史入库                              ETW 采集 + 分进程聚合
```

采集服务订阅内核网络事件，**按 payload PID**（不是事件头的 PID）聚合字节，
每 1000ms 通过命名管道推一帧快照给 UI；UI 反向用一条控制管道发暂停/恢复。
进程身份键是 `PID + 进程启动时间`，PID 被系统复用时清零重计，不会把新进程的流量接到旧进程账上。

## 安装

生成 MSI（会顺带把采集服务注册成 LocalSystem 自动启动的 Windows 服务）：

```bash
pwsh -File scripts/build-installer.ps1
# 产物：src/NetPeek.App/src-tauri/target/release/bundle/msi/*.msi
```

安装包会自己检测并按需拉取 WebView2，升级时清理旧版本残留。
**注意 MSI 目前没有代码签名**，安装时 SmartScreen 会拦一次。

从 Git Bash 手动调 `msiexec` 会被 MSYS 改写 `/i` `/qn` 这类参数导致挂起，
要装/卸请用 PowerShell 的 `Start-Process -ArgumentList @(...)` 数组传参。

## 从源码开发

### 环境前提

| 依赖 | 用途 |
| --- | --- |
| .NET 8 SDK | 采集服务 |
| Rust 工具链 + Cargo | Tauri 外壳 |
| Node + npm | 只为装 `@tauri-apps/cli` |
| PowerShell 7（`pwsh`） | 跑验证与打包脚本；5.1 也能跑，`scripts/*.ps1` 存的是 UTF-8 带 BOM |

### 采集服务（需管理员，否则 ETW 会话开不起来）

```bash
dotnet build NetPeek.sln
pwsh -NoProfile -Command "Start-Process 'src\NetPeek.Collector\bin\Debug\net8.0-windows\NetPeek.Collector.exe' -Verb RunAs -WindowStyle Hidden"
```

### UI（普通权限）

```bash
cd src/NetPeek.App && npm install          # 首次
cd src-tauri && cargo build
explorer.exe "target\debug\netpeek-app.exe"
```

前端没有打包器：`ui/` 下的静态文件由 `tauri.conf.json` 的 `frontendDist` 直接加载，改完刷新即可。
**也因此 `ui/` 里的任何文件都会被打进安装包**，临时脚手架不要留在那里。

### 验证脚本

前三个会自己提权，结果同时写 `%TEMP%\netpeek-verify-*.log`（提权新窗口关掉后还能读到）。
最后一个要求采集服务**已经**以管理员跑着。

```bash
pwsh -ExecutionPolicy Bypass -File scripts/verify-collection.ps1     # 打印 10 帧真机快照
pwsh -ExecutionPolicy Bypass -File scripts/verify-pause.ps1          # 暂停/恢复链路断言
pwsh -ExecutionPolicy Bypass -File scripts/verify-meta.ps1           # 路径/图标/启动时间字段
pwsh -File scripts/verify-etw-scenarios.ps1                          # 短连接/快速退出/UDP/多会话并存
```

## 目录

```text
src/NetPeek.Shared/       IPC 协议 DTO 与帧格式常量（服务与 UI 共用契约）
src/NetPeek.Collector/    .NET 8 Windows Service（ETW + 聚合 + 命名管道服务端）
src/NetPeek.App/          Tauri 2：src-tauri Rust 外壳（管道客户端、托盘、历史库、主题落盘）
                                   ui   无打包器前端（原生 JS + 自绘 canvas 图表）
scripts/                  验证脚本与 MSI 打包脚本
docs/                     技术选型、执行计划、功能清单、开发进度、UI 规格
```

## IPC 协议

- **快照管道** `\\.\pipe\NetPeekCollector`（服务端单向 Out）：
  帧格式 = 4 字节小端长度前缀 + UTF-8 JSON（`TrafficSnapshot`），周期 1000ms。客户端断开后自动回到监听。
- **控制管道** `\\.\pipe\NetPeekCollectorControl`（服务端单向 In）：
  单行 UTF-8 文本命令 `pause` / `resume` / `toggle`，UI 每条命令建一次短连接，写完即断。

暂停时 ETW 回调直接短路、快照上报 `Status="paused"` 且**不推进累计基线**，
恢复后增量从冻结点继续，不会出现恢复瞬间的巨大尖峰。契约定义见 `src/NetPeek.Shared/Protocol/`。

## 数据存放

都在 `%APPDATA%\com.netpeek.app\`：

| 文件 | 内容 |
| --- | --- |
| `history.db` | SQLite 分钟聚合，主键 `(ts, pid, start_ts)`；保留期默认 30 天，设置里可改，0 = 永久 |
| `theme-config.json` | 主题模式、令牌、三个调节量、AI 提供方配置 |
| `backgrounds/` | 背景图按内容哈希落盘 |
| `netpeek.log` | 历史库的错误日志 |

设置屏有「清空历史」；这个目录的完整路径显示在设置屏检查栏的「关于」里。
卸载只移除服务和 `C:\Program Files\NetPeek\`，不碰这个目录，历史与主题会留下。

## 界面

主窗 1180×720 无边框，底图铺满压暗，四块圆角岛屿浮在上面，中左一片留白只给底图。
导航岛切四屏，岛的位置和大小不变：

- **实时**：进程/应用表（虚拟化）+ 双色速率折线图 + 右侧检查栏（路径、PID、会话时长、近 1 小时曲线、归因说明）
- **历史**：范围胶囊 + 双色日柱状图（超 60 天自动按周聚合）+ 区间合计 + 应用排行
- **外观**：三模式主题——背景图离线取色（默认）/ AI 自适应（需自填 endpoint 与 key，缩略图会离机，要显式同意）/ 手工令牌；可存成命名主题
- **设置**：速率单位、历史保留期、开机自启、暂停采集、服务状态与 ETW 丢事件计数

托盘常驻，右键菜单为「打开主界面 / 打开迷你窗 / 暂停监控 / 退出」，关闭主窗只是隐藏到托盘。
小窗两形态：108×108 能量球（双层环形规 = 下载/上传相对近 60 秒峰值的水位）⇄ 320×300 面板（Top 5 应用）。

界面的规格是 [docs/UI生成提示词.md](docs/UI生成提示词.md) 第 1–3 节，颜色与对比度数值都是算出来的，**该文档是唯一来源，不要改**。

## 已知限制

- **MSI 未签名**，安装会触发 SmartScreen。
- 开发与实测都在 Windows 11 上，**Windows 10 22H2 未验证**。休眠恢复、浏览器大文件下载归因也还是人工待验项。
- 存活时间短于一个快照周期（1s）的进程，**字节归因完整但取不到进程名**，界面显示「(系统/未归因)」，归因覆盖率不计入。
- 主题的 AI 模式要你自己填模型 endpoint 和 key，项目不内置任何服务。
- 焦点避让（背景图显著性检测）未实现。

进度明细、换机环境准备、踩坑记录与待办顺序见 [docs/开发进度.md](docs/开发进度.md)。
