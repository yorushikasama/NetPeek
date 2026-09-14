# 启动动效资产（boot-motion）

NetPeek 冷启动时那 2.4 秒的品牌揭示：源图标里的**两条波形线** + 字标 "NetPeek"
（2000ms 动效 + 400ms 定格）。

这个目录是**设计面与生成器**，不是运行时依赖 —— 应用实际加载的东西都在
`src/NetPeek.App/ui/` 下（`boot.css` / `boot.js` / 注入 `index.html` 的 SVG 片段）。
把包删掉，应用照样跑。

## 先看哪份

| 想知道什么 | 看哪 |
|---|---|
| 动效长什么样 | 双击 `logo_motion.html`（底部有重播 / 时间轴拖动 / 配色切换） |
| 为什么是这个时间线、这些颜色、这些数字 | `motion_spec.md` |
| 波形和字标的几何是怎么来的 | `motion_spec.md` 的 Phase 2 |
| 在应用里怎么接的、揭幕时机怎么定 | `docs/开发进度.md` §38 |
| 逐帧量纲、接入验收 | `outputs/motion_sheet.png`、`outputs/skin_compare.png`、`outputs/integration/` |

## 目录

```
logo.svg              波形标记（源图坐标 1254×1254，独立可预览，也是唯一的几何真源）
logo_motion.html      审阅页：按真实窗口尺寸拼出启动页，支持 ?t= 定格
motion_spec.md        设计与验证记录（Phase 1 实测 → Phase 2 拟合 → Phase 3 编排）
tools/                生成与验收工具
outputs/              产物与证据（可直接入库的那些；逐帧原图可由命令重生成）
```

## tools

| 工具 | 干什么 | 什么时候要跑 |
|---|---|---|
| `analyze_logo.py` | 栅格源实测（线宽、取色、辉光衰减、底片几何） | 换源图时 |
| `extract_geometry.py` | 语义部件的几何提取 | 换源图时 |
| `fit_centerline.py` | 逐列 50% 覆盖率量中心线 → `M/L/Q` 路径 | 改了拟合口径或换源图时 |
| `overlay_qa.py` | 渲染结果叠回源图逐列比对 | 跑完 `fit_centerline.py` 之后 |
| `extract_wordmark.py` | 字标 → SVG 描边 + 墨迹包围盒 | 换字体/换文案时 |
| `compose_lockup.py` | 波形 + 字标 → 锁定版式，**并注入审阅页和 `ui/index.html`** | 改版式常量后必跑 |
| `rasterize.mjs` | 单个文件确定性光栅化（Playwright + 系统 Chrome） | 按需 |
| `capture_frames.mjs` | 一次会话连拍整条时间线 | 改动效后 |
| `qa_motion.py` | 逐帧量纲 + 单调性 + 终帧契约 | 跑完 `capture_frames.mjs` 之后 |
| `verify_integration.mjs` | 在**真实** `ui/index.html` 上验接入 | 改 `boot.css` / `boot.js` / `index.html` 后 |
| `make_skin_compare.py` | 深底 / 浅底同刻帧拼成对照图 | 跑完 `verify_integration.mjs` 之后 |
| `check_window_center.py` | 量**真实的窗口位置**是否落在显示器工作区正中 | 改了 `tauri.conf.json` 的窗口位置/尺寸后 |

## 怎么重跑

```bash
cd D:/NetPeek/assets/boot-motion
PY="C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"

# 改了几何：重拟合 + 重新合成（合成会自动更新两处 HTML）
$PY tools/fit_centerline.py && $PY tools/overlay_qa.py && $PY tools/compose_lockup.py

# 只改了版式常量：合成一次即可
$PY tools/compose_lockup.py

# 改了时间线 / 配色：连拍 + 量纲（times 用默认均匀栅格；最后一个数必须等于 ANIM+HOLD）
$NODE tools/capture_frames.mjs logo_motion.html --out-dir outputs/frames --prefix brand
$PY tools/qa_motion.py --dir outputs/frames --prefix brand --lockup outputs/lockup.json \
      --sheet outputs/motion_sheet.png --json outputs/motion_metrics.json

# 接入验收（必跑，审阅页通过不代表应用里对）
$NODE tools/verify_integration.mjs "D:/NetPeek/src/NetPeek.App/ui/index.html" \
      --out-dir outputs/integration
# 深浅对照图（从上面的产物拼，两边采样时刻必须一致）
$PY tools/make_skin_compare.py

# 窗口是否居中（要先冷启动应用；不是截图能看出来的量）
$PY tools/check_window_center.py
```

`PY` 要指那个 **venv**，不能指裸解释器（`binaries/python/versions/3.13.12/python.exe`）：
裸的没装 numpy / Pillow。

## 几条别踩的

- **不要手改 `logo_motion.html` 与 `ui/index.html` 里 `@lockup` 标记之间的内容** ——
  下次跑 `compose_lockup.py` 会被整段覆盖。要改就让生成器改。
- **不要用 `chrome.exe --headless`** 做验证：本机 Chrome 152 的命令行 headless 会静默挂死。
  统一走 `rasterize.mjs` / `capture_frames.mjs`（Playwright 通道）。
- **截帧前必须显式关掉 `prefers-reduced-motion`**（工具里已经传了
  `reducedMotion: "no-preference"`）。本机若关过系统动画，每个 `?t=` 帧会长得一模一样，
  很容易被误读成「时间线没生效」。
- **改配色前先算对比度**。浅底那套不是调出来的：深底的峰顶 `#fbd77f` 对 `#f2f3f5`
  只有 1.25:1，会整条化掉。
- **找主窗别按窗口类名找**。实测 Tauri 主窗和迷你窗的类名**都是** `Tauri Window`
  （系统里的通用类，不带应用标识）；带标识的 `com.netpeek.app-sic`
  （标题 `com.netpeek.app-siw`）是单实例插件的 22×22 消息窗。按**标题**找才对。
- **`GetWindowRect` 对最小化窗口返回 `(-32000, -32000)` 哨兵值**，不是位置。
  工具里要判 `IsIconic`，否则会算出「偏了 32841 像素」这种一眼假的结论。
  隐藏窗口（托盘态）的矩形倒是有效的，位置照量。
