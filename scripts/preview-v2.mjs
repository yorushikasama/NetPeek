// NetPeek v2 UI 预览（开发期工具，不属于发布物）。
// 用法：node scripts/preview-v2.mjs [outDir]
// 原理：ui/ 复制到临时目录，注入 window.__TAURI__ 假桥（快照 / 历史 / 设置命令全部伪造），
// 起本地 HTTP（file:// 会污染取色画布），Playwright 自带 chromium 按多档视口截图。
// 只读渲染，不改 ui/ 源文件。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const pw = await import(process.env.NP_PW || 'playwright');
const chromium = (pw.chromium || (pw.default && pw.default.chromium));

const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '..');
const uiSrc = path.join(repo, 'src', 'NetPeek.App', 'ui');
const outDir = path.resolve(process.argv[2] || path.join(repo, '.workbuddy', 'tmp', 'v2shots'));
fs.mkdirSync(outDir, { recursive: true });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'netpeek-v2-'));
const uiDir = path.join(work, 'ui');
fs.cpSync(uiSrc, uiDir, { recursive: true });

// ---- 假桥：插到 <head> 最前，先于所有 ui 脚本 ----
const STUB = `<script>
window.__PREVIEW_ERR = '';
// ECharts 的 tooltip formatter 抛错走 console.error，不进 window.onerror，
// 不接住的话悬浮卡悄悄消失、页面上却一点错误都不显示
{ const e = console.error.bind(console); console.error = (...a) => { window.__PREVIEW_ERR += '\\nCONSOLE: ' + a.map(String).join(' '); e(...a); }; }
window.addEventListener('error', (e) => { window.__PREVIEW_ERR += '\\nERROR: ' + (e.error && e.error.stack || e.message); });
window.addEventListener('unhandledrejection', (e) => { window.__PREVIEW_ERR += '\\nREJECTION: ' + (e.reason && e.reason.stack || e.reason); });

const DAY = 86400000;
function dayStr(back) {
  const d = new Date(Date.now() - back * DAY);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const HIST_NAMES = ['verge-mihomo', 'msedge', 'chrome', 'QQ', 'ZCode', 'steam', 'Weixin', '(系统/未归因)'];
function histRows(n) {
  const rows = [];
  for (let d = 0; d < n; d++) {
    HIST_NAMES.forEach((name, i) => {
      const wave = 1 + Math.abs(Math.sin(d / 3 + i));
      rows.push({ day: dayStr(d), name, down: Math.round((8 - i) * 4.2e8 * wave), up: Math.round((8 - i) * 5e7 * wave) });
    });
  }
  return rows;
}

window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      switch (cmd) {
        case 'history_daily': return JSON.stringify(histRows(Math.min(Number(args && args.days) || 30, 400)));
        case 'history_range_days': return JSON.stringify(histRows(30));
        case 'history_stats': return JSON.stringify({
          rows: 41870,
          bytes: 6.4 * 1024 * 1024,
          firstTs: Math.floor((Date.now() - 36 * DAY) / 1000),
          lastTs: Math.floor(Date.now() / 1000),
        });
        case 'load_settings': return '{}';
        case 'save_settings': return '';
        case 'get_autostart': return true;
        case 'data_dir_path': return 'C:\\\\Users\\\\you\\\\AppData\\\\Roaming\\\\com.netpeek.app';
        case 'collector_log_path': return 'C:\\\\ProgramData\\\\NetPeek\\\\logs\\\\collector-20260912.log';
        case 'country_db_info': return JSON.stringify({ source: 'embedded', build: '2026-09', path: '' });
        case 'load_theme_config': return localStorage.getItem('netpeek-theme') || '';
        case 'save_theme_config': localStorage.setItem('netpeek-theme', args.json); return '';
        case 'read_background_image': return '';
        default: return '';
      }
    },
    convertFileSrc: (p) => p,
  },
  event: {
    _h: {},
    listen: (name, fn) => { (window.__TAURI__.event._h[name] ||= []).push(fn); return Promise.resolve(() => {}); },
    emit: async (name, payload) => {
      (window.__TAURI__.event._h[name] || []).forEach((f) => f({ payload }));
    },
  },
};

// ---- 假快照：1s 一帧 ----
const PROCS = [
  ['verge-mihomo', 33252, 2.4e6, 3.1e5, '104.18.32.115', 443, 'US'],
  ['msedge', 20536, 8.6e5, 9.2e4, '2606:4700::6810:85e5', 443, 'US'],
  ['msedgewebview2', 44144, 4.1e5, 3.3e4, '20.190.160.20', 443, 'IE'],
  ['Weixin', 43212, 2.2e5, 1.4e5, '203.205.254.157', 8080, 'CN'],
  ['ZCode', 40104, 1.3e5, 1.1e5, '162.159.140.238', 443, 'US'],
  ['steam', 12976, 9.5e4, 1.2e4, '23.55.161.31', 27017, 'JP'],
  ['QQ', 12392, 4.4e4, 3.8e4, '183.47.100.33', 443, 'CN'],
  ['chrome', 9184, 2.8e4, 6.1e3, '142.251.42.238', 443, 'US'],
  ['svchost', 3032, 1.2e4, 9.4e3, '192.168.1.1', 53, ''],
  ['OneDrive', 15528, 6.2e3, 4.4e4, '13.107.42.14', 443, 'US'],
  ['Spotify', 22188, 3.1e3, 1.1e3, '35.186.224.47', 4070, 'NL'],
  ['(系统/未归因)', 0, 2.1e3, 1.4e3, '', 0, ''],
];
// 进程启动时刻必须在整个会话里恒定：行 key 是 Pid:StartTimeUnixMs，每帧用
// Date.now() 重算会让 key 每秒都变，选中的行下一帧就对不上、检查栏永远退回总览。
// 真实采集端报的是进程真实启动时刻，不会漂。
const BOOT = Date.now();
let tick = 0;
// 暂停态截图用：探针把状态切到 paused，下一帧起曲线尾段转虚线
let frameStatus = 'ok';
window.__setStatus = (s) => { frameStatus = s; };
function frame() {
  tick++;
  const procs = PROCS.map(([name, pid, down, up, ip, port, cc], i) => {
    const jitter = 1 + Math.sin(tick / 4 + i) * 0.35;
    return {
      Pid: pid, Name: name, Path: pid ? 'C:\\\\Program Files\\\\' + name + '\\\\' + name + '.exe' : '',
      IconBase64: '', StartTimeUnixMs: BOOT - (3600 + i * 900) * 1000,
      DownloadBytes: Math.round(down * jitter), UploadBytes: Math.round(up * jitter),
      DownloadTotal: Math.round(down * 900), UploadTotal: Math.round(up * 900), RetransmitTotal: Math.round(up * 3),
      ConnectionCount: 3 + (i % 7),
      TopRemoteIp: ip, TopRemotePort: port, TopRemoteCountry: cc,
    };
  });
  const totalDown = procs.reduce((n, p) => n + p.DownloadBytes, 0);
  const totalUp = procs.reduce((n, p) => n + p.UploadBytes, 0);
  return {
    TimestampUnixMs: Date.now(), Status: frameStatus, EventsLost: 0,
    TotalDownloadBytes: totalDown, TotalUploadBytes: totalUp,
    AttributedDownloadBytes: Math.round(totalDown * 0.97),
    Processes: procs,
  };
}
setInterval(() => {
  (window.__TAURI__.event._h.snapshot || []).forEach((f) => f({ payload: frame() }));
}, 1000);
setTimeout(() => {
  (window.__TAURI__.event._h['pipe-status'] || []).forEach((f) => f({ payload: 'connected' }));
  (window.__TAURI__.event._h.snapshot || []).forEach((f) => f({ payload: frame() }));
}, 60);
<\/script>`;

