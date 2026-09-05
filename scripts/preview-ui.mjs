// NetPeek UI 预览脚手架（开发期工具，不属于发布物）。
// 用法：node scripts/preview-ui.mjs
// 原理：把 ui/ 复制到临时目录并注入 window.__TAURI__ 假桥（快照/历史/设置命令全部伪造），
// 起本地 HTTP 服务（file:// 会污染画布，取色链路走不通），无头 Chrome + CDP 截四个屏。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '..');
const uiSrc = path.join(repo, 'src', 'NetPeek.App', 'ui');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netpeek-preview-'));
const uiDir = path.join(work, 'ui');
fs.cpSync(uiSrc, uiDir, { recursive: true });

// ---- 注入假桥：插到 <head> 最前，先于所有脚本 ----
const STUB = `<script>
window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      if (cmd === 'history_daily') {
        const rows = [];
        const names = ['verge-mihomo', 'msedge', 'chrome', 'QQ', 'ZCode', 'steam'];
        for (let d = 0; d < 30; d++) {
          const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
          names.forEach((n, i) => rows.push({ day, name: n, down: Math.round((1 + i) * 1e6 * (1 + (d % 7) / 3)), up: Math.round(3e5 * (i + 1)) }));
        }
        return JSON.stringify(rows);
      }
      if (cmd === 'history_range') {
        var start = Math.floor(args.start || 0), end = Math.floor(args.end || Date.now() / 1000);
        var bucket = Math.floor(args.bucket || 86400);
        var names = ['steam', 'ZCode', 'QQ', 'chrome', 'msedge', 'verge-mihomo'];
        var rows = [];
        for (var ts = Math.floor(start / 60) * 60; ts < end; ts += 300) {
          names.forEach(function (n, i) {
            var wave = Math.round((1 + Math.sin(ts / 86400 + i) / 2) * (i + 1) * 1e6);
            var d = new Date(ts * 1000); d.setHours(0, 0, 0, 0);
            var key = bucket === 3600 ? Math.floor(ts / 3600) * 3600 : Math.floor(d.getTime() / 1000);
            rows.push({ ts: key, name: n, down: wave, up: Math.round(wave / 6) });
          });
        }
        return JSON.stringify(rows);
      }
      if (cmd === 'history_stats') return JSON.stringify({ rows: 1700, bytes: 4.1 * 1024 * 1024, firstDay: '2026-08-07', lastDay: '2026-09-05' });
      if (cmd === 'load_settings') return '{}';
      if (cmd === 'get_autostart') return false;
      if (cmd === 'data_dir_path') return 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\com.netpeek.app';
      if (cmd === 'load_theme_config') return localStorage.getItem('netpeek-theme') || '';
      if (cmd === 'save_theme_config') { localStorage.setItem('netpeek-theme', args.json); return; }
      if (cmd === 'save_background_image') return 'C:/fake/bg.png';
      if (cmd === 'read_background_image') return '';
      return '';
    },
    convertFileSrc: (p) => p,
  },
  event: {
    _h: {},
    listen: (name, fn) => { (window.__TAURI__.event._h[name] ||= []).push(fn); return Promise.resolve(); },
    emit: async (name, payload) => {
      // 主窗发出的广播转给同页监听者（单页预览里 mini 不存在）
      (window.__TAURI__.event._h[name] || []).forEach((f) => f({ payload }));
    },
  },
};
// 1 秒一帧假快照，喂进程表与图表
let tick = 0;
setInterval(() => {
  tick++;
  const mk = (name, pid, down, up, dt, ut) => ({ Pid: pid, Name: name, DownloadBytes: down + Math.round(400 * Math.sin(tick / 3 + pid)), UploadBytes: up, DownloadTotal: dt, UploadTotal: ut, RetransmitTotal: 0, Path: 'C:/Program Files/' + name + '.exe', IconBase64: '' });
  const snap = {
    TimestampUnixMs: Date.now(), Status: 'ok', EventsLost: 0,
    TotalDownloadBytes: 350000, TotalUploadBytes: 120000,
    Processes: [
      mk('verge-mihomo', 33252, 220000, 60000, 37000000, 90000000),
      mk('msedge', 20536, 60000, 20000, 15000000, 3000000),
      mk('msedgewebview2', 44144, 40000, 8000, 9000000, 800000),
      mk('QQ', 12392, 15000, 12000, 1200000, 5000000),
      mk('ZCode', 40104, 9000, 9000, 800000, 7000000),
      mk('steam', 12976, 3000, 5000, 500000, 2000000),
      mk('svchost', 3032, 1200, 1100, 400000, 300000),
      mk('Weixin', 43212, 800, 600, 300000, 400000),
    ],
  };
  (window.__TAURI__.event._h.snapshot || []).forEach((f) => f({ payload: snap }));
}, 1000);
<\/script>`;

const html = fs.readFileSync(path.join(uiSrc, 'index.html'), 'utf8');
fs.writeFileSync(path.join(uiDir, 'preview.html'), html.replace('<head>', '<head>' + STUB));

