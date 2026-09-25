# NetPeek

轻量 Windows 桌面工具，实时监控**每个应用**的网络流量，按进程归因上传与下载。

- 每秒一帧的进程级速率与累计量，TCP/UDP、IPv4/IPv6 全覆盖，重传单独统计
- 三屏主界面（监控 / 历史 / 设置，外观并入设置）+ 常驻托盘 + 可拖动的桌面能量球
- 历史按天入库（SQLite，默认留 30 天），可看区间合计与应用排行
- 皮肤系统：三套出厂皮肤 + 「跟随背景图」（离线取色，可选 AI 取色）+ 自定义皮肤

## 系统架构

NetPeek 由两个进程组成，通过命名管道通信：

```text
NetPeek.App (Tauri 2, 普通权限)  ←—Named Pipe—→  NetPeek.Collector (.NET 8 服务, LocalSystem)
        UI 渲染 / 历史入库                              ETW 采集 + 分进程聚合
```

**NetPeek.Collector** 是 .NET 8 Windows 服务，以 LocalSystem 运行，订阅内核网络事件并分进程聚合。将采集拆分为独立服务的依据是权限边界：ETW 内核网络会话（`Microsoft-Windows-Kernel-Network`）仅管理员可开启，而 UI 需要拖动窗口、读取用户指定的背景图，不应以管理员权限运行。

采集服务**按 payload PID**（而非事件头的 PID）聚合字节，
每 1000ms 通过命名管道向 UI 推送一帧快照；UI 则通过一条控制管道反向发送暂停/恢复命令。
进程身份键为 `PID + 进程启动时间`，PID 被系统复用时清零重计，避免将新进程的流量计入已退出的旧进程。

## 安装

生成 MSI（会顺带把采集服务注册成 LocalSystem 自动启动的 Windows 服务）：

```bash
pwsh -File scripts/build-installer.ps1
# 产物：src/NetPeek.App/src-tauri/target/release/bundle/msi/*.msi
```

安装包会自动检测并按需获取 WebView2，升级时清理旧版本残留。
**当前 MSI 尚未进行代码签名**，安装时 SmartScreen 会拦截一次。

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

### 采集服务（需管理员，否则无法开启 ETW 会话）

使用 `scripts/dev-collector.ps1`：构建、清理上一次的残留实例、提权后台启动，并在两条命名管道
确实就绪后才判定启动成功。可从普通权限窗口运行，仅启动/停止环节会触发 UAC。

```bash
pwsh -ExecutionPolicy Bypass -File scripts/dev-collector.ps1              # 构建并（重）启动
pwsh -ExecutionPolicy Bypass -File scripts/dev-collector.ps1 -NoBuild     # 跳过构建直接重启
pwsh -ExecutionPolicy Bypass -File scripts/dev-collector.ps1 -Status      # 只看进程/管道/日志尾部
pwsh -ExecutionPolicy Bypass -File scripts/dev-collector.ps1 -Tail        # 启动后跟随日志
pwsh -ExecutionPolicy Bypass -File scripts/dev-collector.ps1 -Stop        # 只停止
```

手工等价操作（脚本异常时的替代方案）：

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

前端没有打包器：`ui/` 下的静态文件由 `tauri.conf.json` 的 `frontendDist` 直接加载，修改后刷新即可生效。
**因此 `ui/` 中的任何文件都会被打入安装包**，请勿在该目录遗留临时文件。

### 验证脚本

前三个会自动提权，结果同时写入 `%TEMP%\netpeek-verify-*.log`（提权新窗口关闭后仍可读取）。
最后一个要求采集服务**已**以管理员身份运行。

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
卸载仅移除服务和 `C:\Program Files\NetPeek\`，不会删除该目录，历史与主题数据将予以保留。

## 界面

主窗 1180×720 无边框，左侧竖排导航（rail）切三屏，导航与顶栏的位置和大小不变：

- **监控**：进程/应用表（虚拟化）+ 双色速率折线图 + 右栏（今日、近 30 天、选中项详情）
- **历史**：范围胶囊 + 双色日柱状图（超 60 天自动按周聚合）+ 区间合计 + 应用排行
- **设置**：左分区导航 + 右表单。**外观并入这一屏**（皮肤即外观）：三套出厂皮肤（朴素 / 浅色 / 琥珀）、
  「跟随背景图」（从图片离线取色；AI 取色是它的高级选项，需自填 endpoint 与 key，缩略图会离机、要显式同意）、
  以及在当前皮肤上改令牌另存的自定义皮肤；另有速率单位、历史保留期、开机自启、暂停采集、服务状态与 ETW 丢事件计数

托盘常驻，右键菜单为「打开/隐藏主界面、打开/关闭迷你窗、暂停/恢复监控、退出」——前三项文案跟着真实状态翻转，
tooltip 也会写清「已暂停监控 / 采集服务未连接」；关闭主窗只是隐藏到托盘。
小窗两形态：108×108 能量球（双层环形规 = 下载/上传相对近 60 秒峰值的水位）⇄ 320×300 面板（Top 5 应用）。

界面的**结构与排印**规格是 [docs/UI生成提示词.md](docs/UI生成提示词.md) 第 1–3 节（浮岛构图、留白、字阶、语义色分工）。

**材质与可读性数值不再以那份文档为准**：它写的是「岛屿不透明度下限 0.82 / 默认 0.88 + WCAG 4.5:1」，
而实现已改为**面板透镜 + 玻璃契约**（滑杆下限 0.30、默认 0.45，判据是 APCA 的 Lc）——
两者并非同一套模型，该表以纯黑压暗计算的对比度在归一化玻璃上并不成立。
现行来源是 `ui/theme.js` 的常量与注释（`GLASS_MID_MAX_DARK` / `LENS_BODY_LC` / `GLASS_HARDEN_LC`），
由 `scripts/ui-tests/theme.test.mjs` 与 `scripts/preview-v2.mjs` 的像素审计双向锁定；
相关背景与迭代原因见 [docs/开发进度.md](docs/开发进度.md) §45–§46。

## 已知限制

- **MSI 未签名**，安装会触发 SmartScreen。
- 开发与实测都在 Windows 11 上，**Windows 10 22H2 未验证**。休眠恢复、浏览器大文件下载归因也还是人工待验项。
- 存活时间短于一个快照周期（1s）的进程，**字节归因完整但取不到进程名**，界面显示「(系统/未归因)」，归因覆盖率不计入。
- 主题的 AI 模式需自行填写模型 endpoint 和 key，项目不内置任何服务。
- 焦点避让（背景图显著性检测）未实现。

进度明细、环境迁移准备、问题记录与待办顺序见 [docs/开发进度.md](docs/开发进度.md)。
