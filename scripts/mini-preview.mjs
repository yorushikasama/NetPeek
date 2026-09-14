// NetPeek 小窗（迷你窗 / 能量球）截图与广播 E2E 验证。
//
// 为什么存在：主窗有 scripts/preview-v2.mjs，但小窗是独立 webview（mini.html），
// 主窗 harness 覆盖不到。小窗链路的回归（theme-changed 广播、能量球渲染、
// 全局不透明度）全靠这个脚本 —— 它躺在 .workbuddy/tmp 里被清掉过一次，现迁入
// scripts/ 成为永久工具。
//
// 用法：NP_PW=<playwright 入口 file:// URL> NP_CHROME=<chrome 路径> node scripts/mini-preview.mjs
// 产出：.workbuddy/tmp/v2shots/mini-orb.png（能量球 2x）、mini-panel.png（迷你窗 2x），
//       控制台输出 ui-opacity 广播断言（期望 0.6）与页面错误。
// 原理：ui/ 复制到临时目录，注入 window.__TAURI__ 假桥（事件总线 + 假帧），
//       起 HTTP（127.0.0.1:8941）后 Playwright 截图；再向 mini 发一条带
//       uiOpacity: 0.6 的 theme-changed，断言根变量 --ui-opacity 变成 0.6、
//       而 .orb 整层 opacity 恒为 1（只淡球漆不淡数字）。
// 注意：能量球截图先于广播发出，保存的是 100% 不透明的状态。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(HERE, '..');
const uiSrc = path.join(repo, 'src', 'NetPeek.App', 'ui');
const outDir = path.join(repo, '.workbuddy', 'tmp', 'v2shots');
fs.mkdirSync(outDir, { recursive: true });

const pw = await import(process.env.NP_PW);
const chromium = pw.chromium || pw.default.chromium;

// ---- 假桥：事件总线 + 假快照帧。行数组拼接，规避模板字符串里的转义坑。 ----
const STUB_LINES = [
  "window.__ERR = '';",
  "addEventListener('error', (e) => { window.__ERR += 'ERROR:' + ((e.error && e.error.stack) || e.message); });",
  "addEventListener('unhandledrejection', (e) => { window.__ERR += 'REJ:' + ((e.reason && e.reason.stack) || e.reason); });",
  "window.__TAURI__ = {",
  "  core: { invoke: async () => '', convertFileSrc: (p) => p },",
  "  event: { _h: {}, listen: (n, f) => { (window.__TAURI__.event._h[n] = window.__TAURI__.event._h[n] || []).push(f); return Promise.resolve(() => {}); },",
  "           emit: async (n, p) => { (window.__TAURI__.event._h[n] || []).forEach((f) => f({ payload: p })); } },",
  "  window: { getCurrentWindow: () => ({ startDragging: async () => {} }) },",
  "};",
  "const BOOT = Date.now(); let tick = 0;",
  "function mkFrame(status) {",
  "  tick++;",
  "  const procs = [['verge-mihomo', 33252, 2.4e6, 3.1e5], ['msedge', 20536, 8.6e5, 9.2e4]].map(([name, pid, down, up], i) => ({ Pid: pid, Name: name, Path: 'C:/x/' + name + '.exe', IconBase64: '',",
  "    StartTimeUnixMs: BOOT - (3600 + i * 900) * 1000,",
  "    DownloadBytes: Math.round(down * (1 + Math.sin(tick / 4 + i) * 0.3)), UploadBytes: Math.round(up * (1 + Math.sin(tick / 4 + i) * 0.3)),",
  "    DownloadTotal: down * 900, UploadTotal: up * 900, RetransmitTotal: 0, ConnectionCount: 3, TopRemoteIp: '', TopRemotePort: 0, TopRemoteCountry: '' }));",
  "  const td = procs.reduce((n, p) => n + p.DownloadBytes, 0); const tu = procs.reduce((n, p) => n + p.UploadBytes, 0);",
  "  return { TimestampUnixMs: Date.now(), Status: status, EventsLost: 0, TotalDownloadBytes: td, TotalUploadBytes: tu,",
  "    AttributedDownloadBytes: Math.round(td * 0.97), Processes: procs };",
  "}",
  "setInterval(() => { (window.__TAURI__.event._h.snapshot || []).forEach((f) => f({ payload: mkFrame('ok') })); }, 1000);",
  "setTimeout(() => { (window.__TAURI__.event._h.snapshot || []).forEach((f) => f({ payload: mkFrame('ok') })); }, 60);",
];
const STUB = '<scr' + 'ipt>' + STUB_LINES.join(String.fromCharCode(10)) + '</scr' + 'ipt>';

