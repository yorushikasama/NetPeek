# NetPeek 项目长期约定

## 皮肤 / 玻璃透镜改动的验收闸门（2026-09-15 立）

改 `src/NetPeek.App/ui/theme.js`（尤其 `lensBand` / `lensFromImage` / `backdropGuard` /
`GLASS_TIERS`）或 `theme-ui.js` 的 `applyBackdrop` 之后，**三条都要跑，顺序如下**：

```bash
N="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
export NP_PW="file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs"
export NP_CHROME="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
$N scripts/ui-tests/run-all.mjs          # 单测（theme.test 是主要防线）
$N scripts/ui-tests/_probe-glass.mjs     # 量「底图的形」p2p（浅/深两皮肤）
$N scripts/preview-v2.mjs                # 完整浏览器回归，要求 0 FAIL
```

`preview-v2.mjs` 依赖用户真壁纸 `%APPDATA%\com.netpeek.app\backgrounds\0dd6251aab60ce90.jpg`
与真配置；`_probe-glass.mjs` 复用它的临时预览目录（要先跑过一次 preview-v2 才有）。

## 铁律：判定口径必须与渲染同源

- 玻璃上各档字阶的目标**只有一份**：`theme.glassTierTargets(tokens)`（自校准）。
  回归脚本 / 探针 / 单测都必须调它，**不要再写死 75/60/40 或 45**。
  写死的后果：实现按 60 反解、回归按 75 判定 → 回归永远 FAIL → 逼着实现把带宽还回去。
- 算契约读数要用 `LENS_DESIGN_OP`（滑杆下限），**不要用实测 `--paint-op`** ——
  画面一旦退化它会被地板顶到 1，读数就失效（本轮被误导过一次）。
- 独立地面真值 = `preview-v2.mjs` 里的像素审计（`[bg-user-audit:*]`）。放宽任何模型判据时，
  **更严的那条计数（如 `below45`）必须继续打印**，代价不许藏。

## 铁律：跨屏口径一次对齐，快照型断言先看数据基准（2026-09-16 立）

- 「某处只看下载」这类口径质疑**从来不只一处**。当天用户问「排序键只看下载」，逐处核出五处：
  实时屏默认顺序（只看下载）、实时屏整行占比条（只看下载 + 写死下载色）、迷你窗 Top5（合计）、
  历史屏排行（合计）、采集端快照顺序（累计合计）。**改一处就要把其余几处一并核一遍**，
  报告里附证据表（哪处什么口径 + `文件:行`）。
- **口径一改，`baseOrder` 这类「先抓快照、几秒后比对」的断言会碎** —— 那不是实现回归，
  是数据基准不稳。把 `preview-v2.mjs` 的 mock 相邻行比算一遍：下载口径下 12 行只有 1 处
  ≤1.5，换成合计后变成 4 处（1.20–1.47），再配上**带行号相位**的 jitter（`sin(tick/4 + i)`）
  ⇒ 行序在几百毫秒内自己换位。假桥抖动改成**同相**（`sin(tick/4)`，不带 i）后相对顺序恒定。
  判据：任何「行序 / 集合相等」的断言，先确认相邻行差距 > 2×（jitter ±35% 不会翻转）。
- 「变量写了但 CSS 没接线」用**行为探测**：临时改该变量的值，读 `getComputedStyle().backgroundImage`
  有没有跟着变。断言不必重算实现里的公式（同源铁律），但要跨层验证接线。
- 新断言要**同时暴露口径与代价**：`share-bar` 读渲染出来的 `--share` / `--share-color`，
  而不是在测试里再写一遍 `shareOf` 的公式。

## 铁律：自绘浮层（日期 / 下拉 / 菜单）三条硬约定（2026-09-16 立）

1. **原生弹层一律不可用**：`<input type="date">` / `<input type="time">` 右端按钮弹出的是
   Chromium 的 PagePopup（独立文档），页面 CSS 完全够不着 —— 唯一的开关 `color-scheme`
   只能翻深浅，底色与强调色仍是内置灰石板 + 亮蓝。要跟主题走只能自绘
   （`date-picker.js`、`select-menu.js`），原生控件留在 DOM 当唯一数据源。
   `<input type="time">` 这种**取值本来就是离散**的（step=3600 ⟹ 全天 + 24 整点），
   直接换成 `select[data-menu]` 即可，不必再写一个自绘控件。
2. **Esc 必须逐层吞掉**：自绘浮层处理 Esc 时要 `preventDefault()` **加** `stopPropagation()`。
   漏了后者，事件会冒到 document 上连带关掉宿主面板（history-ui 就在那儿用 Esc 收整个
   自定义区间表单）。**同一张表单里两个浮层一个拦一个不拦 = Esc 有两个含义**，
   症状是「下一步点控件超时、报元素不可见」，离真相很远。
