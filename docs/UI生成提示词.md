# NetPeek UI 生成提示词（基于指定底图）

> **2026-09-03 重写**：按当前真实页面与功能全面更新各方案提示词——主窗顶栏（状态徽章/总速率/视图切换/搜索/外观/设置）、10s·1m·5m 速率图、Top 4 卡片、含「重传」列的进程表、右侧详情窗格、底部状态栏；迷你窗改为**能量球（100×100）⇄ 迷你窗（320×300）双形态**；新增主题面板（三模式）与设置面板提示词。底图分析、融合强化段落、图生图工作流不变。
>
> 背景策略见技术选型文档 4.3 节：用户自定义背景 + 运行时自适应主题（标准 / AI 双模式）。本文件用于生成视觉参考稿，确定配色、层次与布局密度后按稿重构 HTML。

底图：`C:\Users\Administrator\Desktop\明日香.jpg`，1536×1024（3:2）。

## 1. 底图分析（采样自实际像素）

| 用途 | 色值 | 画面占比 |
| --- | --- | --- |
| 最深阴影 | `#050403` `#0A0604` | 约 35% |
| 暖黑基底 | `#130A07` `#1F0C08` `#250F0B` | 约 45% |
| 中间调锈红 | `#401B11` | 约 10% |
| 唯一亮部（发丝、皮肤） | `#C06E3C` `#BB6D3E` | 极少 |

判断：画面 80% 以上压在暖黑区间，只有人物区域有琥珀亮部。这种低照度、单一色温的底图适合做半透明玻璃 UI 的背景——UI 面板压暗后不会与画面抢注意力，强调色只需把底图的琥珀提亮到可读亮度。

## 2. UI 配色（与当前实现的设计令牌一致）

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| 背景 | `#111418` | 应用底色 |
| 面板玻璃 | `#140C09` 60–75% 不透明度 + 背景模糊 | 卡片/面板 |
| 面板描边 | `#5A3A2A` 30% 不透明度，1px | 边框 |
| 主文字 | `#F2E6DC` | 标题、数值 |
| 次要文字 | `#A89184` | 标签、说明 |
| 下载（主强调） | `#F0913F` 暖橙 | 所有下载相关图形/数字 |
| 上传（次强调） | `#7FA8C9` 灰蓝 | 所有上传相关图形/数字 |
| 正常 | `#6FB87A` | 状态正常 |
| 警告 | `#D9B44A` | 丢事件等警告 |
| 错误 | `#E14B3A` | 服务异常 |

**全局规则：下载永远暖橙、上传永远灰蓝**，图表曲线、卡片、表格数字、能量球全部一致。速率数值用等宽数字（tabular-nums）。

## 3. 构图安全区

人物脸部在画面左侧约 35–50% 宽、20–45% 高的位置，是唯一的视觉焦点。右侧那片暗红舱窗几乎空白，是放 UI 的最佳区域。

因此推荐两种布局：UI 占右侧、人物留左侧（方案 A）；或 UI 分列左右、中间留出人物（方案 B）。

## 3.1 方案关系与已知问题

A/B/C 不是三选一的互斥功能，而是同一产品的不同界面：A 是悬浮主窗，B 是全屏沉浸（A 的替代范式，二选一），C 是桌面小窗双形态，D/E 是主窗内的模态面板。产品里 A 与 C 并存，D/E 依附于主窗。生成图片时按张选构图即可。

首轮生成的两个已知问题（2026-09-02 实测）：

1. 模型把 "frosted dark glass … 70% opacity" 画成了不透明深色卡片，壁纸没有透过面板，窗口像贴上去的。
2. 文生图模式下底图被重画（人物与场景全部改变），说明要保住指定底图必须用图生图或参考图模式，不能只靠文字描述。
3. 窗口边缘没有继承场景光源（台灯暖光、红色霓虹），缺乏轮廓光，造成"从别处剪下来"的观感。

## 3.2 融合强化段落（插入任意方案提示词的 Style 之前）

融合做不好的根因是三个词被模型忽略：opacity、blur、rim light。把下面这段整块插入提示词，权重远高于单独写 "frosted glass"：