// ---- 临时目录 + HTTP ----
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-preview-'));
const uiDir = path.join(work, 'ui');
fs.cpSync(uiSrc, uiDir, { recursive: true });
const html = fs.readFileSync(path.join(uiSrc, 'mini.html'), 'utf8');
fs.writeFileSync(path.join(uiDir, 'preview.html'), html.replace('<head>', '<head>' + STUB));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const srv = http.createServer((req, res) => {
  const u = req.url === '/' ? '/preview.html' : req.url.split('?')[0];
  const fp = path.join(uiDir, decodeURIComponent(u));
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});
await new Promise((r) => srv.listen(8941, '127.0.0.1', r));

// ---- 主题令牌：广播断言用的完整 17 键（plain 出厂值） ----
const TOKENS = {
  bg: '#1b1d21', panel: '#22252a', panelHi: '#2c2f36', panel2: '#17191d',
  line: '#32363e', lineSoft: '#272a30', text: '#e3e5e9', text2: '#9ba1a9', text3: '#686e77',
  down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
  accent: '#e3e5e9', accentInk: '#1b1d21', selBar: '#c9cdd4',
};

const browser = await chromium.launch({ executablePath: process.env.NP_CHROME || undefined });
const pg = await browser.newPage({ viewport: { width: 108, height: 108 }, deviceScaleFactor: 2 });
await pg.goto('http://127.0.0.1:8941/preview.html', { waitUntil: 'load' });
await pg.evaluate(() => {
  document.body.style.background = '#17191d'; // 透明窗口截图需要一层深色假桌面
  window.__TAURI__.event.emit('win-visibility', { label: 'mini', visible: true });
});
await pg.waitForTimeout(2600);
await pg.screenshot({ path: path.join(outDir, 'mini-orb.png') });

// ---- 不透明度广播 E2E：主界面改 60%，能量球漆层跟着透、数字不淡 ----
// 只淡漆不淡字：.orb 的整层 opacity 恒为 1（速率数字是数据），淡出体现在
// 根变量与球漆各站的 alpha 上。断言旧实现（orb 整层 opacity = 0.6）会误判。
await pg.evaluate((tokens) => window.__TAURI__.event.emit('theme-changed', { tokens, uiOpacity: 0.6 }), TOKENS);
await pg.waitForTimeout(250);
const probe = await pg.evaluate(() => ({
  root: getComputedStyle(document.documentElement).getPropertyValue('--ui-opacity').trim(),
  orb: getComputedStyle(document.getElementById('orb')).opacity,
}));
console.log(`orb ui-opacity broadcast: var=${probe.root} orbOpacity=${probe.orb} ${probe.root === '0.6' && probe.orb === '1' ? 'OK' : 'FAIL'}`);
console.log(`page errors: ${await pg.evaluate(() => window.__ERR) || '(none)'}`);

// ---- 原生右键菜单抑制（§35 的模块在小窗也要生效）----
// 小窗里没有任何可复制的值，所以不该弹出自定义菜单；要验的是**原生菜单被拦下**。
// dispatchEvent 的返回值就是 preventDefault 的回执：false 表示被拦。
// 少了这条，context-menu.js 从小窗的 script 列表里被删掉也不会有人发现 ——
// 一个 108×108 的能量球上弹出「刷新 / 另存为」是最刺眼的那种疏漏。
const ctxMini = await pg.evaluate(() => {
  const orb = document.getElementById('orb');
  const notCancelled = orb.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, button: 2,
  }));
  const m = document.querySelector('.ctx-menu');
  return { suppressed: !notCancelled, customMenu: !!m && !m.hidden };
});
console.log(`mini ctxmenu suppressed=${ctxMini.suppressed} customMenu=${ctxMini.customMenu} `
  + `${ctxMini.suppressed && !ctxMini.customMenu ? 'OK' : 'FAIL'}`);

// ---- 迷你窗形态 ----
await pg.setViewportSize({ width: 344, height: 324 });
await pg.evaluate(() => { document.getElementById('orb').hidden = true; document.getElementById('panel').hidden = false; });
await pg.waitForTimeout(400);
await pg.screenshot({ path: path.join(outDir, 'mini-panel.png') });

await browser.close();
srv.close();
process.exit(0);
