# NetPeek UI 生成提示词（基于指定底图）

> **2026-09-02 策略更新**：产品方向已改为“用户自定义背景 + 运行时自适应主题（标准 / AI 双模式）”，见技术选型文档 4.3 节。本文件的固定底图提示词**降级为设计参考样例**——用于探索视觉风格、确认配色层次，产品本身不再需要为每张图手工写提示词（运行时主题引擎接管）。其中“融合强化段落”（3.2）的配色与环境光思路，可直接作为 AI 自适应模式给多模态模型的指令素材。

底图：`C:\Users\Administrator\Desktop\明日香.jpg`，1536×1024（3:2）。

## 1. 底图分析（采样自实际像素）

| 用途 | 色值 | 画面占比 |
| --- | --- | --- |
| 最深阴影 | `#050403` `#0A0604` | 约 35% |
| 暖黑基底 | `#130A07` `#1F0C08` `#250F0B` | 约 45% |
| 中间调锈红 | `#401B11` | 约 10% |
| 唯一亮部（发丝、皮肤） | `#C06E3C` `#BB6D3E` | 极少 |

判断：画面 80% 以上压在暖黑区间，只有人物区域有琥珀亮部。这种低照度、单一色温的底图适合做半透明玻璃 UI 的背景——UI 面板压暗后不会与画面抢注意力，强调色只需把底图的琥珀提亮到可读亮度。

## 2. UI 配色（由底图推导，供生成与后续实现共用）

- 面板玻璃：`#140C09` 60–75% 不透明度 + 背景模糊
- 面板描边：`#5A3A2A` 30% 不透明度，1px
- 主强调（下载）：`#F0913F`（底图琥珀提亮）
- 次强调（上传）：`#7FA8C9`（低饱和冷调，与暖底图区分方向但不刺眼）
- 正文：`#F2E6DC`；次要文字：`#A89184`
- 异常态：`#E14B3A`（与底图锈红同族）

若希望完全暖色统一，把上传色换成米金 `#E8C9A0`，代价是上传/下载两条曲线的区分度下降。

## 3. 构图安全区

人物脸部在画面左侧约 35–50% 宽、20–45% 高的位置，是唯一的视觉焦点。右侧那片暗红舱窗几乎空白，是放 UI 的最佳区域。

因此推荐两种布局：UI 占右侧、人物留左侧（方案 A）；或 UI 分列左右、中间留出人物（方案 B）。

## 3.1 方案关系与已知问题

A/B/C 不是三选一的互斥功能，而是同一张界面的三种构图：A 是悬浮主窗，B 是全屏沉浸（A 的替代范式），C 是托盘迷你窗。产品里 A 与 C 并存（两个不同界面），A 与 B 二选一（两种主窗范式）。生成图片时按张选构图即可。

首轮生成的两个已知问题（2026-09-02 实测）：

1. 模型把 “frosted dark glass … 70% opacity” 画成了不透明深色卡片，壁纸没有透过面板，窗口像贴上去的。
2. 文生图模式下底图被重画（人物与场景全部改变），说明要保住指定底图必须用图生图或参考图模式，不能只靠文字描述。
3. 窗口边缘没有继承场景光源（台灯暖光、红色霓虹），缺乏轮廓光，造成“从别处剪下来”的观感。

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

文生图模式下背景一定会被重画（首轮已发生）。要“UI 叠在你给的这张图上”，二选一：

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

- **A 悬浮主窗**：结构还原度最高（标题栏、双速率读数、时间窗、应用卡片、进程表、状态条齐全）。问题：速率单位被模型自选为 Mbps（B 用了 MB/s，产品必须统一，功能清单已定自动单位）；应用卡片进度条橙蓝混用语义不明，实现时需先定义（建议表示下载/上传占比）。
- **B 沉浸式全屏**：完成度最高，背景即应用背景、人物从面板间隙透出。**与“自定义背景 + 自适应主题”策略最匹配，定为主窗目标形态。** A 的“浮窗叠桌面壁纸”不是产品形态，仅留作构图参考。
- **C 迷你窗**：玻璃融合最好，信息层级合理（总计与 Top3 数值自洽）。底部纯图标按钮在挂件尺寸下可接受。

共性问题：壁纸仍为重画（三张之间高度一致，工作流应为“先定一张壁纸再分别叠加 UI”，此流程保留）；文字渲染质量超出预期但不可信，不能当数据源。

实现阶段待办（生成图无法验证，需写真界面时确认）：B 方案底部表格在真实数据下的列宽（长路径、中文应用名、无图标进程）；次级文字在复杂背景上的对比度是否仍 ≥ 4.5:1；进度条语义定义。

## 方案 A：悬浮主窗（构图参考；产品主窗形态以 B 为准，见 3.4）