// 把 main.js 里被吞掉的 init 异常暴露出来，便于诊断
const mainSrc = fs.readFileSync(path.join(uiDir, 'main.js'), 'utf8');
fs.writeFileSync(path.join(uiDir, 'main.js'),
  'window.__PREVIEW_ERR = "";window.addEventListener("unhandledrejection", (e) => { window.__PREVIEW_ERR += "REJECTION: " + (e.reason && e.reason.stack || e.reason); });\n'
  + mainSrc.replace('catch { /* 用默认令牌 */ }',
    'catch (e) { window.__PREVIEW_ERR += "THEME INIT: " + (e && e.stack || e); }'));

// ---- 本地 HTTP 服务 ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/preview.html' : req.url.split('?')[0];
  const file = path.join(uiDir, decodeURIComponent(url));
  if (!file.startsWith(uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(8931, '127.0.0.1', r));

// ---- 无头 Chrome + CDP ----
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const shotDir = path.join(work, 'shots');
fs.mkdirSync(shotDir);
const proc = spawn(chrome, [
  '--headless=new', '--remote-debugging-port=0', '--window-size=1180,720',
  '--user-data-dir=' + path.join(work, 'profile'), '--no-first-run',
  'about:blank',
], { stdio: 'pipe' });
proc.stderr.on('data', (d) => {
  const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
  if (m) drive(m[1]);
});
proc.on('exit', () => server.close());
setTimeout(() => { try { proc.kill(); } catch {} server.close(); process.exit(0); }, 60000);

async function drive(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  let sessionId = null;
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params, sessionId: sessionId || undefined }));
  });

  // attach 到页面级会话（browser 会话没有 Page 域）
  const created = await send('Target.createTarget', { url: 'about:blank' });
  const attached = await send('Target.attachToTarget', { targetId: created.result.targetId, flatten: true });
  sessionId = attached.result.sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 720, deviceScaleFactor: 1, mobile: false });
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 2600)); // 等两帧快照进来
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r.result) {
      console.error('shot failed:', name, JSON.stringify(r.error));
      return;
    }
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
    console.log('shot:', name);
  };

  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8931/preview.html' });
  await new Promise((r) => setTimeout(r, 3500));
  const err = await evalJs(`window.__PREVIEW_ERR || ''`);
  if (err) console.error('PAGE ERROR:', err.slice(0, 800));
  console.log('bg-state:', await evalJs(`document.body.className + ' | ' + getComputedStyle(document.documentElement).getPropertyValue('--theme-bg-image').slice(0, 80)`));
  await shot('1-live');

  await evalJs(`document.querySelector('.nav-item[data-screen="history"]').click()`);
  await shot('2-history');
  await evalJs(`document.querySelector('.nav-item[data-screen="theme"]').click()`);
  await shot('3-theme');
  await evalJs(`document.querySelector('details.adv').open = true; 'ok'`);
  console.log('form-scroll:', await evalJs(`(() => { const f = document.querySelector('.form'); return JSON.stringify({ client: f.clientHeight, scroll: f.scrollHeight }); })()`));
  await shot('4-theme-advanced');
  await evalJs(`document.querySelector('.form').scrollTop = 99999; 'ok'`);
  await shot('4b-form-bottom');
  await evalJs(`document.querySelector('.nav-item[data-screen="settings"]').click()`);
  console.log('insp-parts:', await evalJs(`(() => {
    const i = document.querySelector('.pane[data-screen="settings"] .inspector');
    const parts = JSON.stringify([...i.children].map((s) => Math.round(s.getBoundingClientRect().height)));
    return 'client=' + i.clientHeight + ' parts=' + parts + ' scroll=' + i.scrollHeight;
  })()`));
  await shot('5-settings');

  // 交互测试：内联重命名 + 应用主题
  await evalJs(`document.querySelector('.nav-item[data-screen="theme"]').click(); 'ok'`);
  await evalJs(`document.querySelector('details.adv').open = true; 'ok'`);
  await evalJs(`{ const i = document.querySelector('.rename-input') || (document.querySelector('[data-act="rename"]'), null); 'ok' }`);
  await evalJs(`document.querySelector('[data-act="rename"]').click(); 'ok'`);
  await evalJs(`{ const i = document.querySelector('.rename-input'); i.value = '默认深色'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); 'ok' }`);
  await shot('7-renamed');
  await evalJs(`document.querySelector('[data-act="use"]').click(); 'ok'`);
  await shot('8-use-theme');

  // 无背景态：清掉壁纸看空态与材质禁用
  await evalJs(`document.querySelector('.nav-item[data-screen="theme"]').click(); 'ok'`);
  await evalJs(`document.getElementById('bgClear').click(); 'ok'`);
  // 前面的交互把折叠块留在展开、表单滚到底的状态；无背景态要拍的是壁纸条与禁用的滑杆
  await evalJs(`document.querySelector('details.adv').open = false; document.querySelector('.form').scrollTop = 0; 'ok'`);
  await shot('6-nobg');
  console.log('shots dir:', shotDir);
  process.exit(0);
}
