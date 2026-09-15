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

## 「底图的形」量尺（p2p）

同一块面板拍两张（有 `--theme-bg-image` / 摘掉），逐像素相减（面板自身内容相减即抵消），
按 8×8 格取格均值再求峰谷差。基准：平色 0–7，可见 ≥36。**不能用单图方差**（会给出负增益）。
`preview-v2.mjs` 的 `[bg-user-glass:form]`（diffSd）是同源判据。

## 构建 / 打包链路

`scripts/build-installer.ps1`：tauri build --no-bundle → dotnet publish Collector（self-contained）
→ 填 `src/NetPeek.Installer/payload` → dotnet publish Installer → 产物 `dist\NetPeek.Setup.exe`。
UI 改动**必须重打包**才能在真机 app 里看到（WebView2 加载的是打进包里的前端资源）。

## 本机环境坑

- `Bash` 工具的 coreutils 会整个失效（`shell-runtime-bash-env.sh: dirname: command not found`
  → `ls/head/tail/grep not found`）。绕法：**只用带全路径的 node** 跑脚本，
  或用 `node -e "fs.readdirSync(...)"` 代替 `ls`。
- `PowerShell` 工具的 stdout **不回显**（只回 `Command completed with exit code 0`）。
  诊断一律「命令里重定向到文件 → 用 Read 工具读」。
- **禁止从 Bash 调 PowerShell**（安全策略拦截，报 `Invoking PowerShell from Bash bypasses
  PowerShell security checks`）——PS 脚本要走 PowerShell 工具。
- `*>` 重定向出来是 UTF-16：读时先试 utf8，含 `\u0000` 再换 `utf16le` 解。

## 记忆文件

按天的日志在 `.workbuddy/memory/YYYY-MM-DD.md`（只追加）。透镜/可读性这条线的最新状态
看 2026-09-15.md 的三次返工小节。
