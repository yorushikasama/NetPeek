// boot-trace.mjs — 启动动效窗口期的「结构」回归：幕布落下之前，数据通路该通了吗？
//
// 这个脚本回答的不是「启动快不快」，而是「启动顺序对不对」。
// 两者的区别很重要：顺序错了，换台快机器只会把问题缩小、不会消失；
// 顺序对了，慢机器也不会更差。所以下面用**模拟**的 IPC 延迟把成本填进去，
// 但断言只看顺序与串并行结构 —— 真实延迟取决于 IPC 与 SQLite，是环境量。
//
// 三条断言（对应三种已经踩过或差点踩到的坑）：
//   A 无丢帧窗口  listen('snapshot') 必须早于 win.show()
//                 Tauri 事件即发即弃、不缓冲；监听晚于显示，这段窗口内发出的
//                 快照帧全部丢失。丢首帧的代价不是速率（首帧是 0 值基线），
//                 而是**全量图标帧**（采集端 ResetIconStream 后第一帧带全部图标）。
//   B 动效下限    幕布不得早于 2400ms 摘掉（boot.js 的 ANIM 2000 + HOLD 400）
//   C 就绪而非超时 ready() 必须在幕布摘掉前被调用，即 dismissedBy == 'ready'
//                 落到 'timeout' 就说明启动链超了 4.0s 预算，用户看到的是一个
//                 自己都没准备好的界面。
//
// 用法：
//   node scripts/boot-trace.mjs            # 中等延迟（查库 60 / 24h 聚合 240 ms）
//   node scripts/boot-trace.mjs --fast     # 快 IPC，验结构不因延迟而变
//   node scripts/boot-trace.mjs --slow     # 慢 IPC，看预算还剩多少
//   node scripts/boot-trace.mjs --verbose  # 打完整时间线
// 退出码 0 = 三条断言全过。

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_PW =
  "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const mode = args.includes("--fast") ? "fast" : args.includes("--slow") ? "slow" : "mid";

const APP = path.resolve(
  args.find((a) => !a.startsWith("--")) || "src/NetPeek.App/ui/index.html",
);
if (!fs.existsSync(APP)) {
  console.error(`找不到 ${APP}`);
  process.exit(2);
}

// 与 boot.js 的时间线常量保持同步（改了那边这里要跟着改）
const ANIM_FLOOR = 2400; // ANIM 2000 + HOLD 400

const LAT = {
  fast: { daily: 20, totals: 80, other: 4 },
  mid: { daily: 60, totals: 240, other: 10 },
  slow: { daily: 180, totals: 900, other: 25 },
}[mode];

const { chromium } = await import(process.env.NP_PW || DEFAULT_PW);

const browser = await chromium.launch({
  executablePath: process.env.NP_CHROME || DEFAULT_CHROME,
  args: ["--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb"],
});
const ctx = await browser.newContext({
  viewport: { width: 1180, height: 720 },
  deviceScaleFactor: 1,
  reducedMotion: "no-preference",
});
const page = await ctx.newPage();

// mock 必须在页面任何脚本之前装上：main.js 顶层就 `const {listen}=__TAURI__.event`，
// 装晚了整段 main.js 直接抛错，量不到任何东西（浏览器降级路径就是这么走的，
// 那条路上 ready() 从不会被调用，幕布只能靠超时卸 —— 那不是真机行为）。
await page.addInitScript(
  ({ lat }) => {
    const T = [];
    const t0 = performance.now();
    const mark = (name) => T.push({ name, t: +(performance.now() - t0).toFixed(1) });
    window.__NP_TRACE = T;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const latOf = (cmd) =>
      cmd === "history_daily" ? lat.daily : cmd === "history_process_totals" ? lat.totals : lat.other;
    const retOf = (cmd) =>
      cmd === "history_daily" || cmd === "history_process_totals"
        ? "[]"
        : cmd === "history_range_days"
          ? 30
          : cmd === "history_stats"
            ? "{}"
            : null;

    const winObj = {
      show() { mark("win.show"); return Promise.resolve(); },
      setFocus() { mark("win.setFocus"); return Promise.resolve(); },
      isMaximized() { return Promise.resolve(false); },
      onResized() { mark("win.onResized"); return Promise.resolve(() => {}); },
      minimize() {}, toggleMaximize() {}, hide() {}, startResizeDragging() {},
      isVisible() { return Promise.resolve(true); },
    };

    window.__TAURI__ = {
      core: {
        async invoke(cmd) {
          mark("invoke:" + cmd);
          await sleep(latOf(cmd));
          return retOf(cmd);
        },
      },
      event: { async listen(name) { mark("listen:" + name); return () => {}; }, async emit() {} },
      window: { getCurrentWindow: () => winObj },
    };

    // 幕布摘掉的时刻 + 摘掉的原因。dismiss() 在淡出**之前**就写好了
    // dataset.dismissedBy，所以在层还在的时候就能读到，不必等节点被删。
    let saw = false;
    const iv = setInterval(() => {
      const el = document.getElementById("bootLayer");
      if (el) {
        saw = true;
        if (el.dataset.dismissedBy && !window.__NP_WHY) {
          window.__NP_WHY = el.dataset.dismissedBy;
          mark("dismiss.begin:" + el.dataset.dismissedBy);
        }
      } else if (saw) {
        mark("curtain.lifted");
        clearInterval(iv);
      }
    }, 8);
  },
  { lat: LAT },
);

