// tools/capture_frames.mjs — 一次浏览器会话里连拍启动动效的确定性帧。
//
// 为什么不每帧起一次 Chrome：
//   一是慢（每帧约 2s 全在启动浏览器），二是**不确定**——每次 goto 都是冷启动，
//   首帧时序、字体、滤镜缓存状态都可能不一样，帧之间的差异就不纯是「动画在走」了。
//   连拍则是同一个渲染进程、同一份缓存，帧差只有时间差这一个变量。
//
// 为什么要单独验一次 URL 路径：
//   连拍走的是「JS 写 --np-t + is-capture」这条快路，
//   而命令行/自动化截帧走的是「?t=」那条路。两条路等价是这个工具可用的前提，
//   所以首帧专门用 ?t= 拍一张，交给 qa_motion.py 和连拍帧逐像素对。
//
// 用法：
//   node tools/capture_frames.mjs <in.html> --out-dir outputs/frames
//        [--times 0,140,300,...] [--w 1180] [--h 720] [--preset chrome] [--prefix boot]
//
// 产物：
//   <prefix>_0000.png …        各时刻帧
//   <prefix>_url.png           ?t=0 路径帧（应与 _0000 完全一致）
//   <prefix>_static.png        ?static=1 终帧（无条件终帧，不依赖动画跑得起来）
//   <prefix>_rm.png            prefers-reduced-motion:reduce 下的帧（应等于 _static）
//   frames.json                时刻表与文件清单

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_PW = "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

// 采样栅格必须是**均匀**的：qa_motion.py 的 C 断言按「px/帧」比推进量，
// 疏密不均会把它变成噪声。2400 是总时长（2000ms 动效 + 400ms 定格），
// 改动 boot.css 的时间线时，这里最后一个数必须跟着走到新的总时长 ——
// 否则末帧采样点早于终态，D 断言（末帧 == ?static=1）会以「量对了但比错了」的方式失败。
const DEFAULT_TIMES = "0,150,300,450,600,750,900,1050,1200,1350,1500,1650,1800,1950,2100,2250,2400";

function parseArgs(argv) {
  const a = { w: 1180, h: 720, times: DEFAULT_TIMES, preset: null, outDir: null, prefix: "boot" };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--out-dir") a.outDir = argv[++i];
    else if (t === "--times") a.times = argv[++i];
    else if (t === "--w") a.w = parseInt(argv[++i], 10);
    else if (t === "--h") a.h = parseInt(argv[++i], 10);
    else if (t === "--preset") a.preset = argv[++i];
    else if (t === "--prefix") a.prefix = argv[++i];
    else pos.push(t);
  }
  a.input = pos[0];
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.outDir) {
  console.error("用法: node capture_frames.mjs <in.html> --out-dir DIR [--times 0,100,...] [--w N --h N --preset chrome --prefix boot]");
  process.exit(2);
}

const inputAbs = path.resolve(args.input);
if (!fs.existsSync(inputAbs)) {
  console.error(`输入不存在: ${inputAbs}`);
  process.exit(2);
}
const outDir = path.resolve(args.outDir);
fs.mkdirSync(outDir, { recursive: true });

const times = args.times.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
if (!times.length) { console.error("--times 解析为空"); process.exit(2); }

const base = pathToFileURL(inputAbs).href;
const qs = (extra) => {
  const p = new URLSearchParams(extra);
  if (args.preset) p.set("preset", args.preset);
  return "?" + p.toString();
};

const { chromium } = await import(process.env.NP_PW || DEFAULT_PW);

async function newCtx(browser, reduced) {
  return browser.newContext({
    viewport: { width: args.w, height: args.h },
    deviceScaleFactor: 1,
    colorScheme: "light",
    reducedMotion: reduced,
  });
}

async function settle(page) {
  // 两帧：第一帧样式与新值算完，第二帧才真正上屏（含滤镜/渐变）
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const browser = await chromium.launch({
  executablePath: process.env.NP_CHROME || DEFAULT_CHROME,
  args: ["--no-sandbox", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"],
});

const written = { frames: [], };

// ---- 连拍 ----
{
  const ctx = await newCtx(browser, "no-preference");
  const page = await ctx.newPage();

  // 1) URL 路径：?t= 必须和后面 JS 写 --np-t 的结果一致
  await page.goto(base + qs({ bare: "1", t: String(times[0]) }), { waitUntil: "load" });
  await page.waitForFunction("window.__p2mReady === true", null, { timeout: 20000 });
  await settle(page);
  const urlPath = path.join(outDir, `${args.prefix}_url.png`);
  await page.screenshot({ path: urlPath, omitBackground: false });
  written.url_frame = path.basename(urlPath);

  // 2) 连拍：同一个页面、同一个渲染进程，只改 --np-t
  await page.goto(base + qs({ bare: "1" }), { waitUntil: "load" });
  await page.waitForFunction("window.__p2mReady === true", null, { timeout: 20000 });
  await settle(page);

  for (const t of times) {
    // 走页面自己的 seek()：连拍和「人在拖时间轴」看到的是同一套定位逻辑。
    // 不在这里另写一份 --np-t 之类的注入，否则两者迟早会分叉。
    await page.evaluate((ms) => {
      const boot = document.getElementById("boot");
      boot.classList.remove("is-static");
      boot.classList.add("is-capture");
      window.__npSeek(ms);
    }, t);
    await settle(page);
    const f = path.join(outDir, `${args.prefix}_${String(t).padStart(4, "0")}.png`);
    await page.screenshot({ path: f, omitBackground: false });
    written.frames.push({ t, file: path.basename(f) });
  }

  // 3) 静态终帧：动画被彻底删掉后的样子
  await page.goto(base + qs({ bare: "1", static: "1" }), { waitUntil: "load" });
  await page.waitForFunction("window.__p2mReady === true", null, { timeout: 20000 });
  await settle(page);
  const st = path.join(outDir, `${args.prefix}_static.png`);
  await page.screenshot({ path: st, omitBackground: false });
  written.static_frame = path.basename(st);

  await ctx.close();
}

// ---- reduced-motion 分支 ----
{
  const ctx = await newCtx(browser, "reduce");
  const page = await ctx.newPage();
  await page.goto(base + qs({ bare: "1" }), { waitUntil: "load" });
  await page.waitForFunction("window.__p2mReady === true", null, { timeout: 20000 });
  await settle(page);
  const rm = path.join(outDir, `${args.prefix}_rm.png`);
  await page.screenshot({ path: rm, omitBackground: false });
  written.rm_frame = path.basename(rm);
  await ctx.close();
}

await browser.close();

fs.writeFileSync(
  path.join(outDir, "frames.json"),
  JSON.stringify({ w: args.w, h: args.h, preset: args.preset, total: times[times.length - 1], ...written }, null, 2),
  "utf8"
);

console.log(`frames -> ${outDir}  (${times.length} 帧 + url/static/rm)`);
