// tools/rasterize.mjs — 用 Playwright + 系统 Chrome 做确定性光栅化与定点截帧。
//
// 为什么不用 chrome.exe 命令行 headless：本机 Chrome 152 的 `--headless --screenshot`
// 会静默挂死（见项目记忆 2026-09-11），所以统一走 Playwright 通道。
//
// 用法：
//   node tools/rasterize.mjs <in.svg|in.html> --out x.png [--w 1254] [--h 1254]
//        [--scale 1] [--bg white|transparent] [--sel "#logo-root"]
//        [--query "?t=700"] [--p2m-ready] [--wait 0]
//
// 环境变量：
//   NP_PW     playwright-core 的 index.mjs 路径（默认取受管 node 工作区那份）
//   NP_CHROME 浏览器可执行文件（默认为系统 Chrome）

import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_PW = "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs";
const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function parseArgs(argv) {
  const a = { scale: 1, bg: "white", out: null, w: null, h: null, sel: null, query: "", p2m: false, wait: 0 };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--out") a.out = argv[++i];
    else if (t === "--w") a.w = parseInt(argv[++i], 10);
    else if (t === "--h") a.h = parseInt(argv[++i], 10);
    else if (t === "--scale") a.scale = parseFloat(argv[++i]);
    else if (t === "--bg") a.bg = argv[++i];
    else if (t === "--sel") a.sel = argv[++i];
    else if (t === "--query") a.query = argv[++i];
    else if (t === "--wait") a.wait = parseInt(argv[++i], 10);
    else if (t === "--p2m-ready") a.p2m = true;
    else pos.push(t);
  }
  a.input = pos[0];
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args.out) {
  console.error("用法: node rasterize.mjs <in.svg|in.html> --out x.png [--w N --h N --scale N --bg white|transparent --sel SEL --query '?t=700' --p2m-ready]");
  process.exit(2);
}

const inputAbs = path.resolve(args.input);
if (!fs.existsSync(inputAbs)) {
  console.error(`输入不存在: ${inputAbs}`);
  process.exit(2);
}
const isSvg = inputAbs.toLowerCase().endsWith(".svg");

const { chromium } = await import(process.env.NP_PW || DEFAULT_PW);

// SVG 走一层包壳 HTML：img 指向 SVG 文件，尺寸严格等于目标像素，零边距。
let pageUrl;
let tmpHtml = null;
if (isSvg) {
  const vb = fs.readFileSync(inputAbs, "utf8").match(/viewBox\s*=\s*"([^"]+)"/);
  const parts = vb ? vb[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 512, 512];
  const w = args.w ?? Math.round(parts[2]);
  const h = args.h ?? Math.round(parts[3]);
  args.w = w;
  args.h = h;
  const bgCss = args.bg === "transparent" ? "transparent" : "#ffffff";
  tmpHtml = path.join(path.dirname(args.out), `.rasterize-${Date.now()}.html`);
  fs.mkdirSync(path.dirname(tmpHtml), { recursive: true });
  fs.writeFileSync(
    tmpHtml,
    `<!doctype html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:${bgCss};}
       img{display:block;width:${w}px;height:${h}px;}
     </style></head><body><img src="${pathToFileURL(inputAbs).href}"></body></html>`,
    "utf8"
  );
  pageUrl = pathToFileURL(tmpHtml).href;
} else {
  pageUrl = pathToFileURL(inputAbs).href + (args.query || "");
}

const browser = await chromium.launch({
  executablePath: process.env.NP_CHROME || DEFAULT_CHROME,
  args: ["--no-sandbox", "--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"],
});
const ctx = await browser.newContext({
  viewport: args.w && args.h ? { width: args.w, height: args.h } : undefined,
  deviceScaleFactor: args.scale,
  colorScheme: "light",
  // 必须显式关掉 reduced-motion：本机若在「辅助功能 → 显示动画」里关了动画，
  // Chrome 会把 prefers-reduced-motion 报成 reduce，而 boot.css 的降级分支是
  // 「删掉所有动画、直接落在终帧」——那样每一个 ?t= 截帧都会长得一模一样，
  // 极容易被误读成「时间线没生效」。截帧要的是真实播放路径。
  reducedMotion: "no-preference",
});
const page = await ctx.newPage();
await page.goto(pageUrl, { waitUntil: "load" });
if (args.p2m) await page.waitForFunction("window.__p2mReady === true", null, { timeout: 20000 });
if (args.wait) await page.waitForTimeout(args.wait);

fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
if (args.sel) {
  await page.locator(args.sel).screenshot({ path: args.out, omitBackground: args.bg === "transparent" });
} else {
  await page.screenshot({ path: args.out, omitBackground: args.bg === "transparent", fullPage: false });
}

await browser.close();
if (tmpHtml) { try { fs.unlinkSync(tmpHtml); } catch {} }
console.log(`rasterized -> ${args.out}`);