```text
Integration with the scene is critical:
- The window is TRUE translucent milk glass: the blurred wallpaper is clearly
  visible THROUGH every panel, with a strong backdrop blur effect; panel fill is
  only #140C09 at 55% opacity, never a solid opaque card.
- Environmental light interaction: the red neon glow from the right side of the
  scene softly diffuses across the glass surface; a thin warm rim light (#C06E3C)
  traces the window edges; the lower-left corner of the window picks up a faint
  warm bounce from the desk lamp.
- The window casts one soft, wide ambient shadow onto the scene beneath it, as
  if floating a few centimeters above the image plane; the shadow fades gradually
  with no hard outline.
- Shared color grade: wallpaper and UI share the same warm dark grade and subtle
  vignette, so the window feels photographed inside the scene, not pasted on top.
```

同时把负面提示词追加：

```text
opaque solid window, flat pasted-on rectangle, hard cutout edges, window hiding
the background completely, no backdrop blur, double window frames, UI floating
in empty black void
```

## 3.3 保住指定底图的生成方式

文生图模式下背景一定会被重画（首轮已发生）。要"UI 叠在你给的这张图上"，二选一：

1. **图生图（img2img）**：底图作为输入，去噪强度 0.30–0.45。0.3 以下 UI 画不实，0.45 以上人物开始变形。配合 3.2 融合段落。
2. **参考图模式**（Nano Banana / GPT-image / Seedream 等多模态编辑类）：底图作为待编辑图片输入，指令开头固定写：

```text
Keep the provided artwork exactly as the background, pixel-faithful, do not
redraw or alter the character or the scene. Composite the following UI window
on top of it:
```

## 3.4 生成结果评审（2026-09-02，A/B/C 三张实测）

结论：提示词已成立，三张均可作为设计参考。融合强化段落（3.2）生效——半透明玻璃、轮廓光、统一调色在成图中可见。

各方案表现：

- **A 悬浮主窗**：结构还原度最高。问题：速率单位被模型自选为 Mbps（产品必须统一自动单位 B/KB/MB/GB）；应用卡片进度条橙蓝混用语义不明——实现语义已定：**进度条表示该应用占总流量的百分比**。
- **B 沉浸式全屏**：完成度最高，背景即应用背景、人物从面板间隙透出。**与"自定义背景 + 自适应主题"策略最匹配，定为主窗目标形态。**
- **C 迷你窗**：玻璃融合最好，信息层级合理。

共性问题：壁纸仍为重画（工作流应为"先定一张壁纸再分别叠加 UI"）；文字渲染质量超出预期但不可信，不能当数据源。

实现阶段待办（生成图无法验证，需写真界面时确认）：真实数据下的列宽（长路径、中文应用名、无图标进程）；次级文字在复杂背景上的对比度是否仍 ≥ 4.5:1。

## 方案 A：悬浮主窗（构图参考；产品主窗形态以 B 为准，见 3.4）

```text
A polished Windows 11 desktop UI mockup screenshot. A single floating application
window named "NetPeek" (about 1180x720) is composited on the right 58% of the
frame, over a dark warm-toned anime wallpaper of a red-suited pilot girl sitting
in a dim cockpit; the girl's face stays fully visible on the left, unobstructed.

The window is frosted dark glass: fill #140C09 at 70% opacity, heavy background
blur, 1px hairline border #5A3A2A, 12px rounded corners, soft drop shadow.

Window contents, top to bottom:
- Top bar: small NetPeek glyph and app name; a status pill "监控中" with a
  glowing green dot; total readouts "↓ 5.1 MB/s" in amber #F0913F and
  "↑ 320 KB/s" in pale steel blue #7FA8C9 plus a small "今日 1.2 GB" caption;
  a segmented toggle "按进程 | 按应用" with the first segment active; a compact
  search field with magnifier icon; two small ghost buttons "外观" and "设置".
- Real-time chart panel: title "实时速率" and three time-window chips
  "10s / 1m / 5m" with "10s" selected; a wide dual-line chart, download in amber
  and upload in steel blue, soft gradient area fills fading to transparent,
  faint horizontal gridlines, a hover tooltip showing exact values at a point.
- A row of four compact app cards: each with a rounded app icon, app name,
  download rate in amber and upload rate in steel blue, and a thin amber
  progress bar showing that app's share of total traffic; one card is selected
  with an amber outline.
- A process table with header row and about seven data rows; columns: app icon
  + name, PID, download speed, upload speed, download total, upload total,
  retransmit; numbers right-aligned in tabular figures; a sort arrow on the
  download column header; one row highlighted with a subtle amber left accent.
- A right-side detail pane (about 300px wide) sliding in: large app icon, app
  name, full file path in small dim text, field list (path, PID, session
  duration, download total, upload total, retransmit), a small one-hour
  dual-line sparkline, and a collapsed "归因说明" section.
- Bottom status strip: a green dot with "监控正常", service status, session
  duration "已采集 02:14:33", and attribution coverage "96% 已归因 · 4% 未归因",
  all in small dim text separated by thin dividers.

Style: fluent modern dark UI, glassmorphism, 8px spacing grid, clean sans-serif
labels, tabular numerals, restrained amber accent, high contrast text, crisp
pixel-accurate rendering, no photographic noise. Aspect ratio 3:2, 1536x1024.
```