await page.goto(pathToFileURL(APP).href, { waitUntil: "load" });
try {
  await page.waitForFunction("!document.getElementById('bootLayer')", null, { timeout: 15000 });
} catch {
  /* 没摘掉也把已有时间线打出来，下面的断言会报 */
}
await page.waitForTimeout(250);

const trace = await page.evaluate(() => window.__NP_TRACE);
const why = await page.evaluate(() => window.__NP_WHY ?? null);
await browser.close();

const at = (n) => trace.find((e) => e.name === n)?.t ?? null;

if (verbose) {
  console.log(`=== 时间线（IPC 模拟延迟 ${mode}：${JSON.stringify(LAT)} 毫秒）===\n`);
  for (const e of trace) console.log(`  ${String(e.t).padStart(8)} ms  ${e.name}`);
  console.log();
}

const listen = at("listen:snapshot");
const show = at("win.show");
const lifted = at("curtain.lifted");

const fails = [];
const notes = [];

// A 无丢帧窗口
if (listen === null || show === null) {
  fails.push(`A 量不到 listen:snapshot 或 win.show（listen=${listen} show=${show}）`);
} else if (listen >= show) {
  fails.push(
    `A 存在丢帧窗口 ${(listen - show).toFixed(1)}ms：监听 ${listen}ms 晚于显示 ${show}ms —— ` +
      `这段窗口内发出的快照帧会全部丢失（首帧带全量图标）`,
  );
} else {
  notes.push(`A 无丢帧窗口：监听 ${listen}ms 早于显示 ${show}ms（余量 ${(show - listen).toFixed(1)}ms）`);
  // 余量太薄就等于没有：真机上 listen 是一次真实 IPC，完成时刻会晚于这里的登记时刻。
  if (show - listen < 10) notes.push(`  ⚠ 余量不足 10ms，真机上 listen 的 IPC 往返可能吃掉它`);
}

// B 动效下限
if (lifted === null) {
  fails.push("B 幕布始终没被摘掉");
} else if (lifted < ANIM_FLOOR) {
  fails.push(`B 幕布 ${lifted}ms 就摘了，早于动效下限 ${ANIM_FLOOR}ms —— 动效会被截断`);
} else {
  notes.push(`B 幕布 ${lifted}ms 摘掉（动效下限 ${ANIM_FLOOR}ms，动效后富余 ${(lifted - ANIM_FLOOR).toFixed(1)}ms）`);
}

// C 就绪而非超时
if (why === null) {
  // 层被摘掉但没读到原因：几乎只可能是摘得比轮询还快
  notes.push("C 没读到 dismissedBy（层摘得太快）");
} else if (why === "ready") {
  notes.push("C 由 ready() 摘掉 —— 启动链在预算内跑完了 ✓");
} else if (why === "timeout") {
  fails.push("C 由 timeout 摘掉 —— 启动链超出了 4.0s 预算，用户看到一个没准备好的界面");
} else if (why === "hard-cap") {
  fails.push("C 由 hard-cap 摘掉 —— 6.0s 硬上限兜底，init 链里有一环挂住了");
} else {
  notes.push(`C dismissedBy = ${why}`);
}

// 启动链里两个查库步骤的串行代价（只报，不断言：它们本来就在预算内）
const dailyStart = at("invoke:history_daily");
const totalsStart = at("invoke:history_process_totals");

console.log(`boot-trace（IPC 模拟延迟 ${mode}）`);
console.log(`  应用文档 ${path.relative(process.cwd(), APP)}`);
console.log();
for (const n of notes) console.log(`  · ${n}`);
if (dailyStart !== null && totalsStart !== null) {
  console.log(
    `  · 两个查库步骤串行占用 ${(totalsStart - dailyStart).toFixed(1)}ms` +
      `（两者互不依赖；动效预算 ${ANIM_FLOOR}ms，目前有富余，暂不必并行化）`,
  );
}
console.log();

if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log(`\n失败 ${fails.length} 项`);
  process.exit(1);
}
console.log("全部通过");
