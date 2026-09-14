// tools/verify_integration.mjs — 在真实应用文档（ui/index.html）上验启动动效的接入。
//
// 为什么不满足于审阅页的 QA：
//   logo_motion.html 是自建的脚手架，它把 .frame 的表面、box-sizing、脚本顺序都
//   复刻了一遍。复刻得再准也只是「我以为应用是这样」。真实的接入点有三处容易脱节，
//   而且都只有真的加载应用文档才看得见：
//     · z-index 有没有真的压住缩放热区和右键菜单；
//     · .frame 的 1px 边框让启动层实际只有 1178×718，版式会不会因此偏位；
//     · boot.js 的拆卸时机对不对（早卸 → 露出没就绪的界面；不卸 → 一片死黑）。
//   浏览器里跑没有 __TAURI__，走的是各处的降级分支，正好也是该验的路径。
//
// 用法：
//   node tools/verify_integration.mjs --out-dir outputs/integration [--times 0,900,2000]
//
// 断言：
//   O 遮挡     t=0 时窗口内部必须是一片纯底色（任何界面元素透出来都算失败）
//   P 版式     启动层在应用里的实际尺寸 == 1178×718（.frame 的 padding box）
//   Q 卸载     调 ready() 后启动层必须被移除，且移除后界面可见
//   R 兜底     不调 ready() 时，超时后也必须自己卸下

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_PW = "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function parseArgs(argv) {
  // 采样点要落在动效的「代表帧」上：0 = 起手（遮挡判定用），
  // 900 = 主波描到一半（最有辨识度的一帧），2000 = 字标刚擦完（动效终态）。
  const a = { outDir: null, times: "0,900,2000", w: 1180, h: 720, app: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--out-dir") a.outDir = argv[++i];
    else if (t === "--times") a.times = argv[++i];
    else if (t === "--app") a.app = argv[++i];
    else pos.push(t);
  }
  a.input = pos[0] || a.app;
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) {
  console.error("用法: node verify_integration.mjs <ui/index.html> --out-dir DIR [--times 0,900,2000]");
  process.exit(2);
}

const appAbs = path.resolve(args.input);
if (!fs.existsSync(appAbs)) { console.error(`找不到 ${appAbs}`); process.exit(2); }
const outDir = path.resolve(args.outDir || path.join(path.dirname(appAbs), ".boot-verify"));
fs.mkdirSync(outDir, { recursive: true });
const times = args.times.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite);

const { chromium } = await import(process.env.NP_PW || DEFAULT_PW);

const fails = [];
const notes = [];
const shot = (p) => path.join(outDir, p);

const browser = await chromium.launch({
  executablePath: process.env.NP_CHROME || DEFAULT_CHROME,
  args: ["--no-sandbox", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"],
});

async function ctx(reduced = "no-preference") {
  return browser.newContext({
    viewport: { width: args.w, height: args.h },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: reduced,
  });
}

async function settle(page, n = 2) {
  for (let i = 0; i < n; i++) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  }
}

// ---------- 主线：手动就绪 ----------
{
  const c = await ctx();
  const page = await c.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));

  await page.goto(pathToFileURL(appAbs).href, { waitUntil: "load" });
  await page.waitForFunction("!!window.NetPeekBoot", null, { timeout: 15000 });
  await page.waitForFunction("!!document.getElementById('bootLayer')", null, { timeout: 5000 });

  // P 版式：启动层的实际盒
  const box = await page.evaluate(() => {
    const l = document.getElementById("bootLayer");
    const r = l.getBoundingClientRect();
    const svg = document.getElementById("np-lockup").getBoundingClientRect();
    return {
      layer: [Math.round(r.width), Math.round(r.height)],
      svg: [Math.round(svg.width), Math.round(svg.height)],
      z: getComputedStyle(l).zIndex,
      bg: getComputedStyle(l).backgroundColor,
    };
  });
  notes.push(`P 启动层盒 ${box.layer[0]}×${box.layer[1]}，SVG ${box.svg[0]}×${box.svg[1]}，z-index ${box.z}，底色 ${box.bg}`);
  // 注意 SVG 那两个数**不是**布局值：量这一下的时候 np-rise 正在跑，
  // #np-lockup 上挂着 translateY + scale(0.985→1)，getBoundingClientRect 返回的是
  // 缩放后的框（读数约 0.99 倍）。层盒（1178×718）之所以稳，是因为入场变换挂在
  // 子元素 #np-lockup 上、不在 .np-boot 上 —— 这也是断言只卡层盒的原因。
  // 版式的权威读数是 qa_motion.py 的 F 断言（在静态终帧上量，无变换）。
  // .frame 有 1px 边框 + border-box，所以启动层（inset:0 于 padding box）是 1178×718
  if (box.layer[0] !== 1178 || box.layer[1] !== 718) {
    fails.push(`P 启动层盒应为 1178×718（.frame 的 padding box），实为 ${box.layer.join("×")}`);
  }
  if (box.z !== "100") fails.push(`P z-index 应为 100（--z-boot），实为 ${box.z}`);
  if (!/rgb/.test(box.bg) || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(box.bg)) {
    fails.push(`P 启动层底色不透明，实为 ${box.bg}`);
  }

  // 逐时刻冻结 + 截图
  for (const t of times) {
    await page.evaluate((ms) => {
      const layer = document.getElementById("bootLayer");
      for (const a of layer.getAnimations({ subtree: true })) { a.pause(); a.currentTime = ms; }
    }, t);
    await settle(page, 3);
    await page.screenshot({ path: shot(`app_${String(t).padStart(4, "0")}.png`) });
  }

  // O 遮挡：把时间线按回 0 再拍一张内部平铺图，交给下面的 Python 侧判「有没有东西透出来」
  await page.evaluate(() => {
    const layer = document.getElementById("bootLayer");
    for (const a of layer.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 0; }
  });
  await settle(page, 3);
  await page.screenshot({ path: shot("app_flat.png") });

  // Q 卸载
  await page.evaluate(() => window.NetPeekBoot.ready());
  let gone = true;
  try {
    // 超时要留够：ready() 只是把 appReady 置真，tick() 仍要等「至少播完一遍」
    // （TOTAL 2400ms）才动手，之后还有 460ms 的退场。合计可达 3s。
    // 卡 4000ms 会在机器稍慢时假红 —— 而假红比不测更坏，它会训练人忽略这条断言。
    await page.waitForFunction("!document.getElementById('bootLayer')", null, { timeout: 8000 });
  } catch { gone = false; }
  await settle(page, 3);
  await page.screenshot({ path: shot("app_after.png") });
  if (!gone) fails.push("Q 调 ready() 后启动层仍留在 DOM 里");
  else notes.push("Q ready() 后启动层已移除 ✓");
  notes.push(`Q boot.js 状态 ${JSON.stringify(await page.evaluate(() => window.NetPeekBoot.state))}`);

  if (errs.length) notes.push(`Q 页面错误 ${errs.length} 条：${errs.slice(0, 3).join(" | ")}`);
  await c.close();
}