## 方案 B：沉浸式全屏（产品主窗目标形态；艺术图作为应用自身背景）

```text
A full-bleed dark desktop application interface for a network traffic monitor
named "NetPeek" (1180x720 window). The entire window background IS a dim warm
anime artwork of a red-suited pilot girl in a shadowy cockpit, heavily darkened
and slightly blurred so UI stays readable; the girl remains visible in the
centre-left gap between panels.

Layout: a slim translucent top bar spanning full width, a narrow icon-only left
rail, a translucent glass panel column docked to the right edge, and a floating
glass card strip along the bottom. Center area is left empty so the artwork
shows through.

Top bar: NetPeek wordmark, a status pill "监控中" with a green dot, total
download rate in amber #F0913F and total upload rate in pale steel blue #7FA8C9
as large monospace numbers, a "今日 1.2 GB" caption, a segmented toggle
"按进程 | 按应用", a search field, and two ghost buttons "外观" "设置".

Left rail: four small icons for realtime, history, appearance, settings; the
first is active with an amber indicator.

Right panel: selected-app detail — rounded app icon, app name, file path in
small dim text, field list (PID, session duration, download total, upload
total), a small one-hour dual-line sparkline, and a collapsed "归因说明"
section.

Bottom card strip: on the left a compact dual-line bandwidth chart with
time-window chips "10s / 1m / 5m"; on the right a horizontal process list with
about five rows, each showing app icon, name, PID, download speed in amber and
upload speed in steel blue; above the strip a row of four tiny top-app cards
with amber share bars.

Glass panels: #140C09 at 65% opacity, strong backdrop blur, 1px #5A3A2A
borders, 12px radius. Text #F2E6DC, secondary text #A89184. A thin bottom
status strip shows a green dot "监控正常", session duration and attribution
coverage.

Style: cinematic dark glassmorphism, fluent design, 8px grid, tabular numerals,
subtle vignette, crisp UI rendering. Aspect ratio 3:2, 1536x1024.
```

## 方案 C：桌面小窗（双形态，各生成一张）

### C1 · 能量球形态（100×100）

```text
A tiny floating desktop widget for "NetPeek", a perfect 100x100 circle of frosted
dark glass, placed in the lower-right area over a dark warm anime cockpit
wallpaper of a red-suited pilot girl. Glass fill #140C09 at 70% opacity, strong
backdrop blur, a thin warm rim light tracing the circle edge, soft shadow.

Centered contents, two stacked rows: a large monospace download rate
"↓ 171.6 KB/s" in amber #F0913F, and below it a smaller upload rate "↑ 1.0 B/s"
in pale steel blue #7FA8C9. No border chrome, no title bar — pure circular
glass orb floating above the wallpaper.

Style: minimal dark glassmorphism, tabular numerals, crisp rendering, wallpaper
visible and blurred through the orb. Aspect ratio 3:2, 1536x1024.
```

### C2 · 迷你窗形态（320×300）

