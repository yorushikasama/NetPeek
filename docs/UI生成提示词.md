# NetPeek UI 生成提示词

> **2026-09-04 第二版重写：换设计方向。** 上一版是 Fluent 密集数据工具 —— 原生标题栏、14 行满幅表格、
> 灰描边平面板、底图只从外框缝隙里透一点。方向定错了：那是系统工具的语言，不是这个产品的语言。
> 这一版改成**浮岛式**：底图是画面主角，四块圆角岛屿浮在它上面，中间留一大片完整可见的底图。
> 材质从「灰描边 + 黑投影」换成「暖色亮边 + 同色外发光」，数字换等宽字族并放大，图表带坐标标注，
> 应用图标用真实彩色图标。取舍与代价写在 1.3 和第 7 节，不含糊。
>
> **第 1–3 节是页面结构与样式的设计依据**，实现 `src/NetPeek.App/ui/` 时以此为准；
> **第 4–6 节是生成视觉参考图的提示词**。功能范围以 [功能清单.md](功能清单.md) 为准，
> 三模式主题系统见 [技术选型.md](技术选型.md) 4.3。

## 0. 这份文档怎么用

1. 先读第 1–3 节，确认结构与令牌没有异议。
2. 用第 4 节提示词生成参考图，按第 6 节清单筛掉不合格的成图。
3. 参考图只用来确认**构图关系、密度、配色与材质**，不当视觉稿交付；图上的文字与数字一律不可信（第 8 节）。
4. 实现时数值回到第 2–3 节的规格表，不从图上量。

## 1. 设计前提

### 1.1 使用场景

一个 Windows 开发者，晚上双屏工作，右屏常驻 NetPeek 几个小时，左屏在写代码。
他大部分时间只用余光扫一眼总速率；速率异常时才认真看一眼「是谁在占带宽」，找到后立刻切回去。
偶尔第二天想知道「上周哪天下载了 40 GB」。

三个推论：

- **深色是默认，不是风格选择。** 常驻数小时、在暗环境里、处于视野边缘，亮底面板等于眼角一盏灯。
- **答案只需要前几行。** 「谁在占带宽」的答案是排序后的第 1–3 行，不是完整的进程清单。
  上一版为了 14 行满幅表格牺牲掉整张底图，服务的是「通读全表」这个更罕见的场景。
- **界面必须安静。** 数据每秒刷新一次，任何跟着每帧数据出现的动效都是每秒闪一次的噪声。

### 1.2 三条不可协商的规则

1. **底图是画面主角。** 界面中央永远留一整片没有任何 UI 的区域给它。新元素要先回答
   「它凭什么占掉底图的一块」，而不是「它值几行表格」。
2. **下载永远暖橙 `#f0913f`，上传永远钢蓝 `#7fa8c9`。** 图表、表格、发光、能量球、历史柱状图一致，
   不因组件改变，也不因主题模式改变：自适应主题可以调明度，不能换语义。
3. **速率用自动单位（B / KB / MB / GB）加等宽字族。** 不固定 Mbps，不让数字宽度随数值跳动。

### 1.3 这次换方向放弃了什么

诚实记账，避免以后又绕回来：

| 上一版 | 这一版 | 代价 |
| --- | --- | --- |
| 表格默认 14 行可见 | 默认 5 行 | 通读全表需要**上拉展开底部岛**（见 2.5），多一个动作 |
| Windows 11 原生标题栏 | 无边框自绘（`decorations: false`） | 拖动、双击最大化、圆角与投影都要自己实现；Win+方向键贴靠仍可用 |
| 面板圆角上限 10 | 岛屿 16、外框 20 | 视觉更软，与「系统工具」的观感拉开距离 |
| 两张图（总速率 + 选中项速率） | 三张（总带宽 60s / 选中项 60s / 选中项 30 天） | 检查栏变长，但每张图各答一个问题，不重复 |
| 全局压暗 0.45 | 0.30 | 底图看得清了，代价是岛屿不透明度下限从 0.75 提到 0.82（实测见 3.2） |
| 独立页脚岛 | 取消，信息挂到顶栏胶囊与检查栏 | 少一块岛，构图更干净 |
| 取不到图标用首字母占位 | 默认真实彩色应用图标 | 需要从 exe 提取 HICON 并缓存，取不到时才回退首字母 |

上一版仍然成立、这一版继续保留的判断：不要重复表格前几行的卡片带；一张图只答一个问题；
下载/上传语义色全局唯一；所有文字过 4.5:1 且不靠成图取样判断。

## 2. 页面结构

### 2.1 浮岛构图

窗口 1180×720，无系统边框。底图铺满整窗并压暗 30%，四块圆角岛屿浮在上面，
**中间偏左留出 680×356 的一整片区域，上面不放任何 UI**。外边距与岛屿间距都是 14。