const html = fs.readFileSync(path.join(uiSrc, 'index.html'), 'utf8');
fs.writeFileSync(path.join(uiDir, 'preview.html'), html.replace('<head>', '<head>' + STUB));

// ---- 本地 HTTP ----
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/preview.html' : req.url.split('?')[0];
  const file = path.join(uiDir, decodeURIComponent(url));
  if (!file.startsWith(uiDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(8932, '127.0.0.1', r));

// 视口档位：宽屏常用尺寸 + 设计最小尺寸（tauri.conf minWidth/minHeight = 940×620）
const VIEWPORTS = [
  { tag: 'w1280', width: 1280, height: 800 },
  { tag: 'w940', width: 940, height: 620 },
];
const SCREENS = ['live', 'history', 'settings'];
const SETTINGS_SECS = ['general', 'appearance', 'data', 'alerts', 'service', 'about'];

const browser = await chromium.launch({ executablePath: process.env.NP_CHROME || undefined });
const report = [];

// 导轨按钮点完会留下 hover，data-tip 气泡浮在卡片标题和「导出 CSV」上，
// 每张截图都糊一块。截图前把指针移到顶栏空白处，气泡自然消失。
async function shoot(page, file) {
  await page.mouse.move(640, 6);
  await page.waitForTimeout(180);
  await page.screenshot({ path: file });
}

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2400);

  const err = await page.evaluate(() => window.__PREVIEW_ERR);
  if (err) report.push(`[${vp.tag}] PAGE ERROR:${err.slice(0, 900)}`);

  // 交互段（悬浮 formatter 等）跑完后再收一次：window error / console.error
  // 都累积在同一个变量里，只在加载后读一次会漏掉交互期抛的错
  const lateErr = await page.evaluate(() => window.__PREVIEW_ERR);
  if (lateErr && lateErr !== err) report.push(`[${vp.tag}] LATE ERROR:${lateErr.slice(0, 900)}`);

  for (const screen of SCREENS) {
    await page.click(`.ri[data-screen="${screen}"]`);
    await page.waitForTimeout(900);
    if (screen === 'settings') {
      for (const sec of SETTINGS_SECS) {
        await page.click(`.snav button[data-sec="${sec}"]`);
        await page.waitForTimeout(500);
        await shoot(page, path.join(outDir, `${vp.tag}-settings-${sec}.png`));
      }
      await page.click('.snav button[data-sec="appearance"]');
      await page.click('.skin-card[data-skin="image"]');
      await page.waitForTimeout(600);
      await shoot(page, path.join(outDir, `${vp.tag}-settings-appearance-image.png`));
      await page.click('.skin-card[data-skin="plain"]');
      await page.waitForTimeout(400);
    } else {
      await shoot(page, path.join(outDir, `${vp.tag}-${screen}.png`));
    }
  }

  // 实时屏：选中一行看详情态
  await page.click('.ri[data-screen="live"]');
  await page.waitForTimeout(700);
  await page.click('#rows tr:nth-child(2)');
  await page.waitForTimeout(1400);
  await shoot(page, path.join(outDir, `${vp.tag}-live-selected.png`));

  // 选中态靠肉眼看截图容易误判（总览态和详情态的头部长得像），直接读 DOM 断言
  const selState = await page.evaluate(() => ({
    rowSelected: document.querySelectorAll('#rows tr.is-selected').length,
    inspName: (document.getElementById('inspName') || {}).textContent,
    liveSecShown: !(document.getElementById('inspLiveSec') || {}).hidden,
    fieldsShown: !(document.getElementById('inspFieldsSec') || {}).hidden,
  }));
  report.push(`[${vp.tag}] selection ${JSON.stringify(selState)}`);

  // 历史屏：自定义区间展开态
  await page.click('.ri[data-screen="history"]');
  await page.waitForTimeout(700);
  await page.click('#histCustomToggle');
  await page.waitForTimeout(500);
  await shoot(page, path.join(outDir, `${vp.tag}-history-custom.png`));

  // ---- 图表交互三态（ECharts 引擎验收）----
  // 悬浮读数：注意不能用 shoot()，它会先把指针挪走、气泡就没了，直接截。
  if (vp.tag === 'w1280') {
    await page.click('.ri[data-screen="history"]');
    await page.waitForTimeout(1200);
    const hist = await page.evaluate(() => {
      const r = document.getElementById('histChart').getBoundingClientRect();
      return { x: r.left + r.width * 0.45, y: r.top + r.height * 0.5 };
    });
    await page.mouse.move(hist.x, hist.y);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `${vp.tag}-chart-hover.png`) });
    // 点柱选中：侧栏应切到单日视角，柱组明暗对比
    await page.mouse.click(hist.x, hist.y);
    await page.waitForTimeout(600);
    await shoot(page, path.join(outDir, `${vp.tag}-chart-selected.png`));
    // 暂停态：带宽图曲线尾段转虚线
    await page.click('.ri[data-screen="live"]');
    await page.waitForTimeout(500);
    await page.evaluate(() => window.__setStatus('paused'));
    await page.waitForTimeout(1700);
    await shoot(page, path.join(outDir, `${vp.tag}-chart-paused.png`));
    await page.evaluate(() => window.__setStatus('ok'));

    // ---- 跟随系统深浅色 E2E ----
    // emulateMedia 直接驱动 matchMedia，等于真的换了系统深浅。断言读的是
    // 已落地的 CSS 变量（--bg），不是内部状态：中间任何一环（开关没接上、
    // resolveSkin 没映射、applyTokens 没跑）断了都会在这里现形。
    await page.click('.ri[data-screen="settings"]');
    await page.waitForTimeout(500);
    await page.click('.snav button[data-sec="appearance"]');
    await page.waitForTimeout(500);
    await page.click('#followSystem');
    await page.waitForTimeout(400);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(500);
    const bgLight = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(500);
    const bgDark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
    const followOk = bgLight !== bgDark && bgLight.toLowerCase() !== '#1b1d21' && bgDark.toLowerCase() === '#1b1d21';
    report.push(`[${vp.tag}] follow-system: light=${bgLight} dark=${bgDark} ${followOk ? 'OK' : 'FAIL'}`);
    await page.emulateMedia({ colorScheme: null }); // 恢复默认，别影响后面的探针
    await page.waitForTimeout(400);
    await page.click('#followSystem'); // 关掉开关，后续截图回到确定状态
    await page.waitForTimeout(300);

    // ---- 自定义下拉展开态（select-menu 验收）----
    await page.click('.snav button[data-sec="general"]');
    await page.waitForTimeout(400);
    await page.click('.sel .sel-btn');
    await page.waitForTimeout(300);
    const menuState = await page.evaluate(() => {
      const pop = document.querySelector('.sel-pop');
      return { open: !pop.hidden, btnExpanded: document.querySelector('.sel-btn').getAttribute('aria-expanded') };
    });
    report.push(`[${vp.tag}] menu: ${JSON.stringify(menuState)} ${menuState.open && menuState.btnExpanded === 'true' ? 'OK' : 'FAIL'}`);
    await shoot(page, path.join(outDir, `${vp.tag}-menu-open.png`));
    await page.waitForTimeout(200);

    // ---- 动效层验证（采样计算样式，确定性断言而非碰时序）----
    await page.click('.ri[data-screen="history"]');
    await page.waitForTimeout(80);
    const histAnim = await page.evaluate(() => getComputedStyle(document.querySelector('.screen[data-screen="history"]')).animationName);
    const rowAnim = await page.evaluate(() => {
      const tr = document.querySelector('#rows tr');
      return tr ? getComputedStyle(tr).animationName : '(no rows)';
    });
    report.push(`[${vp.tag}] motion: screen-in=${histAnim} row-in=${rowAnim} `
      + `${histAnim === 'screen-in' && rowAnim === 'row-in' ? 'OK' : 'FAIL'}`);

    await page.click('.ri[data-screen="live"]');
    await page.waitForTimeout(400);
    await page.click('#rows tr:nth-child(2)');
    await page.waitForTimeout(150);
    const detail = await page.evaluate(() => {
      const c = document.getElementById('detailCard');
      return { enter: c.classList.contains('is-enter'), anim: getComputedStyle(c).animationName };
    });
    report.push(`[${vp.tag}] detail-enter: ${JSON.stringify(detail)} `
      + `${detail.enter && detail.anim === 'card-in' ? 'OK' : 'FAIL'}`);

    await page.click('.ri[data-screen="settings"]');
    await page.waitForTimeout(400);
    await page.click('.snav button[data-sec="appearance"]');
    await page.waitForTimeout(300);
    await page.click('.skin-card[data-skin="amber"]');
    const winOn = await page.evaluate(() => document.documentElement.classList.contains('theme-anim'));
    await page.waitForTimeout(500);
    const winOff = await page.evaluate(() => !document.documentElement.classList.contains('theme-anim'));
    report.push(`[${vp.tag}] theme-anim: on=${winOn} off=${winOff} ${winOn && winOff ? 'OK' : 'FAIL'}`);
    await page.click('.skin-card[data-skin="plain"]'); // 恢复，探针回到确定状态
    // ---- 全局界面不透明度 E2E ----
    await page.evaluate(() => {
      const el = document.getElementById('uiOpacity');
      el.value = '0.7';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(450); // 广播节流 120ms + 落盘节流 300ms，都要等
    // 只淡漆不淡字：.frame 的 opacity 恒为 1，淡出体现在根变量与各表面漆层的
    // alpha 上（顶栏 panel-2 漆层 × 0.7）。断言旧实现（frame 整层 opacity）会误判。
    const probe = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement).getPropertyValue('--ui-opacity').trim();
      // Chromium 121+ 把 color-mix 的计算值序列化成 color(srgb r g b / a)，alpha=1
      // 时整段省略；旧 rgba() 形式也还在兜底。两种都按「数字个数 ≥4 → 末位是 alpha」解析。
      const bgc = getComputedStyle(document.querySelector('.topbar')).backgroundColor;
      const nums = bgc.match(/[\d.]+/g) || [];
      const alpha = nums.length >= 4 ? nums[nums.length - 1] : '1';
      return { root, alpha };
    });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('netpeek-theme') || '{}').uiOpacity);
    report.push(`[${vp.tag}] ui-opacity: var=${probe.root} topbarAlpha=${probe.alpha} stored=${stored} ${probe.root === '0.7' && probe.alpha === '0.7' ? 'OK' : 'FAIL'}`);
    await page.evaluate(() => {
      const el = document.getElementById('uiOpacity');
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    await page.waitForTimeout(400);
  }

  // ---- 量化探针：溢出 / 越界 / 挤压 ----
  // 每屏各跑一遍。探针只量得到当前屏（非当前屏的 .screen 整个 display:none，
  // getBoundingClientRect 全是 0），原来只在历史屏跑一次，live / settings 的
  // 尺寸一律读成 0 —— 那不是「没问题」，是没测。
  for (const screen of SCREENS) {
  await page.click(`.ri[data-screen="${screen}"]`);
  await page.waitForTimeout(700);
  const probe = await page.evaluate(() => {
    const out = { overflow: [], offscreen: [], tiny: [] };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // 两类「按设计溢出」的元素：导轨 data-tip 气泡故意画在 52px 轨道外，
    // .backdrop 故意 scale(1.04) 越出视口做出血。它们每轮都报，压过真问题。
    const byDesign = (el) =>
      el.classList.contains('backdrop') ||
      el.closest('nav.rail') !== null;
    for (const el of document.querySelectorAll('body *')) {
      if (el.hidden || !el.getClientRects().length || byDesign(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.overflow === 'visible' && (el.scrollWidth - el.clientWidth > 2 || el.scrollHeight - el.clientHeight > 2)) {
        // overflow:visible 的溢出会画到容器外
        const r = el.getBoundingClientRect();
        if (r.width > 30 && r.height > 10) {
          out.overflow.push({
            sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
            dx: el.scrollWidth - el.clientWidth, dy: el.scrollHeight - el.clientHeight,
          });
        }
      }
      const r = el.getBoundingClientRect();
      if (r.width > 8 && r.height > 8 && (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1)) {
        out.offscreen.push({
          sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''),
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        });
      }
    }
    // 卡片实际高度：低于阈值说明被挤瘪
    const measure = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    out.sizes = {
      chartPlot: measure('.chart-card .plot'),
      tableZone: measure('.table-zone'),
      sidebar: measure('.screen-live .sidebar'),
      detailCard: measure('#detailCard'),
      insp30: measure('#insp30Chart'),
      histPlot: measure('.hist-chart-card .plot'),
      sbody: measure('.sbody'),
    };
    const sb = document.querySelector('.screen-live .sidebar');
    out.sidebarScroll = sb ? sb.scrollHeight - sb.clientHeight : null;
    const body = document.querySelector('.sbody');
    out.sbodyScroll = body ? body.scrollHeight - body.clientHeight : null;
    return out;
  });
  report.push(`[${vp.tag}/${screen}] ${JSON.stringify(probe, null, 1)}`);
  }
  await page.close();
}