3. **探针的选择器要按屏圈定**：新增 `.sel` / `.dp` 这类增强层会让 `preview-v2.mjs` 里
   裸写的 `.sel .sel-btn` / `document.querySelector('.sel-pop')` 抢到别的屏的首次匹配
   （历史屏的表单在 DOM 里排在设置屏之前，且长期藏在 `hidden` 里）。写成
   `.screen[data-screen="settings"] .sel …`。

另：`select-menu.js` 选完后只冒 `change`（写的是 `select.value`，程序化赋值连 `input` 都不冒），
**表单级监听要 input 和 change 都听**。

## 「底图的形」量尺（p2p）

同一块面板拍两张（有 `--theme-bg-image` / 摘掉），逐像素相减（面板自身内容相减即抵消），
按 8×8 格取格均值再求峰谷差。基准：平色 0–7，可见 ≥36。**不能用单图方差**（会给出负增益）。
`preview-v2.mjs` 的 `[bg-user-glass:form]`（diffSd）是同源判据。

## 构建 / 打包链路

`scripts/build-installer.ps1`：tauri build --no-bundle → dotnet publish Collector（self-contained）
→ 填 `src/NetPeek.Installer/payload` → dotnet publish Installer → 产物 `dist\NetPeek.Setup.exe`。
UI 改动**必须重打包**才能在真机 app 里看到（WebView2 加载的是打进包里的前端资源）。
主程序 exe 实际叫 **`netpeek-app.exe`**（不是 `NetPeek.exe`），在 `src-tauri/target/release/`。

**改了 `ui/` 就必然重编 netpeek-app**（前端资源烘焙进二进制，build.rs 跟着重跑）——
这一步 1–4 分钟，是整条链路的长尾，也是最容易被「后台任务莫名消失」打断的一段。
长尾那步改用 **Bash 直调 cargo**（等价于 tauri build --no-bundle 的编译段）：

```bash
cd /d/NetPeek/src/NetPeek.App/src-tauri
"C:/Users/Administrator/.cargo/bin/cargo.exe" build --release   # 产物 target/release/netpeek-app.exe
```

Bash 里也**直接跑得通整条 tauri 构建**（2026-09-16 实测 3m24s，无输出即为成功）：
`cd /d/NetPeek/src/NetPeek.App && "C:/Program Files/nodejs/npm.cmd" run build -- --no-bundle`
（`npm run build` = `tauri build`）。之后 Ctrl 走 `dotnet.exe publish`
（Collector → payload、Installer → dist），Bash 里直接调得动：
清目录用 `node -e "fs.rmSync(...,{recursive:true,force:true})"`（别用 rm/Remove-Item）。

## 本机环境坑

- `Bash` 工具的 coreutils 会整个失效（`shell-runtime-bash-env.sh: dirname: command not found`
  → `ls/head/tail/grep not found`）。绕法：**只用带全路径的 node** 跑脚本，
  或用 `node -e "fs.readdirSync(...)"` 代替 `ls`。
- `PowerShell` 工具的 stdout **不回显**（只回 `Command completed with exit code 0`）。
  诊断一律「命令里重定向到文件 → 用 Read 工具读」。
- **`PowerShell` 的后台任务会被后续的 PowerShell 调用带走**（2026-09-16 一天踩两次）：
  `run_in_background` 启动 `pwsh -File xxx.ps1` 后，只要期间**再发一次 PowerShell 调用**
  （哪怕只是查进程），后台脚本几秒内消失，且**无任何报错** —— 输出停在最后 flush 处、
  收尾的 `EXIT=` 永不写、进程表里 pwsh/cargo/rustc 全 0，长得完全像「编译失败 / OOM」。
  对策：长任务走 Bash 的 `run_in_background`（Bash 前台调用不会带走 Bash 后台任务），
  或启动后只用 Bash/Read 轮询、绝不碰 PowerShell 工具。
- **禁止从 Bash 调 PowerShell**（安全策略拦截，报 `Invoking PowerShell from Bash bypasses
  PowerShell security checks`）——PS 脚本要走 PowerShell 工具。但 Bash 可以直接调 Windows
  程序：`cargo.exe` / `dotnet.exe` / `npm.cmd` 都跑得通。
- `*>` 重定向出来是 UTF-16：读时先试 utf8，含 `\u0000` 再换 `utf16le` 解。

## 记忆文件

按天的日志在 `.workbuddy/memory/YYYY-MM-DD.md`（只追加）。透镜/可读性这条线的最新状态
看 2026-09-15.md 的三次返工小节。