// ---------- R 兜底：不调 ready()，超时必须自己卸 ----------
{
  const c = await ctx();
  const page = await c.newPage();
  await page.goto(pathToFileURL(appAbs).href, { waitUntil: "load" });
  await page.waitForFunction("!!window.NetPeekBoot", null, { timeout: 15000 });
  const t0 = Date.now();
  let ok = false;
  try {
    await page.waitForFunction("!document.getElementById('bootLayer')", null, { timeout: 12000 });
    ok = true;
  } catch { /* 见下 */ }
  const dt = Date.now() - t0;
  if (!ok) fails.push("R 未调 ready() 时启动层没有在超时后自行卸下（用户会被关在启动页里）");
  else notes.push(`R 未就绪时 ${dt}ms 自行卸下 ✓`);
  await page.screenshot({ path: shot("app_fallback.png") });
  await c.close();
}

// ---------- reduced-motion ----------
{
  const c = await ctx("reduce");
  const page = await c.newPage();
  await page.goto(pathToFileURL(appAbs).href, { waitUntil: "load" });
  await page.waitForFunction("!!window.NetPeekBoot", null, { timeout: 15000 });
  await settle(page, 3);
  await page.screenshot({ path: shot("app_reduced.png") });
  const cls = await page.evaluate(() => document.getElementById("bootLayer")?.className ?? "(已移除)");
  notes.push(`S reduced-motion 下启动层类名：${cls}`);
  await c.close();
}

// ---------- 浅底皮肤 ----------
// 手法是把 tokens.css 的响应改掉、在后面续一段浅色令牌再喂给页面，
// 而不是「加载完再改 CSS 变量」—— 后者改不动配色：boot.js 是在首绘那两帧里
// 读亮度定配色的，那时已经定完了，事后再改只会验出一个假象。
{
  const c = await ctx();
  const page = await c.newPage();
  // file:// 下 route.fetch() 不可用（协议不支持），直接读盘再整体 fulfill：
  // 这份 tokens.css 必须和页面同源同路径，所以从应用目录里读，不另存副本。
  const tokensPath = path.join(path.dirname(appAbs), "tokens.css");
  await page.route("**/tokens.css", async (route) => {
    const light = `\n:root{--bg:#f2f3f5;--panel:#ffffff;--panel-hi:#eef0f4;--panel-2:#e8eaee;
      --line:#d6dade;--line-soft:#e4e6ea;--text:#23272e;--text-2:#5b6270;--text-3:#9098a4;
      --accent:#2f3540;--accent-ink:#f2f3f5;--sel-bar:#565e6b;}\n`;
    await route.fulfill({
      status: 200,
      contentType: "text/css",
      body: fs.readFileSync(tokensPath, "utf8") + light,
    });
  });
  await page.goto(pathToFileURL(appAbs).href, { waitUntil: "load" });
  await page.waitForFunction("!!window.NetPeekBoot", null, { timeout: 15000 });
  await page.waitForFunction("!!document.getElementById('bootLayer')", null, { timeout: 5000 });
  const cls = await page.evaluate(() => document.getElementById("bootLayer").className);
  if (!cls.includes("is-light-bg")) {
    fails.push(`T 浅底皮肤下没有挂上 is-light-bg（实际类名：${cls}）`);
  } else {
    notes.push(`T 浅底皮肤识别正确，类名：${cls}`);
  }
  // 采样时刻与深底那组（--times 0,900,2000）保持一致：
  // 浅底证据要和深底**同刻可比**，否则「浅底也没问题」这句话就没有对照物。
  for (const t of [900, 2000]) {
    await page.evaluate((ms) => {
      const layer = document.getElementById("bootLayer");
      for (const a of layer.getAnimations({ subtree: true })) { a.pause(); a.currentTime = ms; }
    }, t);
    await settle(page, 3);
    await page.screenshot({ path: shot(`app_light_${String(t).padStart(4, "0")}.png`) });
  }
  await c.close();
}

await browser.close();

console.log(`截图 -> ${outDir}`);
console.log();
for (const n of notes) console.log(`  · ${n}`);
console.log();
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log(`\n失败 ${fails.length} 项`);
  process.exit(1);
}
console.log("全部通过");