// ---- 底图分层回归（2026-09-13 真机 bug：.backdrop 压骨架）----
// 主流程点 image 皮肤时 backgroundImage 为空（没选图），has-bg=false，底图不渲染——
// 「底图压在 topbar/snav 上」这类 bug 在预览里永远不现形（真机有图才炸）。
// 这里播种一份带图配置直接开机进 image 皮肤，再读绘制顺序。
// 探针：临时打开 .backdrop 的 pointer-events，elementFromPoint 读表面中点的最上层元素；
// 命中 backdrop 即说明骨架被埋（真机验证过双向：z-shell 在 → topbar，撤掉 → backdrop）。
{
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript((cfg) => localStorage.setItem('netpeek-theme', cfg),
    '{"skin":"image","backgroundImage":"wallpapers/wall-3.jpg","panelOpacity":0.88,"bgBlur":18,"scrim":0.34,"imageDraft":null,"uiOpacity":1}');
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2400);

  const probeAt = (sel) => page.evaluate((s) => {
    const bd = document.querySelector('.backdrop');
    bd.style.pointerEvents = 'auto';
    const r = document.querySelector(s).getBoundingClientRect();
    const el = document.elementFromPoint(r.x + Math.min(r.width / 2, 300), r.y + Math.min(r.height / 2, 40));
    bd.style.pointerEvents = '';
    return el ? el.tagName + '.' + String(el.className).split(' ')[0] : 'null';
  }, sel);

  // 底图必须真的渲染出来，否则探针在测一个透明层（假绿）。
  // 底图已升级为三层材质：图片本体在 .backdrop::before（blur+saturate），
  // ::after 是 tint 纱 + 顶栏渐变 + 噪点 —— 所以这里要读伪元素的计算样式。
  const imgOk = await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('.backdrop'), '::before').backgroundImage;
    return new Promise((res) => {
      if (!bg || bg === 'none') { res(false); return; }
      const im = new Image();
      im.onload = () => res(true);
      im.onerror = () => res(false);
      im.src = bg.replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
    });
  });
  const hasBg = await page.evaluate(() => document.body.classList.contains('has-bg'));
  const topHit = await probeAt('.topbar');
  await page.click('.ri[data-screen="settings"]');
  await page.waitForTimeout(700);
  const navHit = await probeAt('.snav');
  const buried = (h) => /backdrop/.test(h);
  report.push(`[bgstack] imgLoaded=${imgOk} hasBg=${hasBg} topbar=${topHit} snav=${navHit} `
    + `${imgOk && hasBg && !buried(topHit) && !buried(navHit) ? 'OK' : 'FAIL'}`);
  await shoot(page, path.join(outDir, 'bgstack-settings.png'));
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, 'probe.txt'), report.join('\n\n'));
console.log(report.join('\n\n'));
console.log('\nshots:', outDir);
process.exit(0);