```text
┌──────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ TOP BAR ISLAND                                 1152 x 58 │ │
│ └──────────────────────────────────────────────────────────┘ │
│ ┌────┐                              ┌────────────────────┐   │
│ │  N │                              │ INSPECTOR ISLAND   │   │
│ │  A │  artwork breathes            │ 380 x 356          │   │
│ │  V │  680 x 356                   │ live 60s           │   │
│ │ 64 │  no UI on it                 │ + 30-day usage     │   │
│ └────┘                              └────────────────────┘   │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ DATA ISLAND                                   1152 x 250 │ │
│ │  bandwidth 448  |  process table 639, 5 rows             │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

坐标（左上原点）：顶栏 14,14 / 导航 14,86（64×268）/ 检查栏 786,86（380×356）/ 数据岛 14,456（1152×250）。
留白区 92,86 起，680×356。

**留白区的位置不是固定的**，它由 4.3 节的显著性检测决定：岛屿排布默认让开底图主体，
主体在右侧的图会把检查栏移到左侧、导航岛移到右侧，镜像整套布局。留白区就是主体所在的那片。

### 2.2 顶栏岛（1152×58）

内边距左右 18，一行两组，用 `grid-template-columns: auto 1fr auto` 分区。

左组（世界的状态）：

| 元素 | 规格 |
| --- | --- |
| 标记 + 字标 | 20px 琥珀色心跳折线图形 + 「NetPeek」17px/600 |
| 状态胶囊 | 6px 圆点 + 「监控中」13px，`radius: 999`，底 `--surface-hi`，内边距 5×12 |
| 总下载 | ↓ 18px + 数字 30px 等宽 600 + 单位 14px；全部 `--down`，单位降到 75% 不透明度 |
| 总上传 | ↑ 同上，全部 `--up` |
| 今日合计 | 标签「今日合计」13px `--text-muted` + 数值 14px 等宽 `--text` |

右组（控件）：视图切换双档胶囊（按进程 / 按应用，高 28，当前档底 `--surface-hi`、文字 `--down`）｜
搜索胶囊（240×34，`radius: 999`，放大镜 14px + 占位符「搜索应用 / PID」13px）。

**顶栏不放外观和设置入口。** 现在这两个按钮在顶栏（`index.html:22-23`），而导航岛里已经有这两项 ——
同一个入口出现两次，用户得先判断两者是不是同一个东西。顶栏只留跟「看数据」直接相关的控件。

三条实现注记：

- **参考图里状态点是琥珀色，实现时必须改成绿色。** 琥珀已经被「下载」占用，
  状态点再用琥珀就是两个含义抢一个颜色。异常时胶囊整体转 `--error` 并把文案展开成「服务异常 · 需管理员权限」。
- **ETW 丢事件**不另开位置：状态胶囊右侧贴一个 5px `--warn` 圆点，悬浮显示「事件丢失 N 条 · 实际用量可能高于显示值」。
- 顶栏是窗口的拖动区（无边框窗口自绘拖动），双击最大化要自己接。

### 2.3 导航岛（64×268）

四项纯图标，无文字标签 —— 岛宽只有 64，塞文字会把图标挤小。每格 60×60，图标 20px 居中，
悬浮出 tooltip（实时 / 历史 / 外观 / 设置）。

当前项三件事同时发生：格内底色转 `--surface-hi`、图标转 `--down`、岛内左缘 4px 处出现 3×20 圆角指示条。
指示条只用于导航当前项，不用于表格行。

图标族统一用 Lucide 线性图标（技术选型 4.2 已定），线宽 1.6，不混用填充图标。

### 2.4 检查栏岛（380×356）

内边距 16，内容区 348×324，四段之间各一条 1px `--line` 分隔线。

**选中一行时（详情态）**

| 段 | 高 | 内容 |
| --- | --- | --- |
| 头部 | 76 | 44px 真实应用图标（`radius: 10`）+ 名称 17px/600 + 完整路径 12px `--text-muted` 单行截断（悬浮出全路径）+ 「PID 15872 · 会话 01:32:47」12px 等宽 |
| 累计 | 52 | **两行**：「累计下载 15.74 GB」`--down`、「累计上传 2.31 GB · 重传 1,204」`--up` / `--text-muted`；标签 11px，数值 15px 等宽 |
| 实时用量 | 98 | 标题行「实时用量」14px，右侧 `▼ 2.43 MB/s`（`--down`）· `▲ 0.68 MB/s`（`--up`）14px 等宽；下方 76px 双线图 |
| 30 天下载 | 98 | 标题行「30 天下载」14px，右侧「合计 15.74 GB」14px 等宽；下方 76px 琥珀柱状图，30 根柱，柱宽 6 间距 3 |

累计段**必须是两行**。上一版生成的参考图把它画成了一个数字，那就丢掉了「下载和上传各自多少」这个信息 ——
而这正是累计存在的理由。重传跟在上传后面，因为它是上传的一部分但不该混进上传量（归因规则见下）。

**没有选中时（总览态）** 头部换成「总览 · 已采集 02:14:33」，累计段换成全局累计，
实时用量段换成字段组（归因覆盖率 / 采集服务状态 / ETW 丢事件 / 历史库占用），30 天下载段统计全局。
「归因说明」不另设入口，挂在总览态的归因覆盖率数值上，点开展开说明（payload PID / 忽略 Event 18 / 重传独立统计）
—— 解释放在被解释的数字旁边，比藏在折叠项里有用。

**图表坐标规格**（上一版漏了，成图和实现都要有）：

- y 轴三档标注：0、中位、上限，11px `--text-muted`，靠左占 52px；绘图区宽 296。
- x 轴两端标注：实时图「60 秒前」「现在」；30 天图两端日期（「4 月 25 日」「5 月 24 日」）。
- 横向虚线网格 2 条，用 `--line`；**不画纵向网格**。
- 线宽 2，无数据点圆点，线下方同色 12% 渐变填充到透明。
- 检查栏这张 30 天图只画下载，双色分组柱在 296px 宽里挤不开；上传去历史屏看。

三张图各答一个问题，互不重复：底部岛答「总带宽这一分钟怎么走的」，检查栏「实时用量」答「这个应用这一分钟怎么走的」，
「30 天下载」答「这个应用一个月用了多少」。

### 2.5 数据岛（1152×250）与密集模式

内边距 16，内容区 1120×218，左右分区：带宽图 448 ｜ 间距 16 ｜ 1px `--line` 竖分隔线 ｜ 间距 16 ｜ 进程表 639。

**左：实时带宽**。标题行 22px（「实时带宽」14px + 图例 `▼ 下载` `▲ 上传` 11px），下方 164px 双线图，
坐标规格同 2.4，y 轴占 52，绘图区 396。

**右：进程表**。表头 32，行高 36，可见 5 行，第 6 行露出 6px 作为可滚动的提示。

| 列 | 宽 | 内容 | 对齐 |
| --- | --- | --- | --- |
| 应用 | 287 | 22px 真实彩色应用图标 + 名称 14px；应用视图在名称后加 `×N` | 左 |
| PID | 88 | 13px 等宽 `--text-muted`；应用视图显示进程数 | 右 |
| ↓ 下载 | 132 | 15px 等宽 `--down` | 右 |
| ↑ 上传 | 132 | 15px 等宽 `--up` | 右 |

只有四列。上一版的活动 / 占比 / 累计 / 重传四列全部下岛：
**占比**改成整行背景一条极淡的琥珀渐变（从左起，宽度＝该行下载速率 ÷ 当前总下载速率，
`rgba(240,145,63,0.06)` 渐隐到透明），不占列宽；**累计与重传**只在检查栏出现；
**活动火花线**取消 —— 左边已经有一张 396px 宽的带宽图，一个 64px 的缩略版没有新信息。

**不画横向分隔线。** 靠 36px 行高、行背景和悬浮态区分行。满格横线是上一版那种系统工具表格的做法，
这套构图里它会把岛屿切成一叠格子。

行状态：悬浮 → 底色 `--surface-hi`；选中 → 底色 `--surface-hi` + 应用名字重 600 + 检查栏跟随，
不加行首色条。排序点列头，默认「下载」降序，箭头用 `--down` 且只标当前列。

**密集模式**：拖数据岛顶边（或双击顶边）把它向上展开到 y=86，高 620，此时留白区让位，
表格可见 15 行，左侧带宽图跟着变高。上一版「14 行」的诉求由这个显式动作满足，
而不是让默认状态永久牺牲底图。展开状态持久化。

### 2.6 历史屏

**屏与屏之间只换岛内内容，不换岛的位置和大小。** 历史屏沿用同一套四岛骨架：顶栏岛与导航岛不变，
检查栏岛和数据岛换内容，留白区仍然是底图。

数据岛（14,456 · 1152×250）：

- 首行 34：时间范围胶囊组（近 7 天 / 近 30 天 / 近 90 天 / 自定义…），当前档底 `--surface-hi`、
  文字 `--down`；右端「导出 CSV」幽灵按钮。
- 下方 172：双色分组日柱状图。y 轴三档占 52，绘图区 1068；30 组柱 = 下载柱 13 + 组内间距 3 +
  上传柱 13 = 29，组间距 6，组距 35。x 轴只标两端日期和每个月初那一根。
- **近 90 天档自动按周聚合成 13 组柱** —— 90 组 3px 宽的柱既读不出也点不中；
  x 轴改标每根柱的周起始日，胶囊右侧补一行 11px「按周聚合」。

检查栏岛（786,86 · 380×356）：

- 未选中某一天：区间合计（下载 / 上传 / 总量，三个 20px 等宽数字）+ 区间内应用排行 Top 8
  （32px 行，18px 真实图标 + 名称 + 下载量，行背景琥珀渐变同 2.5）。
- 点柱选中某天：头部换成「5 月 18 日 · 周日」+ 当日合计，排行换成当日 Top 8，
  柱状图上该组加 2px `--down` 顶帽标出当前选中。点空白处取消选中。

**这一屏不放折线图。** 历史要回答的是「哪天用得多」，柱状图直接可比、可点；
折线只是把同一份日聚合数据画得更含糊。

### 2.7 外观屏与设置屏（2026-09-05 v2 重设计）

> 历史：v1 这两屏曾是覆盖层（把被调界面压暗 45% 再调色），后改为屏。v2 在「屏」的骨架上
> 去掉了互斥的三模式，统一为「生成器 + 微调」模型，本节为现行定义。

**数据模型前提**：`state.current` 是唯一事实源（令牌 + 材质 + 背景路径）。换壁纸自动取色、
AI 生成、预设起步都是往 current 写令牌的**生成方式**；高级色板与材质滑杆编辑的也是 current。
来源标签（取色 / AI / 定制）只是列表展示，不影响哪些控件可用。

**外观屏（数据岛）**，自上而下单列：

1. **壁纸条**：内置壁纸 ×3（缩略图）＋「＋自选」＋「无」。选中项琥珀描边 + 角标 ✓。
   换壁纸立即重新取色（来源=取色）；「无」同时关掉留白区的邀请提示（用户已做决定，不再问）。
2. **材质**：三根滑杆并排一行（岛屿不透明度 0.82–1.00 默认 0.88 / 全局压暗 0.20–0.60 默认 0.30 /
   背景模糊 0–40 默认 24；范围是 3.2 的实测结果）。滑杆**任何时候只改材质**，不重生成令牌；
   无背景时三根滑杆禁用并显示说明（无背景时它们本来就没有效果）。
3. 「无背景时跟随系统深浅色」开关（仅无背景时可见；浅色系统用浅色预设）。
4. **高级折叠区**（details，默认收起）：手动微调语义色开关（开启后 10 色板任何来源可编辑，
   下载/上传保持语义锁定）＋三个预设按钮（直接覆盖当前语义色）＋AI 自适应（接口地址 / API Key /
   模型三项并排、授权勾选、生成按钮）。AI 同图按缩图像素哈希缓存复用，只上传 ≤512px 缩略图，
   20s 超时自动回退离线取色。

**外观屏（检查栏）**：当前主题卡（双色 chip + 名称 + 来源与材质摘要）｜对比度校验结果
（「✓ 全部达标」或「N 项已校正」，校验即引擎里的 WCAG 4.5:1 自动校正，这里只是把它变成
用户可见的质量信号）｜保存当前为主题｜主题列表（应用 ✓ / 内联重命名 ✎ / 删除 🗑；
删除当前主题立即回落 default）。留白区的实时预览收益不变：其余三岛当场变。

**设置屏**：数据岛 = 三张分组卡片（**常规**：速率单位 / 登录自启 / 未归因流量；
**历史数据**：保留周期 / 库占用 / 清空历史；**采集服务**：暂停采集 + 权限说明），
列间分隔线。检查栏 = **服务健康**（采集服务状态 / ETW 丢事件 / 数据目录——只读读数归检查栏，
可操作项归数据岛）＋关于＋归因边界。破坏性动作（清空历史）维持原地二次确认。

**留白区**：壁纸主入口在外观屏的壁纸条；无背景且未关闭提示时，右下角一行小字
「这里给壁纸留了位置 · 挑一张」，用户点过「无」后永久消失。首启默认启用内置壁纸 1
（`ui/wallpapers/`，占位图由 `scripts/generate-wallpapers.ps1` 生成），浮岛首屏即完整。

### 2.8 空态与异常态

产品的可信度大半在这几个状态上。每个状态都要说清楚**发生了什么**和**下一步点哪里**，
不要只显示「暂无数据」。

| 状态 | 顶栏胶囊 | 数据岛表格区 | 带宽图 |
| --- | --- | --- | --- |
| 服务未连接 | `--error`，文案展开成「服务异常 · 需管理员权限」 | 居中三行：标题「采集服务未连接」15px、一行说明 13px、两个按钮「重试连接」「以管理员身份重启服务」 | 保留坐标轴，不画线 |
| 正在连接 | `--warn`「连接中」 | 5 行 36px 骨架条块（`--surface-hi`），不用转圈 | 保留坐标轴 |
| 已连接无流量 | `--ok`「监控中」 | 一行 13px `--text-muted`「当前没有进程在收发数据」 | 画一条贴底的平线，不留空白 |
| 已暂停 | `--warn`「已暂停」 | 数字停在最后一帧并降到 60% 不透明度 | 最后一段转虚线 |
| ETW 丢事件 | 胶囊右侧 5px `--warn` 圆点 | 不变 | 不变 |

两条细节：

- **权限不足读不到进程路径**时，名称与速率照常显示，路径位置写「无法读取（权限不足）」，
  不要留空 —— 空白让人以为是 bug，写清楚让人知道是权限。
- **无背景图**时岛屿退回不透明 `--surface` 并关掉 `backdrop-filter`（没有底图，模糊白耗 GPU）；
  留白区放一句 13px 提示 + 「选择背景图」按钮。这是**唯一允许在留白区放 UI 的情况**，
  因为此时那里没有底图可保护。

### 2.9 桌面小窗

两形态：能量球（常驻）与迷你窗（点球展开）。

**能量球**。窗口 108×108，球 92×92 居中，**四周留 8px 给外发光** ——
现在窗口 100×100 里放 100px 的球（`mini.css:23-26`），发光被窗口边缘裁掉。

- 底：`--surface` 0.88 + 1px `--edge` 亮边 + 外发光 `0 0 20px var(--glow-warm)`。
  去掉现在的 `radial-gradient(#2b3542 → #14181f)` 冷色球体渐变 —— 那是个塑料按钮的质感，
  和主界面的暖色岛屿不是一套材质。
- 外圈 4px 琥珀色环形进度：填充比例 = 当前下载速率 ÷ 近 60 秒峰值。内侧 2px 钢蓝环表示上传。
  环形规是这个尺寸下唯一能同时显示「量」和「相对水位」的形式。
- 中心：↓ 数字 20px 等宽 600 `--down` + 单位 10px，下一行上传 11px `--up`。
- 暂停时环变虚线、数字降到 60% 不透明度，不再盖一层半透明遮罩加 30px 的 ⏸
  （`mini.css:59-69` 的做法把唯一的数字整个糊掉了）。

**迷你窗** 320×300，圆角 16（现在是 10）：

| 段 | 高 | 内容 |
| --- | --- | --- |
| 头 | 40 | 「NetPeek」13px/600 + 状态圆点 + 收起 + 关闭；整段是拖动区 |
| 总量 | 52 | ↓ / ↑ 两个 20px 等宽数字，语义色 |
| 列表 | 剩余 | Top 5，行高 32，18px 真实图标 + 名称 12px + 速率 11px 等宽，行背景琥珀渐变同 2.5 |
| 脚 | 44 | 两个按钮：暂停 / 主界面 |

**「退出」从迷你窗移到托盘菜单。** 现在三个等宽按钮里「退出」和「主界面」一样醒目
（`mini.html:36-38`），误点直接把采集停掉；托盘右键菜单才是退出的常规位置。

小窗跟随主题令牌，但**不做 `backdrop-filter`** —— 透明窗口后面没有网页内容可采样，
Windows 上这一项在透明窗口里行为不一致，靠 0.88 的底色和外发光已经够。

## 3. 样式令牌

### 3.1 颜色

用 OKLCH 定义、编译成 sRGB 落到 CSS 变量。下表的十六进制值和对比度都是算出来的，不是估的：
OKLab → LMS' → 线性 sRGB → gamma 编码，对比度按 WCAG 2.1 相对亮度。

| 令牌 | OKLCH | sRGB | 用途 |
| --- | --- | --- | --- |
| `--bg` | `0.190 0.010 255` | `#111418` | 无背景图时的窗口底 |
| `--surface` | `0.220 0.010 60` | `#1e1a16` | 岛屿底色（有背景图时按 `--island-op` 半透明） |
| `--surface-hi` | `0.285 0.012 60` | `#2f2924` | 悬浮 / 选中 / 当前档胶囊，不透明 |
| `--text` | `0.955 0.012 70` | `#f6efe8` | 主文字、数字 |
| `--text-muted` | `0.740 0.020 65` | `#b4a99e` | 标签、单位、坐标标注 |
| `--down` | 语义锁定 | `#f0913f` | 下载 |
| `--up` | 语义锁定 | `#7fa8c9` | 上传 |
| `--ok` | `0.760 0.130 150` | `#6fc884` | 监控中 |
| `--warn` | `0.820 0.130 85` | `#ebbd57` | 暂停、丢事件 |
| `--error` | `0.720 0.160 25` | `#f97770` | 服务异常 |

`--error` 是从现有实现的 `#e14b3a`（`styles.css:12`）改上来的。旧值在窗口底 `#111418` 上是 4.63:1 勉强过关，
但服务异常文案实际出现的位置是**面板**：在 `--surface` 上 4.34、在 `--surface-hi` 上 3.60、
在半透明岛屿压着底图亮部时 3.01 —— 不合格的三种情况恰好覆盖了它全部的出现位置。
`#f97770` 在同样四种底上分别是 6.51 / 5.40 / 4.52，加窗口底 6.95。

**分隔线和描边不用深色令牌，用低透明度白色：**

| 令牌 | 值 | 亮部岛对比 | 暗部岛对比 |
| --- | --- | --- | --- |
| `--line` | `rgba(255,255,255,0.10)` | 1.37 | 1.34 |
| `--stroke` | `rgba(255,255,255,0.18)` | 1.75 | 1.76 |

原因是实测出来的：岛屿的合成底色随底图明暗浮动，而深色描边跟着反向失效。
现有实现的 `--border: #2a2f38` 描在岛屿上，底图暗部有 1.30 的对比，到底图纯白区域塌成 **1.12**；
再亮一档的深色（`#423c37`）在暗部有 2.06，在亮部只剩 **1.04 —— 彻底消失**。
低透明度白色在两种极端下几乎一致（1.37 / 1.34），因为它和底色一起浮动。
现有实现里满屏的 `1px solid var(--border)` 在半透明岛屿上是错的材质。

暖色两项（数值见 3.2）：`--edge` `rgba(240,145,63,0.26)` 亮边、`--glow-warm` `rgba(240,145,63,0.10)` 外发光。

### 3.2 岛屿材质

```css
.island {
  background: color-mix(in srgb, var(--surface) calc(var(--island-op) * 100%), transparent);
  backdrop-filter: blur(var(--blur));
  border: 1px solid var(--edge);
  border-radius: 16px;
  box-shadow: 0 0 24px var(--glow-warm), 0 6px 20px rgba(0, 0, 0, 0.28);
}
```

四个变量：`--island-op` 0.88、`--blur` 24px、`--scrim` 0.30、圆角 16。
全局压暗是窗口级的一层 `rgba(0, 0, 0, var(--scrim))`，压在底图上、岛屿下。
用**纯黑**而不是现有实现的 `rgba(8,10,14,0.35)`：下面那张表就是按纯黑算的，
带色偏的压暗层会让实测值和实现值对不上，而这层的作用只是降亮度，不需要带色相。

**实测对比度**（`--scrim` 0.30；最坏情况取底图纯白区域，压暗后 `#b3b3b3`）：

| 岛屿不透明度 | 合成底色 | `--text` | `--text-muted` | `--down` | `--up` | `--error` |
| --- | --- | --- | --- | --- | --- | --- |
| 0.78 | `#3f3c39` | 9.62 | 4.75 | 4.61 | 4.35 ✗ | 4.12 ✗ |
| **0.82（下限）** | `#393632` | 10.55 | 5.21 | 5.05 | **4.78** | 4.52 |
| **0.88（默认）** | `#302c29` | 12.14 | 6.00 | 5.82 | 5.50 | 5.20 |
| 1.00 | `#1e1a16` | 15.17 | 7.50 | 7.27 | 6.87 | 6.51 |

底图暗部（`#202020` 压暗后 `#161616`）在 0.82 时最坏也有 6.57，不是约束项。
**约束项是 `--up` 和 `--error` 落在底图最亮处**，0.78 就已经不合格 —— 这是滑块下限定在 0.82 的全部理由。

`--edge` 的 0.26 也是选出来的：琥珀叠在 `#393632` 的岛屿上，
0.20 只有 1.40 的对比（看不出是条边），0.32 到 1.74（开始像描了个橙框），0.26 是 1.57。

### 3.3 字阶

两个字族，界面文字一族、数字一族：

```css
--font-ui:   "Segoe UI Variable Text", "Segoe UI", system-ui, "Microsoft YaHei", sans-serif;
--font-num:  "Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, monospace;
```

固定像素梯度，不用 `clamp()` 流体字号 —— 窗口尺寸固定、DPI 固定，流体字号在这里只带来不确定。

| px | 字重 | 字族 | 用在哪 |
| --- | --- | --- | --- |
| 30 | 600 | 等宽 | 顶栏总下载 / 总上传 |
| 20 | 600 | 等宽 | 检查栏合计、历史区间合计、迷你窗总量 |
| 17 | 600 | 界面 | 字标、检查栏应用名 |
| 15 | 500 | 等宽 | 表格速率 |
| 15 | 600 | 界面 | 空态标题 |
| 14 | 400 | 界面 | 表格应用名、段标题、图例 |
| 13 | 400 | 界面 | 状态胶囊、按钮、搜索占位符 |
| 13 | 400 | 等宽 | PID |
| 12 | 400 | 界面 | 路径、说明、次要字段 |
| 11 | 400 | 等宽 | 坐标标注、单位 |

**所有数字走等宽字族**，包括速率、PID、日期、坐标标注，一律带 `font-variant-numeric: tabular-nums`。
理由很实际：每秒刷新一次的数字如果字宽随字形变化，整列每秒抖一次。

11px 是下限，不再往下。上一版最小的 11px 用在密度最高的表格里，是全屏最难读的一处。

### 3.4 间距、圆角、发光

间距梯度 4 / 6 / 8 / 12 / 14 / 16 / 18 / 24。窗口外边距与岛屿间距都是 14，岛内边距 16（顶栏左右 18）。

圆角五档：窗口外框 20 ｜ 岛屿 16 ｜ 岛内块（缩略图、图标、骨架条）10 ｜ 控件（按钮、色块）8 ｜ 胶囊 999。
20 的外框圆角要求主窗设 `transparent: true` + `decorations: false`；
现在 `tauri.conf.json` 只给小窗设了 `transparent`，主窗得补上，否则圆角画不出来。

**亮边和外发光同时用，这是这一版的核心材质。** 上一版写过「描边或投影，二选一，不要既描边又加大投影」，
那条针对的是**深色细描边 + 黑色大投影**的组合 —— 它读作「一张浮在纸上的空框」。
这里是暖色亮边 + 同色低透明外发光 + 一层很浅的黑投影定位，三者叠加读作「一块发着光的实体」。
这条禁令在这一版被显式推翻，不是忘了。

| 用处 | box-shadow |
| --- | --- |
| 岛屿 | `0 0 24px var(--glow-warm), 0 6px 20px rgba(0,0,0,0.28)` |
| 能量球 | `0 0 20px var(--glow-warm)` |
| 悬浮态 | 不加发光（每秒刷新的表格里，跟随鼠标的发光会一直闪） |

### 3.5 交互状态

每个可交互组件都要有完整的状态集，不许只做一半。

| 组件 | 默认 | 悬浮 | 键盘焦点 | 按下 | 禁用 | 选中 / 当前 |
| --- | --- | --- | --- | --- | --- | --- |
| 图标钮 32×32 | 透明底，图标 `--text-muted` | 底 `--surface-hi`，图标 `--text` | 焦点环 | 底色再深 4% | 40% 不透明度，不响应 | — |
| 胶囊按钮 | 1px `--stroke` | 边框转 `--down` 60% | 焦点环 | 下移 0，底色加深 | 40% 不透明度 | 底 `--surface-hi`，文字 `--down` |
| 输入 / 搜索 | 1px `--stroke` | `--stroke` 提到 0.26 | 边框转 `--down`，不叠焦点环 | — | 40% 不透明度 | — |
| 表格行 | 透明 | 底 `--surface-hi` | 内嵌焦点环 | — | — | 底 `--surface-hi` + 名称 600 |
| 滑块 | 轨道 `--stroke`，把手 `--down` | 把手放大到 1.1 | 焦点环 | — | 40% 不透明度 | — |
| 导航项 | 图标 `--text-muted` | 图标 `--text` | 焦点环 | — | — | 底 `--surface-hi` + 图标 `--down` + 3×20 指示条 |

焦点环统一 `outline: 2px solid var(--down); outline-offset: 2px`。
**不许 `outline: none` 而不给替代样式** —— 键盘要能走完整个界面。

加载态用骨架条块，不用转圈；错误态用 `--error` 文案加一个可点的重试，都在 2.8 定好了。

### 3.6 动效

时长三档：150ms（悬浮、焦点、胶囊切换）/ 200ms（岛内内容切换、检查栏详情↔总览）/
260ms（密集模式展开）。曲线统一 `cubic-bezier(0.2, 0, 0, 1)`。

- **数字不做补间。** 数据每秒一帧，给它套 300ms 的滚动补间等于永远在滚。直接替换。
- 图表新点从右侧进入、整条线左移一格，200ms 线性；不做整条曲线的形变重绘。
- 唯一一处「装饰性」动效：**从静默跨到有流量的那一刻**，对应岛屿的外发光在 300ms 内涨一次再落回
  （`--glow-warm` 0.10 → 0.18 → 0.10）。它传达的是状态跨越，**只在跨过边界时触发一次，不跟每帧数据**；
  速率持续变化时发光不动。
- 没有入场编排。窗口打开就是最终状态，不做逐岛淡入 —— 用户开窗是为了看速率，不是看动画。
- `prefers-reduced-motion: reduce` 时所有过渡降到 0ms，发光脉冲不做。

### 3.7 这一版的禁止项

1. 在留白区放任何 UI（唯一例外是无背景图态，见 2.8）。
2. 在半透明岛屿上用深色描边（现有实现的 `--border: #2a2f38` 那一类）—— 底图亮部实测只剩 1.12 对比。
3. 满格横向分隔线的表格。
4. 岛屿不透明度低于 0.82，或全局压暗低于 0.20。
5. 用琥珀表示除「下载」以外的任何东西：服务状态点、警告、当前选中都不许借用。
6. 数字用非等宽字族，或把速率单位固定成 Mbps。
7. 任何跟着每帧数据走的动效：数字补间、持续呼吸、跟随鼠标的发光。
8. 用模态框做二次确认（原地确认，见 2.7）。
9. 一张图去回答另一张图已经回答过的问题。
10. 重复表格前几行内容的卡片带。
11. `outline: none` 且不给替代焦点样式。
12. 表格行首色条 —— 指示条只属于导航当前项。

## 4. 图像生成提示词

七条提示词：P1 实时屏（图生图，用你自己的底图）、P2 实时屏（文生图，模型自绘电影感插画底图）、
P3 历史屏、P4 外观屏、P5 空态、P6 桌面小窗、P7 应用图标。负向提示词在 4.7，**这一版的负向表和上一版几乎完全不同**，不要混用。

画面比例目标 **1.64 : 1**（对应 1180×720），推荐 1600×976。
工具只给固定档位时选 3 : 2（1536×1024），代价是岛屿比实际略高一点，构图关系不变。

**一条贯穿所有提示词的铁律：画面就是界面本身，铺满整张画布。**
不画桌面、不画壁纸边框、不画窗口外框、不画整图投影、不留空白边。
实现里那个 20px 的外框圆角**不进成图** —— 一旦画出圆角，模型就会在圆角外补一块桌面，
上一版就是这么失败的（诊断见 5.1）。

### 4.1 P1 · 实时屏（带底图，主用）

上一版 P1 的问题是**尺寸全是形容词**：「very large monospace numbers」「generously sized」
「a larger two-line chart」—— 模型没有任何可锚定的比例，只能把所有文字画成差不多大，
出来就是一张扁平的图。这一版把布局写成**画面比例**、把字号写成**输出分辨率下的绝对像素**，
两者都是模型能直接照做的量。

```text
A single dark desktop application interface, 1600 x 976. The ENTIRE image is the interface
itself, filling every pixel edge to edge. There is NO desktop, NO wallpaper outside it, NO
outer window border, NO rounded outer corners, NO drop shadow around the whole image, NO
empty margin. The image IS the app.

NON-NEGOTIABLE COMPOSITION — follow these positions exactly. All sizes are fractions of the
full image, and every gap between islands is the same width, about 1.2% of the image width.
- TOP BAR ISLAND: full width minus the outer margin, 8% of the image height, flush to the top.
- NAV ISLAND: a narrow vertical rail on the left, 5% of the width, 37% of the height, starting
  just below the top bar. It is SHORT — it must NOT reach the bottom of the image.
- INSPECTOR ISLAND: on the right, 32% of the width, 49% of the height, starting just below the
  top bar, its right edge aligned with the top bar's right edge.
- OPEN ARTWORK REGION: the rectangle between the nav rail and the inspector — 58% of the width
  and 49% of the height — is COMPLETELY EMPTY. No panel, no text, no icon, no logo, no
  watermark on it. This is the single largest shape in the composition.
- DATA ISLAND: full width minus the outer margin, 35% of the height, along the bottom, its left
  and right edges aligned with the top bar's.
The three lower islands are DIFFERENT sizes on purpose: the nav rail is small and short, the
inspector is tall and narrow, the data island is wide and low. This is NOT a grid of equal cards.

NON-NEGOTIABLE TYPOGRAPHY.
FONT FAMILIES — the strictest rule in this prompt:
- SANS-SERIF (a modern humanist face like Segoe UI Variable or Inter) for ALL of these: the
  "NetPeek" wordmark, every app and process name, every label, every button, every heading,
  every section title, every table header, every navigation element. App names are NEVER monospace.
- MONOSPACE for ONLY numeric telemetry that changes: rates, totals, PID numbers, dates, axis
  values, and unit suffixes like "MB/s".
- Normal text has zero letter-spacing. At most, the tiny uppercase table header may use a very
  slight positive tracking. Nothing else.
- No display font, no serif, no condensed, no script, no terminal or retro face.
TYPE SCALE — sizes in pixels at 1600 x 976. Respect these ratios; the difference between the
largest and smallest text must be obvious at a glance.
- 41px bold monospace: the two total rate numbers in the top bar. ONLY these two are huge.
- 27px monospace: the cumulative totals in the inspector.
- 23px semibold sans: the "NetPeek" wordmark, the selected app's name in the inspector.
- 20px monospace: the download and upload rates in each process row.
- 19px sans: process and app names, section titles, chart legends. Sans is narrower than
  monospace, so long names like "Steam Client WebHelper" fit on one line.
- 18px sans: the status capsule text, the search placeholder, small buttons.
- 18px monospace: PID numbers.
- 16px sans: the file path, secondary field values, the table header.
- 15px monospace: chart axis labels and unit suffixes.

ARTWORK — the star of the composition: one continuous piece of anime artwork covers the whole
frame beneath the interface, darkened about 30%, gently blurred, nothing in it bright white.

CONTENT TO RENDER — render ALL of the following; do not omit any element listed here.

1. TOP BAR ISLAND — one single row, everything vertically centered, generous horizontal spacing.
   Left group, in this order: a small amber heartbeat logo mark; "NetPeek" at 23px semibold sans;
   a pill capsule holding a small GREEN dot and the word "Monitoring" at 18px sans; then an amber
   down arrow with "24.38" at 41px monospace and a smaller amber "MB/s" at 15px; then a steel-blue
   up arrow with "6.12" at 41px monospace and a steel-blue "MB/s" at 15px; then a grey "Today
   total" label at 16px sans beside "32.46 GB" at 18px monospace.
   The two 41px numbers nearly fill the height of the bar and are the first thing the eye sees.
   Right group: a two-segment view toggle pill (about 11% of the bar width) whose two segments
   read "Process" and "App", and a rounded search pill (about 18% of the bar width) reading
   "Search apps...". NOTHING else on the right — no gear icon, no theme switch, no window controls.

2. NAV ISLAND — four thin line icons in a modern Lucide style, stacked vertically with even
   spacing, NO text labels: an activity/pulse icon, a clock icon, a palette icon, a gear icon.
   The top one is active: amber icon, a slightly lighter cell behind it, and a tiny amber
   vertical bar at that cell's left edge.

3. INSPECTOR ISLAND — four stacked sections separated by thin 1px hairlines, in this order.
   Section 1, about 21% of the island height: a real colorful application icon, the app name at
   23px semibold sans in white, a grey file path on one truncated line at 16px sans, and
   "PID 15872 · Session 01:32:47" at 16px monospace.
   Section 2, about 15%: TWO separate lines of cumulative totals — an amber "15.74 GB" at 27px
   on the first line, a steel-blue "2.31 GB · Retrans 1,204" at 27px on the second, each with a
   small grey label at 15px. Two lines, never one merged number; the retransmit count must appear.
   Section 3, about 28%: the title "Live usage" at 19px sans with a small amber and steel-blue
   value pair at its right; below it a two-line chart, amber over steel blue, with THREE y-axis
   value labels at 15px in a left gutter, "60s ago" and "Now" at the two ends of the x axis, two
   dashed horizontal gridlines, no vertical gridlines, and a faint amber gradient fill under the
   amber line.
   Section 4, about 28%: the title "30-day usage" at 19px sans with a total at its right; below
   it a 30-bar amber bar chart, y-axis labels at 15px, one date at each end.

4. DATA ISLAND — split left and right by a single 1px vertical divider.
   Left 40%: the title "Bandwidth (live)" at 19px sans with a small two-item legend "Download /
   Upload"; below it a two-line bandwidth chart, same axis treatment as above, filling the
   remaining height.
   Right 60%: a process table with exactly FOUR columns and exactly FIVE rows. Column widths:
   Process 48%, PID 14%, Download 19%, Upload 19%. The header row is 16px sans uppercase and
   reads "Process / PID / Download / Upload". Each row holds a real colorful application icon
   (Chrome, Steam, Discord, Spotify, OneDrive), the app name at 19px sans, a PID at 18px
   monospace, an amber download rate at 20px monospace, and a steel-blue upload rate at 20px
   monospace. Rates are right-aligned in their columns.
   There are NO horizontal lines between rows. Rows are separated by empty space alone, plus a
   very faint amber gradient washing in from the left edge of each row — widest on the top row,
   barely visible on the bottom row.

MATERIAL — this is the anti-cheap detail.
- Each island is warm dark charcoal at about 88% opacity with 16px rounded corners.
- Island borders are EXTREMELY SUBTLE: a low-opacity warm edge, visible mainly at the corners
  and along the top edge, then fading into the dark. There is NO bright continuous orange outline
  around any island.
- The amber glow is LOCAL, not uniform: near the active nav icon, the selected row, the live data.
  It never forms a full bright halo around an entire island perimeter. Most of each island's edge
  disappears into the background.
- The artwork stays visible through every island, dimmer and blurred: about 12-15% visible in the
  top bar and inspector, and 8-12% still visible in the data island. The girl's orange hair is
  visible inside the top bar, the red hull is visible inside the inspector. An island that reads
  as an opaque black slab with no trace of the artwork is wrong.

SPACING: every island has generous internal padding, roughly equal on all sides. Text never
touches an island's edge. There is real empty space inside each island, not content packed to
the borders.
COLOR: warm amber accents on warm dark charcoal. The ONLY saturated colors are amber #f0913f
(download) and steel blue #7fa8c9 (upload); app icons keep their real brand colors; the status
dot is green. Everything else is neutral warm grey.
MOOD: calm, spacious, modern product interface, low information density, lots of breathing room.
NOT a system utility, NOT a dense spreadsheet, NOT a control panel, NOT retro terminal software.
Crisp UI rendering, no photographic depth of field applied to the interface itself.
```

字号那一段是 3.3 的字阶按 976 / 720 = 1.356 换算出来的，成图上可以直接量。
**字族已经写死**：无衬线（名字 / 标签 / 按钮 / 标题 / 表头 / 导航），等宽只给会变的数字
（速率 / 总量 / PID / 日期 / 坐标 / 单位）。表头另定为 16px 无衬线大写 —— 上一版 19px 大写字距过宽，
读起来像旧终端。

| 设计值 | 成图（1600×976） | 字族 | 用在哪 |
| --- | --- | --- | --- |
| 30 | 41 | 等宽 | 顶栏两个总速率 |
| 20 | 27 | 等宽 | 检查栏累计 |
| 17 | 23 | 无衬线 | 字标、检查栏应用名 |
| 15 | 20 | 等宽 | 表格速率 |
| 14 | 19 | 无衬线 | 进程名、段标题、图例 |
| 13 | 18 | 无衬线 / 等宽 | 状态胶囊、搜索占位符（无衬线）；PID（等宽） |
| 12 | 16 | 无衬线 | 路径、次要字段、表格表头 |
| 11 | 15 | 等宽 | 坐标标注、单位 |

**只有顶栏那两个数字是「大」的**，41px 对 15px 是 2.7 倍。这句在提示词里写了两遍
（TYPE SCALE 段和顶栏段各一次），因为这是最容易被模型平均掉的一条 ——
一旦所有文字都画成中等大小，整张图就没有视觉入口，看起来就是「哪里都在喊」。

布局那一段用比例而不是像素：模型对 `8% of the image height` 的执行力远好于 `58px`，
因为它不知道自己在画多大的画布。三块下层岛屿「故意不等大」也明写了，
否则模型的默认倾向是把它们对齐成一排等高卡片。

这一版另外改了两处，都是对着上一张成图的失败点改的：

- **字族分工是第一优先级。** 上一张里 `NetPeek`、进程名、表头、坐标标签几乎全是等宽，
  整张图退回了复古终端感。现在把「名字和标签用无衬线、只有会变的数字用等宽」写成
  NON-NEGOTIABLE TYPOGRAPHY 的第一条，并在 CONTENT 段逐处标了 sans / monospace。
- **边框和发光全面减淡。** 上一张四块岛都被一整圈橙线包住，暖光几乎连续，像游戏 HUD。
  现在 MATERIAL 段明确写：边缘只在**角和顶边**略亮、其余淡入暗色，没有整圈亮橙轮廓，
  琥珀光只在**活跃数据附近**局部出现，不进整体边缘。
- **P1 重排成优先级结构。** COMPOSITION 和 TYPOGRAPHY 标 NON-NEGOTIABLE，CONTENT 居中，
  MATERIAL / COLOR / MOOD 殿后。上一张丢失 `Today total`、`Bandwidth (live)` 标题、
  Retrans、视图切换被画成 Graph / Table —— 那是提示词把每件事写得一样重要，模型自行取舍。
  现在每个待渲染元素都列在 CONTENT TO RENDER 里，并明写「不得省略任何一项」。

底图换成自己的图时，把「the girl's orange hair」「the red hull」两句改成**你那张图里真实存在的物体和颜色**。
这两句是让模型真的把底图画进岛屿里的唯一手段 —— `translucent` / `opacity` / `backdrop blur`
这类词对图像模型基本是空转（原因见 5.1）。

### 4.2 P2 · 实时屏（电影感插画 / 文生图）

**P2 的职责：不用自己的底图，让模型连插画带界面一起生成，出主视觉定稿图。**
P1 走图生图、底图是你自己的画；P2 走文生图、底图由模型画一张电影感插画。
两条提示词产出的界面结构完全一致，方便对照「同构不同底」的效果。参考观感：深夜窗边的人物插画，
暖色台灯，玻璃上的雨痕，暗红的城市光 —— 画面暗、主体安静、中间偏左有大片干净区域。

**P2 也要带上 P1 的 NON-NEGOTIABLE COMPOSITION 和 NON-NEGOTIABLE TYPOGRAPHY 两段**
（原样粘在 BACKGROUND ARTWORK 前面，含字族分工那一段）。下面只写 P2 独有的插画描述和界面内容；
布局、字族、字号是两条提示词共用的，不在这里重复 —— 重复的规格早晚会两边不一致。

```text
Create a single full-bleed desktop application interface, 1600 x 976, edge to edge.
The entire image is the application UI itself: no desktop, no wallpaper outside it, no outer
window frame, no title bar, no margin. The image IS the app.

[paste P1's NON-NEGOTIABLE COMPOSITION paragraph here, unchanged]
[paste P1's NON-NEGOTIABLE TYPOGRAPHY paragraph here, unchanged]

BACKGROUND ARTWORK: one cinematic, painterly illustration covers the whole frame underneath
the interface — a quiet night scene: a girl resting her chin on her hand beside a large window,
warm desk lamp light on the left, soft rain on the glass, deep muted red city glow outside.
Dark, atmospheric, slightly blurred, dimmed about 30%. The illustration has one clear subject
placed center-left and generous calm space around it; nothing in the artwork is bright white,
and the artwork carries no text, no UI elements, no watermark.

ISLAND MATERIAL: warm dark charcoal at about 88% opacity, 16px rounded corners. Island borders
are EXTREMELY SUBTLE: a low-opacity warm edge, visible mainly at the corners and along the top
edge, then fading into the dark. There is NO bright continuous orange outline around any island,
and the amber glow is LOCAL (near active data and the selected row), never a full halo around an
entire perimeter. The illustration stays visible through every island, dimmer and blurred — rain
streaks and the window's red glow should be faintly visible inside the panels, about 12-15% in
the top bar and inspector and 8-12% in the data island. The open artwork region, where the girl
and the window are, is COMPLETELY UNCOVERED by any panel, text, or icon. That open view of the
artwork is the heart of the composition.

1. TOP BAR ISLAND — one single row, everything vertically centered.
   Left, in this order: a small amber pulse-wave logo mark; "NetPeek" at 23px semibold sans; a
   dark pill with a small GREEN dot and the word "Monitoring" at 18px sans; an amber down arrow
   with "24.38" at 41px monospace and "MB/s" at 15px; a steel-blue up arrow with "6.12" at 41px
   monospace and "MB/s" at 15px; a grey "Today total" at 16px sans beside "32.46 GB" at 18px
   monospace. The two 41px rate numbers nearly fill the bar's height and are the first thing the
   eye sees. Right: a two-segment view toggle reading "Process / App" and a rounded search pill
   reading "Search apps...". Nothing else — no gear icon, no theme switch, no window buttons.

2. NAV ISLAND — four thin line icons in a modern Lucide style, stacked vertically with no
   labels: activity/pulse, clock, palette, gear. The top icon is active: amber icon, a slightly
   lighter cell, and a short amber bar at the cell's left edge.

3. INSPECTOR ISLAND — four parts separated by thin hairlines.
   Part 1: a real colorful Chrome icon, "Google Chrome" at 23px semibold sans in white, a grey
   file path on one truncated line at 16px sans, and "PID 15872   Session 01:32:47" at 16px
   monospace.
   Part 2: two separate lines of cumulative totals — "Total down  15.74 GB" in amber at 27px
   monospace on one line, "Total up  2.31 GB   Retrans 1,204" in steel blue and grey at 27px
   monospace on the next. Two lines, never merged into a single number.
   Part 3: "Live usage" at 19px sans with a small amber down value and steel-blue up value at
   the right of the title; below it a two-line chart with y-axis labels "3 MB/s", "1.5 MB/s",
   "0" at 15px monospace in a left gutter, "60s ago" and "Now" at the two ends, two dashed
   horizontal gridlines, no vertical grid.
   Part 4: "30-day usage" at 19px sans with "Total  15.74 GB" at the right; below it a 30-bar
   amber bar chart with y-axis labels "1.5 GB", "750 MB", "0" at 15px monospace and the dates
   "Apr 25" and "May 24" at the two ends.

4. DATA ISLAND — split left and right by a single 1px vertical divider.
   Left 40%: "Bandwidth (live)" at 19px sans with a small legend "Download / Upload"; below it
   a wider two-line chart with y-axis labels "30 MB/s", "15 MB/s", "0" at 15px monospace and
   "60s ago" / "Now" at the ends.
   Right 60%: a process table with a grey 16px sans uppercase header row "Process / PID /
   Download / Upload" and exactly FIVE rows. Column widths: Process 48%, PID 14%, Download 19%,
   Upload 19%. Each row: a real colorful application icon (Chrome, Steam, Discord, Spotify,
   OneDrive), the app name at 19px sans, a PID at 18px monospace, an amber download rate at
   20px monospace, a steel-blue upload rate at 20px monospace, rates right-aligned. NO horizontal
   lines between rows — rows are separated by space alone, with a very faint amber wash fading
   in from the left edge of each row, widest on the first row.

SPACING: every island has generous internal padding, roughly equal on all sides; text never
touches an island's edge.
COLOR: the only saturated colors are warm amber #f0913f (download) and steel blue #7fa8c9
(upload); app icons keep their real brand colors; the status dot is green. Everything else is
warm dark neutral.
MOOD: cinematic, warm, calm, premium — an illustration-first interface, not a system utility,
not a dense dashboard, not neon sci-fi, not retro terminal software. The scene breathes; the
instruments are quiet.
```

**P2 专用负向补充**（与 4.7 通用负向提示词一起使用）：

```text
bright daylight scene, white or pale artwork, cluttered illustration, busy background with
many small details, character covering the right half of the frame, character's face behind
a panel, text or logo inside the artwork, watermark in the artwork, photographic realism,
3D render look, flat solid grey panels hiding the artwork, panels covering the illustration
subject, nav rail running the full height of the frame, cumulative usage as one merged number,
neon cyberpunk colors, purple and cyan palette, harsh saturated red UI, cartoon flat colors,
chibi style
```

想换场景时，只改 BACKGROUND ARTWORK 一段里的场景描述，保留三条约束：整体暗、主体在中间偏左、
主体周围干净。场景越满，玻璃岛越没有意义（底图选取标准见 5.2，文生图同样适用）。

已经验证过能出图的三个替换场景，都满足那三条约束：

| 场景 | 替换 BACKGROUND ARTWORK 的场景句 | 暖光来源 |
| --- | --- | --- |
| 雨夜窗边（默认） | a girl resting her chin on her hand beside a large window, warm desk lamp light, soft rain on the glass, deep muted red city glow outside | 台灯 |
| 深夜书桌 | a figure seen from behind at a cluttered desk in a dark room, a single warm monitor glow lighting the edges, bookshelves fading into shadow | 显示器 |
| 黄昏天台 | a lone figure sitting on a rooftop railing at dusk, warm amber sunset low on the horizon, a dim city sprawl below in deep blue shadow | 夕阳 |

三个场景的共同点值得记下来：**暖光只有一个来源、且在画面左侧**。
这一条不是为了好看 —— 岛屿的暖色亮边和外发光都是琥珀色，
底图的暖光和它同源时整张图是一套光；底图暖光在右边、或者有两三个方向的光源时，
右侧检查栏的亮边会读成「另一个光源的反光」，材质就散了。

### 4.3 P3 · 历史屏

沿用 P1 的 NON-NEGOTIABLE COMPOSITION、NON-NEGOTIABLE TYPOGRAPHY、ARTWORK、ISLAND MATERIAL 四段，
只换两块内容岛：

```text
Same four-island composition, same typography, same colors, same large uncovered artwork region
as before. Only the two content islands change.

INSPECTOR ISLAND: three large monospace totals stacked with small grey labels above them —
an amber download total at 27px, a steel-blue upload total at 27px, a white combined total at
27px, each label at 15px sans. Below a thin divider, a ranked list of 8 rows: each row has a real
colorful app icon, an app name at 19px sans, and a monospace amber data amount at 20px, with a very
faint amber gradient washing in from the left edge of the row, widest on the first row.

DATA ISLAND: a top row of four small pill-shaped range
buttons at 18px reading "7 days", "30 days", "90 days", "custom", with the second one active
and amber, and a quiet outlined "Export CSV" button at the far right. Below them ONE wide
GROUPED BAR CHART: 30 groups, each group is one thick amber bar beside one thick steel-blue
bar, three y-axis value labels at 15px in a left gutter, a date label at each end of the x
axis, two dashed horizontal gridlines, no vertical gridlines.
There is NO line chart anywhere in this image.
```

### 4.4 P4 · 外观屏

```text
Same four-island layout, same type scale, same colors as before. The large uncovered artwork
region is the live preview itself, so it must stay COMPLETELY EMPTY — no panel, no swatch,
no preview card on top of it.

INSPECTOR ISLAND: three stacked radio rows, each with a short bold label at 19px and a smaller
grey sub-label at 16px, the first one selected with an amber dot. Below a thin divider, a wide
rounded thumbnail of the artwork, two small buttons under it, and a small grey filename at 15px.

DATA ISLAND: three equal columns separated by 1px vertical dividers.
Left column: three horizontal sliders with small grey labels at 16px, each handle amber, each
track only partly filled. Middle column: a two-column grid of ten small rounded color swatches
with grey labels at 16px; two of them, an amber one and a steel-blue one, carry a tiny lock icon.
Right column: a text input, a small button, and a short list of saved theme rows at 19px with
the current one outlined in amber.

There is NO dark overlay, NO dimmed screen, NO modal dialog, NO popup panel covering the
interface. The whole interface stays at full brightness and fully visible.
```

最后一段是针对现有实现那个 45% 压暗覆盖层写的：调色的界面不能被自己压暗（2.7）。

### 4.5 P5 · 空态（服务未连接）

```text
Same four-island layout, same type scale, same colors as before, with these differences:
- The status capsule in the top bar is RED, not green, and its text is longer.
- The two 41px rate numbers in the top bar are replaced by dim grey placeholder dashes at the
  same 41px size, so the layout does not collapse.
- The process table area of the bottom island has NO rows at all. Centered in that area
  instead: a short white headline at 20px, one line of grey explanatory text at 18px, and two
  small rounded buttons side by side beneath it.
- Both charts keep their y-axis labels, x-axis labels and dashed gridlines, but have NO data
  line and NO bars drawn inside them.
- The inspector island shows a few grey label-and-value field rows and no app icon.
Everything else is unchanged. The artwork region stays completely uncovered.
```

空态是最容易被跳过、又最影响信任的一屏。让它进成图，是为了在设计阶段就确认「没数据时画面不塌」。

### 4.6 P6 · 桌面小窗

小窗不是全屏界面，用产品展示图的方式出：

```text
Two small floating UI objects on a plain neutral backdrop, side by side, product design
presentation style. No desktop screenshot, no window frame around the image.

LEFT: a circular widget about 92 pixels across. A 4px amber ring runs around its edge,
filled about two thirds of the way around like a progress gauge; a thinner steel-blue ring
sits just inside it, filled a small amount. The disc inside is warm dark charcoal with a
thin amber rim light and a soft amber outer glow that is NOT clipped — there is clear empty
space all the way around the disc. In the center: an amber down-arrow with "2.4" in bold
monospace digits and a tiny "MB/s" beneath it, then a smaller steel-blue "0.3 MB/s".

RIGHT: a rounded rectangular panel, 320 wide by 300 tall, 16px rounded corners, warm dark
charcoal, thin amber rim light, soft amber outer glow. Four bands from top to bottom:
a header with the word "NetPeek", a small green dot and two tiny icon buttons; a totals band
with one large amber monospace number and one large steel-blue monospace number; a list of
five rows, each with a real colorful app icon, an app name and a small monospace rate, each
row washed by a faint amber gradient from its left edge; a footer containing EXACTLY TWO
small buttons.
Exactly two buttons in the footer. Not three.
```

「发光不被裁掉」和「脚部只有两个按钮」是两条要盯的：前者对应 `mini.css` 里 100px 的球塞进 100px 窗口，
后者对应把「退出」挪去托盘菜单（2.9）。

### 4.7 负向提示词

分八组，按「守什么」排。**整段替换上一版的负向表，不要合并** ——
上一版里有 `rounded outer corners`、`empty margin` 这类词，会把这一版必需的岛屿圆角和岛间距一起压掉。

```text
[画面就是界面]
desktop, wallpaper visible outside the interface, window floating on a desktop,
interface inset inside the canvas, dead space around the interface, letterboxing,
drop shadow around the whole image, window title bar, browser chrome,
macOS traffic lights, minimize maximize close buttons,

[底图必须活着]
opaque flat panels with no artwork visible inside, solid grey cards,
panels covering the entire background, artwork completely hidden,
UI element placed on the empty artwork region, background fully blurred away,

[不要变回系统工具]
1px grey hairline borders everywhere, horizontal rule between every table row,
dense spreadsheet, 14-row table, Excel, Windows Control Panel, Task Manager,
system utility, resource monitor skin, retro software, Winamp, 2000s UI,

[图表要有坐标]
chart without axis labels, 3D chart, pie chart, donut chart, needle gauge,
sparkline in every table row, progress bar column, duplicated percentage column,
a second set of percentages, bar chart and line chart showing the same data twice,

[不存在的字段]
protocol column, local address, remote address, TCP state, connection list, port number,
packet list, latency column,

[字号层级要拉开]
all text the same size, uniform type size across the interface, flat typographic hierarchy,
tiny primary rate numbers, primary rates no larger than the labels, oversized body text,
text filling every island edge to edge, no internal padding, cramped panels,

[布局不要变成等大网格]
four equal cards, equal-height panels in a row, symmetric grid of panels, centered layout,
nav rail spanning the full height, panels of identical size, evenly divided quadrants,

[图标与字体]
letter avatars, monogram placeholders, generic grey square icons,
flat monochrome app icons, emoji as app icons,
serif display font, script font, condensed font,
proportional digits for rates, numbers with varying character widths,
monospace app names, monospace labels and headings, terminal or typewriter font everywhere,
monospace navigation text, monospace table headers,

[装饰与噪声]
neon cyberpunk glow, rainbow gradient, purple and cyan color scheme,
frosted glass blobs, decorative background shapes, lens flare, bloom on text,
dark overlay dimming the interface, modal dialog, popup covering the panels,
watermark, signature, caption, annotation arrows, dimension lines, red circles,
bright continuous orange outline around every island, glowing border around an entire
panel perimeter, neon border frame, thick luminous rim on all four sides
```

P6（小窗）去掉第一组、第二组和第六组 —— 它本来就是展示图，不是全屏界面，
两个对象也确实不该等大。

### 4.8 P7 · 应用图标

图标不是界面，是**产品标记**：它要扛住 16px 任务栏和 32px 托盘这两个最苛刻的尺寸，
构图逻辑和前面六条完全不同 —— 前面是「界面铺元素」，这里是「一个图形扛住所有缩略」。
沿用 §2.2 定下的琥珀心跳标记和岛屿的暖炭底、弱描边语言，别起新图形。

```text
A modern desktop application icon, 1024 x 1024, centered on a plain dark neutral backdrop.
Product icon style, not a screenshot, not an interface.

TILE: one single rounded squircle, warm dark charcoal #1e1a16, roughly 72% of the canvas so it
reads clearly at small sizes. The tile's edge is EXTREMELY SUBTLE: a low-opacity warm edge that
catches light mainly along the top edge and the two top corners, then fades into the dark.
No bright continuous outline, no neon frame, no bevel, no gloss.

MARK — this is the whole icon: ONE single amber pulse waveform #f0913f running horizontally
across the center — a calm flat line that rises into ONE sharp peak near the middle and settles
back down, like a single heartbeat or one burst of network traffic. The line has rounded caps
and a medium, even stroke, clean and geometric. Just below it, at low opacity, a faint steel-blue
echo #7fa8c9 of the same waveform suggests upload traffic. NOTHING else inside the tile — no
text, no letters, no grid, no axes, no bars, no extra shapes.

LIGHT: a soft warm amber glow radiates from the pulse line onto the tile, brightest at the peak
and fading quickly. The tile casts no drop shadow onto the backdrop.

MOOD: premium, minimal, calm instrumentation. It must stay legible as a 16px taskbar icon.
```

**P7 专用负向补充**：

```text
text, letters, words, initials, multiple waveforms, ECG with many spikes, busy pulse train,
photo, 3D render, bevel, gloss, skeuomorphism, metallic texture, drop shadow, reflection,
rainbow, purple and cyan palette, clip art, sticker outline, busy background, watermark
```

三条必须说清的理由：

- **一个峰，不是一串峰。** 完整心电图的密集尖峰在 16px 下糊成一团噪点；
  孤立的单峰在任何尺寸都站得住。这是图标能缩小的全部前提。
- **钢蓝回波只做低透明暗示。** 它把「上传」这个语义带进标记，但淡到不跟琥珀抢，
  缩到 16px 时它会先消失，正好让琥珀主线独自清晰 —— 信息按重要性分层退出，是刻意的。
- **不放任何文字。** 「NP」或「NetPeek」在 16px 下读不出，图形必须独自承担识别。

负向表里 P7 去掉 [底图必须活着] 和 [画面就是界面] 两组 —— 图标本来就没有底图、也不铺满界面。
保留 [图标与字体] 整组，它正好是图标最该防的。

## 5. 底图与玻璃态

### 5.1 为什么上一版图生图画成了「窗口浮在桌面上」

三个原因，其中两个是提示词自己的错：

**一、提示词自相矛盾，模型听了具体的那句。** 上一版一边说底图是应用自己的背景，一边写着：

```text
A thin warm rim light traces the outer window edge; one soft wide ambient shadow
falls onto the artwork beneath the window, fading with no hard outline.
```

后一句是**具体的视觉指令**（外框亮边 + 投在底图上的投影），前一句只是**抽象的角色说明**。
「窗口边缘」加「投在底图上的投影」合起来只有一种画法：一个窗口浮在壁纸上。模型画得完全正确，是提示词错了。
修法就是第 4 节开头那条铁律 —— 不写外框、不写整图投影，明确写「画面就是界面，铺满画布」。

**二、`translucent` / `opacity 88%` / `backdrop blur` 这类词对图像模型基本空转。**
它们是 CSS 属性名，不是画面描述；模型没有「合成」这一步。有效的写法是**指名底图里的具体物体出现在面板里**：
`the girl's orange hair is visible inside the top bar`。把抽象属性换成可画的内容。

**三、重绘强度给低了。** 上一版写 0.30–0.45，那个区间模型只会给底图调个色、加点锐化，长不出一整套界面。
要在图生图里长出界面，**重绘强度得给到 0.55–0.70**。

于是有一个必须直说的取舍：

| 你要的 | 该用的工具 | 底图的命运 |
| --- | --- | --- |
| 底图像素级保真 + 界面长在上面 | **指令编辑类模型**（Nano Banana / GPT-image / Seedream 的图像编辑模式），底图当参考图 + 文字指令 | 基本保留 |
| 只要构图和配色对，底图可以变 | 图生图，重绘强度 0.55–0.70 | 被重画成「像那张图」的另一张图 |
| 不在乎底图 | 文生图，用 P2 —— 它自带一整段插画描述 | 模型自己画一张 |

**「底图像素级保真」和「图生图」是互斥的**，不要在图生图里追求前者。要保真就换指令编辑类模型，
提示词开头改成 `keep this artwork exactly as it is, and draw the following interface on top of it: …`。

两步预处理能明显提高图生图的成功率，都在送进模型之前做：

1. **先把底图裁成输出比例**（1.64 : 1）。比例不一致时模型会自己补边，补出来的那条边就是「桌面」。
2. **先把底图整体压暗 30%**（对应 `--scrim`）。模型看到的输入已经压暗过，就不会再把它当亮底壁纸处理，
   顺带省掉一句提示词。

### 5.2 底图选取标准

这几条对成图和实际使用都成立 —— 用户自己换背景图时同样适用，值得做成外观屏的一行提示。
**P2 让模型自己画底图时，同样用这几条去筛成图**：模型画出来的插画不合格，后面的玻璃岛就白做。

- 长边 ≥ 1600，比例接近 1.64 : 1，裁切后主体仍落在中间偏左。
- **主体要有一片相对干净的区域**留给留白区。主体本身太满（人物占满全图、密集文字、复杂机械）时，
  岛屿后面什么都读不出，玻璃态白做。
- 亮度分布：最亮区域不要超过总面积 25%。大面积纯白就是 3.2 实测表里的最坏情况。
- 高频细节要有节制。雨痕、雪点、星空这类**方向一致的稀疏细节**经 24px 模糊后会变成柔和的纹理，可以要；
  草丛、砖墙、密集光点这类**无方向的满幅细节**会糊成噪声，岛内文字浮在噪点上，不要。
- 主体色相别和琥珀 / 钢蓝撞。主体是大面积橙色时，`--down` 的语义色在画面上读不出来。
  暗红、深蓝紫、墨绿这类**低明度**的主体色安全，因为语义色靠的是明度差不只是色相差。

### 5.3 生成参数

| 参数 | 值 | 备注 |
| --- | --- | --- |
| 尺寸 | 1600×976（≈1.64 : 1） | 只有固定档位时退到 1536×1024 |
| 重绘强度（P1 图生图） | 0.55 – 0.70 | 低于 0.55 长不出界面，高于 0.70 底图基本没了 |
| 引导强度 CFG | 6 – 8 | 再高会把 amber 推成饱和亮橙，语义色就跑了 |
| 采样步数 | 30 – 40 | 再多只是慢 |
| 批量 | 一次 4 张 | 按第 6 节清单筛，通常 4 张里过 1 张 |
| 随机种子 | 固定住能过的那个 | 出了一张构图对的，用同种子改局部提示词 |

**P2 是文生图，没有重绘强度这一项**，其余参数相同。它的变量在提示词里：
插画不满意就只改 BACKGROUND ARTWORK 那一段，界面结构各段一个字不动 ——
把变量隔离在一段里，才能用同一个种子对比不同场景。

## 6. 验收清单

**先过第一组，不过就直接丢，不用看后面。** 这一组是这一版的方向本身。

| # | 检查 | 不过的典型表现 |
| --- | --- | --- |
| 1 | 画面铺满，没有桌面、没有外框、没有整图投影 | 一个圆角窗口浮在壁纸上 |
| 2 | 中间偏左有一整片底图完全没被遮住 | 面板铺满全屏，底图只从缝里透一点 |
| 3 | 每块岛屿里都能看出底图的痕迹 | 岛屿是不透明的灰板 |
| 4 | 岛屿有暖色亮边 + 暖色外发光 | 灰描边 + 黑投影 |
| 5 | 底图本身合格：暗、主体在中间偏左、主体周围干净（5.2 那几条） | 亮底、主体占满右半幅、满幅高频细节 |
| 6 | 顶栏那两个总速率明显最大（约是坐标标注的 2.7 倍），一眼就是视觉入口 | 所有文字差不多大，画面没有入口 |
| 7 | 三块下层岛屿明显不等大：导航窄而短、检查栏高而窄、数据岛宽而矮 | 一排等高卡片 |
| 8 | 岛内四边都有明显留白，文字不贴边 | 内容顶到岛屿边缘 |
| 9 | 名字 / 标签 / 表头是无衬线，只有速率 / PID / 坐标 / 单位是等宽 | 应用名和表头也是等宽，整张图像旧终端 |
| 10 | 岛屿边缘只是角和顶边略亮、其余淡入暗色，没有整圈亮橙轮廓 | 每块岛都被一圈橙线包住，像游戏 HUD |

P2（模型自绘插画）第 5 条尤其要盯 —— 插画和界面是同一次生成的，
插画画歪了整张就废了，这时候要改的是 BACKGROUND ARTWORK 那一段，不是界面那几段。

第 6–10 条是前两轮对着成图补的：第 6–8 条修「尺寸写成形容词导致画面扁平」，
第 9–10 条修「字族不分 + 满圈橙描边导致复古终端 / HUD 感」。
这两类都是模型最稳定的失败模式，放在第一组 —— 不过直接丢，不用看内容对不对。

第二组是内容正确性，逐项对照第 2 节：

| # | 检查 |
| --- | --- |
| 11 | 进程表**只有四列**（应用 / PID / 下载 / 上传），没有第二套百分比、没有占比条、没有每行火花线 |
| 12 | 进程表**只有五行**，行与行之间没有横线 |
| 13 | 检查栏没有协议 / 本地地址 / 远程地址 / TCP 状态 —— 这些字段在 NetPeek 里不存在 |
| 14 | 每张图都有 y 轴三档标注和 x 轴两端标注，没有纵向网格 |
| 15 | 状态点是**绿色**，不是琥珀色（琥珀已被「下载」占用） |
| 16 | 下载全程琥珀、上传全程钢蓝，没有第三个饱和色 |
| 17 | 应用图标是**真实彩色图标**，不是首字母方块、不是灰色占位块 |
| 18 | 所有速率数字是等宽字形，字宽一致 |
| 19 | 累计用量是两行（下载 / 上传），不是一个数 |
| 20 | 小窗脚部只有两个按钮，能量球的外发光没被裁掉 |

## 7. 与现有实现的差异

这一节是实现清单。左边是 `src/NetPeek.App/ui/` 现在的样子（都附了代码位置，可核对），右边是这一版的规格。

| # | 现在 | 这一版 | 位置 |
| --- | --- | --- | --- |
| 1 | 顶栏 + 图表带 + 卡片带 + 状态栏约 347px 固定带，表格只剩 7 行 | 四块浮岛，表格默认 5 行，密集模式 15 行 | `styles.css:70` `:127` `:164` `:434` |
| 2 | Top 4 卡片带内容就是表格前四行 | 取消卡片带 | `styles.css:164` `index.html:41` |
| 3 | `body.has-bg` 的玻璃规则没包含表格容器 —— 全屏最小最密的字，落在唯一没有面板底的表面上 | 岛屿是唯一的表面，表格在岛内 | `styles.css:59-68` |
| 4 | 面板不透明度下限 0.30，实测纯白底图上次要文字 1.77:1 | 下限 0.82，默认 0.88 | `index.html:138` |
| 5 | 外观 / 设置是 45% 压暗的全屏覆盖层 | 改成屏；留白区就是实时预览 | `styles.css:472-481` |
| 6 | 七列、43px 行高、每行满格横线 | 四列、36px 行高、无横线、整行琥珀渐变代替占比列 | `styles.css:376-384` `index.html:47-53` |
| 7 | `--error: #e14b3a` 在 `--surface` 上只有 4.34:1、在半透明岛屿上 3.01:1，而服务异常文案正好出现在面板上 | `#f97770`（6.51 / 4.52） | `styles.css:12` |
| 8 | 满屏 `1px solid var(--border)` 深色描边 | 岛内分隔线 `rgba(255,255,255,0.10)`，控件描边 0.18 | `styles.css` 全文 |
| 9 | 三处互相竞争的 `margin-left: auto` 决定顶栏排布 | `grid-template-columns: auto 1fr auto` 两组分区 | `styles.css:85` `:102` `:460` |
| 10 | 主窗保留系统标题栏，未设 `transparent` | `decorations: false` + `transparent: true`，自绘拖动与 20px 外框圆角 | `tauri.conf.json:14-15` |
| 11 | 100px 的能量球塞进 100×100 窗口，外发光被裁掉 | 窗口 108×108，球 92×92，四周留 8px | `mini.css:23-26` `mini.rs` |
| 12 | 迷你窗脚部三个等宽按钮，「退出」和「主界面」一样醒目 | 两个按钮，退出移到托盘菜单 | `mini.html:36-38` |
| 13 | 迷你窗圆角 10，能量球是冷色球体渐变 | 圆角 16，统一暖色岛屿材质 | `mini.css:36` `:80` |

## 8. 已知限制

生成图能确认的和不能确认的，分清楚，别在错误的东西上纠结：

- **图上的文字和数字一律不可信。** 模型会写出 `2.43 MB/s`，也会写出 `2.4B M/s`；中文更糟。
  所有文案以第 2 节为准，成图只看构图。
- **成图量不出尺寸。** 58 / 268 / 356 / 250 是设计值，图上的比例一定会漂。实现时回到规格表。
- **玻璃态在成图里通常偏强或偏弱。** 真实观感只能在实现里用 3.2 的滑块调。
- **真实应用图标画不准。** 模型只能画「像 Chrome / Steam 的图标」。实现里从 exe 提 HICON 并缓存，与成图无关。
- **坐标轴上的数值几乎肯定是乱的**（三档不成等差）。只验证「有没有标注」，不验证数值。
- **第 3 节的对比度是算出来的，不是从成图取样得到的。** 任何时候都不要拿成图截图去取色验证 ——
  它经过了模型的色彩处理，取出来的值没有意义。
- **密集模式、悬浮态、焦点环、动效**都无法出现在静态成图里，只能按第 2、3 节实现并自测。


