```text
A polished Windows 11 desktop UI mockup screenshot. A single floating application
window named "NetPeek" is composited on the right 58% of the frame, over a dark
warm-toned anime wallpaper of a red-suited pilot girl sitting in a dim cockpit;
the girl's face stays fully visible on the left, unobstructed.

The window is frosted dark glass: fill #140C09 at 70% opacity, heavy background
blur, 1px hairline border #5A3A2A, 14px rounded corners, soft drop shadow.

Window contents, top to bottom:
- Title bar: small NetPeek glyph, app name, a small "Monitoring" status pill with
  a glowing amber dot, then minimize / maximize / close glyphs.
- Header strip: two large monospace readouts side by side, download rate in amber
  #F0913F and upload rate in pale steel blue #7FA8C9, each with a small caption
  underneath; to their right a compact search field with magnifier icon.
- A wide real-time bandwidth chart: two smooth line series (amber and steel blue)
  with soft gradient area fill fading to transparent, faint horizontal gridlines,
  and three small time-window chips "10s / 1m / 5m" with the first one selected.
- A row of four compact app cards, each with a rounded app icon placeholder, an
  app name, a small rate number, and a thin amber progress bar.
- A process table with a header row and about seven data rows; columns are app
  icon, app name, PID, download speed, upload speed, download total, upload
  total; numbers right-aligned in tabular figures; one row is highlighted with a
  subtle amber left accent bar.
- Bottom status strip: a small green dot with short status text on the left, and
  two small metrics on the right.

Style: fluent modern dark UI, glassmorphism, 4px spacing grid, clean sans-serif
labels, tabular numerals, restrained amber accent, high contrast text, crisp
pixel-accurate rendering, no photographic noise. Aspect ratio 3:2, 1536x1024.
```

## 方案 B：沉浸式全屏（艺术图作为应用自身背景）

```text
A full-bleed dark desktop application interface for a network traffic monitor
named "NetPeek". The entire window background IS a dim warm anime artwork of a
red-suited pilot girl in a shadowy cockpit, heavily darkened and slightly blurred
so UI stays readable; the girl remains visible in the centre-left gap between
panels.

Layout: a slim translucent top bar spanning full width, a narrow icon-only left
rail, a translucent glass panel column docked to the right edge, and a floating
glass card strip along the bottom. Center area is left empty so the artwork shows
through.

Top bar: NetPeek wordmark, a monitoring status pill, total download rate in amber
#F0913F and total upload rate in pale steel blue #7FA8C9 as large monospace
numbers, a "today total" caption, a search field, theme toggle and settings gear.

Left rail: four small icons for realtime, history, settings, about; the first is
active with an amber indicator.

Right panel: selected-app detail — rounded app icon, app name, file path in small
dim text, PID and session duration, a small sparkline chart, and a 30-day bar
chart of daily usage in amber bars.

Bottom card strip: a horizontal process list with about five rows, each showing
app icon, name, PID, download and upload speeds; plus a compact dual-line
bandwidth chart on the left of the strip.

Glass panels: #140C09 at 65% opacity, strong backdrop blur, 1px #5A3A2A borders,
14px radius. Text #F2E6DC, secondary text #A89184.

Style: cinematic dark glassmorphism, fluent design, 4px grid, tabular numerals,
subtle vignette, crisp UI rendering. Aspect ratio 3:2, 1536x1024.
```

## 方案 C：迷你窗（托盘小窗）

```text
A small floating desktop widget named "NetPeek", about 320x200 logical pixels,
placed in the lower-right area over a dark warm anime cockpit wallpaper of a
red-suited pilot girl. Frosted dark glass card, #140C09 at 70% opacity, strong
blur, 1px #5A3A2A border, 16px rounded corners, soft shadow.

Contents: a tiny title row with the app glyph and a drag handle; two stacked
monospace rate readouts, download in amber #F0913F with a down arrow and upload
in pale steel blue #7FA8C9 with an up arrow; a miniature dual-line sparkline
behind them at low opacity; then three compact rows for the top three apps, each
with a small rounded icon, short app name, and a right-aligned rate; finally a
row of three small ghost buttons.

Style: fluent modern dark glassmorphism, minimal, generous padding, tabular
numerals, crisp UI rendering, wallpaper visible and blurred behind the card.
Aspect ratio 3:2, 1536x1024.
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

生成模型基本画不对 UI 里的文字和数字。这些图只能用于确认配色、层次和布局密度，不能当视觉稿交付。确定方向后应在 Figma 里重画一版带真实文案的稿子，或直接用 HTML/XAML 写出真界面再截图。

界面里要出现的具体功能项以 [功能清单.md](功能清单.md) 为准，本文件只负责视觉呈现。