```text
A small floating desktop widget named "NetPeek", exactly 320x300 logical pixels,
placed in the lower-right area over a dark warm anime cockpit wallpaper of a
red-suited pilot girl. Frosted dark glass card, #140C09 at 70% opacity, strong
blur, 1px #5A3A2A border, 16px rounded corners, soft shadow.

Contents, top to bottom: a title row with "NetPeek", a small status text
"监控中", and two tiny ghost buttons "—" and "×" on the right; a totals row
with a large amber download readout "↓ 171.6 KB/s" and a smaller steel-blue
upload readout "↑ 1.0 B/s"; a list of the top three apps, each row with a small
rounded icon, short app name, and a right-aligned rate in tabular figures;
finally a footer row of three equal-width ghost buttons "暂停" "主界面" "退出".

Style: fluent modern dark glassmorphism, minimal, generous padding, tabular
numerals, crisp UI rendering, wallpaper visible and blurred behind the card.
Aspect ratio 3:2, 1536x1024.
```

## 方案 D：外观与主题面板（模态浮层，叠在压暗的主界面上）

```text
A dark desktop app screenshot of "NetPeek" with a frosted-glass modal dialog
"外观与主题" (about 560px wide) floating centered over the dimmed main window;
the main window behind is heavily blurred and darkened to 40%.

The modal is dark milk glass: fill #140C09 at 75% opacity, strong blur, 1px
#5A3A2A border, 12px radius. Contents, top to bottom:
- Header: title "外观与主题" and a small "×" close button.
- A row of three mode cards (radio style), each with a bold name and a small
  caption: "标准离线取色 / 背景图自动配色，完全离线" (selected, amber outline),
  "AI 自适应 / 多模态模型生成，可保存", "定制化主题 / 预设 / 手动调色".
- A "背景图" section: two small buttons "选择图片…" and "无背景", plus a dim
  status line.
- A "微调" section with two sliders labeled "面板不透明度" and "背景模糊",
  amber slider thumbs on dim tracks.
- A "保存与主题列表" section: a text field "主题名称" with a "保存主题" button,
  then a list of three saved-theme chips, each showing a tiny color strip, a
  name, and small "启用 / 重命名 / 删除" actions.
- Footer: a ghost button "还原默认".

Style: fluent dark glassmorphism, 8px grid, tabular numerals, crisp UI text.
Aspect ratio 3:2, 1536x1024.
```

## 方案 E：设置面板（模态浮层）

```text
A dark desktop app screenshot of "NetPeek" with a frosted-glass modal dialog
"设置" (about 560px wide) floating centered over the dimmed blurred main
window. Same dark milk glass style: #140C09 at 75% opacity, 1px #5A3A2A border.

Contents as stacked sections with dim section titles:
- "常规": a dropdown "速率显示单位" showing "自动（B / KB / MB / GB）", and a
  checked checkbox "登录时自动启动".
- "历史数据": a dropdown "保留周期" showing "30 天", a dim summary line
  "已聚合 12 天 · 共 348 MB", and two small buttons "刷新概览" "清空历史".
- "服务状态": two dim status lines, one with a green dot "采集服务运行中", one
  "ETW 事件丢失 0 条".
- "外观": a single button "打开外观与主题面板…".
- "关于": a dim line "NetPeek v0.1.0".

Style: fluent dark glassmorphism, 8px grid, crisp UI text, restrained amber
accents only on interactive controls. Aspect ratio 3:2, 1536x1024.
```

## 通用负面提示词

```text
photo, photorealistic texture, paper texture, film grain, heavy noise, watermark,
signature, logo clutter, lorem ipsum blocks, garbled text, duplicated panels,
skewed perspective, 3D perspective mockup, tilted window, drop-shadowed floating
text, neon cyberpunk purple, rainbow gradients, teal-and-orange clash, overly
saturated colors, bright white panels, light theme, blurry UI text, low contrast
text, cluttered layout, overlapping elements, cropped window edges
```

## 生成参数建议

- 尺寸 1536×1024，与底图一致，避免二次裁切破坏构图。
- 若工具支持图生图（img2img）：底图作为输入，去噪强度 0.30–0.45（详见 3.3 节）。
- 若工具支持参考图 / 多模态输入（Nano Banana、GPT-image、Seedream 等）：底图作为参考图，并固定使用 3.3 节的像素保真指令。
- 需要多张备选时固定随机种子，只改布局描述，便于横向对比。

## 已知限制

生成模型基本画不对 UI 里的文字和数字。这些图只能用于确认配色、层次和布局密度，不能当视觉稿交付。确定方向后按图重构 HTML（`src/NetPeek.App/ui/`），功能项以 [功能清单.md](功能清单.md) 为准，本文件只负责视觉呈现。
