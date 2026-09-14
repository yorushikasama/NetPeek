// NetPeek v2 UI 预览（开发期工具，不属于发布物）。
// 用法：NP_PW=<playwright 入口 file:// URL> NP_CHROME=<chrome.exe 路径> node scripts/preview-v2.mjs [outDir]
//   NP_PW 指向受管的 playwright-core（本机装在 node workspace 里，不是全局包）：
//     file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.mjs
//   必须给 NP_CHROME：那版 playwright 想要的 chromium_headless_shell-1243 本机没下，
//   不给就直接 `Executable doesn't exist`。指系统 Chrome 即可。
// 原理：ui/ 复制到临时目录，注入 window.__TAURI__ 假桥（快照 / 历史 / 设置命令全部伪造），
// 起本地 HTTP（file:// 会污染取色画布），Playwright 按多档视口截图。
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
        case 'history_process_totals': return JSON.stringify(day24Rows());
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
        // 托盘原生菜单的深浅上报（§37）：记下来给探针断言，真后端里它写的是 uxtheme。
        case 'set_tray_theme':
          window.__TRAY_THEME_CALLS = (window.__TRAY_THEME_CALLS || []).concat([args && args.dark]);
          return '';
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

// 近 24 小时列（history_process_totals）的假数据。
// 两条约束：① (pid, 启动秒) 必须与 frame() 里那对 Pid/StartTimeUnixMs 算出来的
// 完全一致 —— 对不上时真界面里这一整列会全是破折号，而这正是假桥该帮忙发现的事；
// ② 故意漏掉一个进程（Weixin）验破折号那一支，故意把未归因的 name 写成空串
// （库里就是这样）验空名归一那一支。
function day24Rows() {
  return PROCS.map(([name, pid], i) => ({ i, name, pid }))
    .filter((r) => r.i !== 3)
    .map(({ i, name, pid }) => ({
      name: name === '(系统/未归因)' ? '' : name,
      pid,
      startTs: Math.floor((BOOT - (3600 + i * 900) * 1000) / 1000),
      // 与瞬时速率不同的量级顺序：否则「按这列排序」和「按下载排序」看起来一模一样，
      // 排序探针就退化成永远通过。
      down: Math.round((5 + ((i * 7) % 11)) * 4.3e8),
      up: Math.round((5 + ((i * 5) % 9)) * 6.1e7),
    }));
}
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
// __PREVIEW_NO_SNAP：断连空态探针用的开关（见文件末尾的 offline 段）——
// 开了之后一帧快照都不发，只推一条 pipe-status，界面停在「采集服务未连接」。
if (!window.__PREVIEW_NO_SNAP) {
  setInterval(() => {
    (window.__TAURI__.event._h.snapshot || []).forEach((f) => f({ payload: frame() }));
  }, 1000);
  setTimeout(() => {
    (window.__TAURI__.event._h['pipe-status'] || []).forEach((f) => f({ payload: 'connected' }));
    (window.__TAURI__.event._h.snapshot || []).forEach((f) => f({ payload: frame() }));
  }, 60);
} else {
  // 反复推而不是推一次：main.js 的 listen 是在 boot() 里挂的，而 ui/ 下这一串
  // 脚本（含 1MB 的 echarts）解析完可能已经过了 100ms —— 一次性事件会静默丢掉，
  // 探针就退化成在测「首屏默认文案」。断连是幂等状态，重推无害。
  setInterval(() => {
    (window.__TAURI__.event._h['pipe-status'] || []).forEach((f) => f({ payload: 'disconnected' }));
  }, 400);
}
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

  // 托盘原生菜单的深浅上报（§37）：皮肤引擎上屏时把「有效深浅」告诉后端。
  // 默认皮肤是深底浅字，所以这里必须是 [true]；而且只允许一条 ——
  // applyTokens 每帧都会跑（拖不透明度滑杆），重复上报会白刷 IPC。
  const trayTheme = await page.evaluate(() => window.__TRAY_THEME_CALLS || []);
  report.push(`[${vp.tag}] tray-theme ${JSON.stringify(trayTheme)} `
    + `${trayTheme.length === 1 && trayTheme[0] === true ? 'OK' : 'FAIL'}`);

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

  // ---- 近 24 小时列（历史库聚合的第六列）----
  // 断言：列在、非空行都有数、假桥故意漏掉的那一个显示破折号、按它排序真按
  // 「下载 + 上传」降序。顺带把六列的实测宽度打出来 —— 这一列是硬塞进已有
  // 宽度预算里的，应用名列被挤掉多少得看得见。
  const day24 = await page.evaluate(() => {
    const th = document.querySelector('.proc-table th[data-sort="day24"]');
    const cells = [...document.querySelectorAll('#rows td.td-day')];
    const wrap = document.getElementById('tableWrap');
    const table = document.querySelector('.proc-table');
    return {
      header: th ? th.textContent.trim() : '',
      rows: cells.length,
      filled: cells.filter((c) => c.textContent.trim() !== '—').length,
      blanks: cells.filter((c) => c.classList.contains('is-blank')).length,
      sample: cells.slice(0, 3).map((c) => c.textContent.trim()),
      title: (cells[0] || {}).title || '',
      wrapW: wrap.clientWidth,
      tableW: Math.round(table.getBoundingClientRect().width),
      cols: [...document.querySelectorAll('.proc-table col')].map((c) => Math.round(c.getBoundingClientRect().width)),
    };
  });
  report.push(`[${vp.tag}] day24 ${JSON.stringify(day24)}`);
  const day24Ok = day24.header === '近 24 小时' && day24.rows > 0
    && day24.filled === day24.rows - 1 && day24.blanks === 1;
  report.push(`[${vp.tag}] day24-col ${day24Ok ? 'OK' : 'FAIL'}`);

  await page.click('.proc-table th[data-sort="day24"]');
  await page.waitForTimeout(600);
  const day24Sort = await page.evaluate(() => {
    // 单元格里是「数值 + 小一号单位」两个节点，textContent 拼起来没有空格
    const bytes = (s) => {
      const m = /^([\d.]+)\s*([KMGT]?B)$/.exec(s.trim());
      if (!m) return -1;
      return parseFloat(m[1]) * { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[m[2]];
    };
    const vals = [...document.querySelectorAll('#rows td.td-day')].map((c) => bytes(c.textContent));
    const th = document.querySelector('.proc-table th[data-sort="day24"]');
    return {
      aria: th.getAttribute('aria-sort'),
      vals,
      desc: vals.every((v, i) => i === 0 || vals[i - 1] >= v),
    };
  });
  report.push(`[${vp.tag}] day24-sort ${JSON.stringify(day24Sort)} `
    + `${day24Sort.aria === 'descending' && day24Sort.desc ? 'OK' : 'FAIL'}`);
  await shoot(page, path.join(outDir, `${vp.tag}-live-day24.png`));
  // 回到未排序态：后面的截图与断言都以默认呈现为基准。这里必须点「恢复默认排序」
  // 而不是再点一次「下载」列头 —— 点下载只会把状态变成「显式按下载降序」，行序虽然
  // 一样，但箭头和取消按钮都会留在截图上（§36 把排序列分成了三态）。
  await page.click('#sortReset');
  await page.waitForTimeout(400);
  const sortCleared = await page.evaluate(() => {
    const th = document.querySelector('.proc-table th.is-sorted');
    const btn = document.getElementById('sortReset');
    return { anySorted: !!th, btnHidden: !!btn && btn.hidden };
  });
  report.push(`[${vp.tag}] sort-cleared ${JSON.stringify(sortCleared)} `
    + `${!sortCleared.anySorted && sortCleared.btnHidden ? 'OK' : 'FAIL'}`);

  // ---- 排序三态循环与取消出口（§36）----
  // 用户报的漏洞：点完列头排序后没有任何地方能取消 —— 点过应用/上传就回不到
  // 「谁在占带宽」的默认呈现。三态循环必须每一下都有可见结果，第三下回到默认；
  // 另外必须有一个不用猜的出口（卡片头的「恢复默认排序」）。
  // 卡在「箭头在不在」「状态列是谁」「行序是否回到基准」三个可断言的点上。
  const sortState = () => page.evaluate(() => {
    const th = document.querySelector('.proc-table th.is-sorted');
    const btn = document.getElementById('sortReset');
    return {
      col: th ? th.dataset.sort : '',
      aria: th ? th.getAttribute('aria-sort') : '',
      // 箭头是 SVG，没有文本；只能数节点
      mark: th ? !!th.querySelector('.sort-mark svg') : false,
      btn: !!btn && !btn.hidden,
      order: [...document.querySelectorAll('#rows tr')].map((tr) => tr.dataset.key).join(','),
    };
  });
  const baseOrder = (await sortState()).order;

  // 上传列走完整一圈：降序 → 升序 → 取消
  await page.click('.proc-table th[data-sort="upload"]');
  await page.waitForTimeout(300);
  const upDesc = await sortState();
  await page.click('.proc-table th[data-sort="upload"]');
  await page.waitForTimeout(300);
  const upAsc = await sortState();
  await page.click('.proc-table th[data-sort="upload"]');
  await page.waitForTimeout(300);
  const upOff = await sortState();
  const cycleOk = upDesc.col === 'upload' && upDesc.aria === 'descending' && upDesc.mark && upDesc.btn
    && upAsc.aria === 'ascending'
    && upOff.col === '' && !upOff.mark && !upOff.btn && upOff.order === baseOrder;
  report.push(`[${vp.tag}] sort-cycle ${JSON.stringify({
    desc: [upDesc.aria, upDesc.mark, upDesc.btn], asc: upAsc.aria, off: [upOff.col, upOff.mark, upOff.btn, upOff.order === baseOrder],
  })} ${cycleOk ? 'OK' : 'FAIL'}`);

  // 表外出口：点「恢复默认排序」必须一步回到默认（行序 + 箭头 + 按钮三样一起复位）。
  // 顺带留一张「排序生效中」的截图 —— 箭头和那个按钮是不是真看得见，只有图能回答。
  await page.click('.proc-table th[data-sort="name"]');
  await page.waitForTimeout(300);
  const nameAsc = await sortState();
  await shoot(page, path.join(outDir, `${vp.tag}-sort-active.png`));
  await page.click('#sortReset');
  await page.waitForTimeout(300);
  const resetOff = await sortState();
  const resetOk = nameAsc.col === 'name' && nameAsc.aria === 'ascending' && nameAsc.btn
    && resetOff.col === '' && !resetOff.mark && !resetOff.btn && resetOff.order === baseOrder;
  report.push(`[${vp.tag}] sort-reset ${JSON.stringify({
    active: [nameAsc.col, nameAsc.aria, nameAsc.btn], off: [resetOff.col, resetOff.btn, resetOff.order === baseOrder],
  })} ${resetOk ? 'OK' : 'FAIL'}`);

  // ---- 右键菜单与可复制的值（§35）----
  // 原生菜单看不见也断言不了，但「有没有被拦」有确定性的观测口径：
  //   el.dispatchEvent(cancelableEvent) 的返回值就是 preventDefault 的回执 —— false 即被拦。
  // 输入框必须返回 true（豁免），否则搜索框与 API Key 里的粘贴会一起失效。
  const ctxProbe = await page.evaluate(() => {
    const fire = (el, x, y) => el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, buttons: 2,
    }));
    const open = () => {
      const m = document.querySelector('.ctx-menu');
      if (!m || m.hidden) return { items: [], inside: false };
      const b = m.getBoundingClientRect();
      return {
        items: [...m.querySelectorAll('.ctx-item')].map((x) => x.textContent.trim()),
        // 贴边右键时菜单必须被收回视口内，否则会有一半在屏幕外
        inside: b.left >= 0 && b.top >= 0 && b.right <= innerWidth && b.bottom <= innerHeight,
      };
    };
    // 挑一个真有对端的格（假桥里 svchost 没有对端，它那格是破折号）
    const peer = [...document.querySelectorAll('#rows td.td-peer')]
      .find((c) => c.textContent.trim() !== '—');
    const pb = peer.getBoundingClientRect();
    const preventedPeer = !fire(peer, Math.round(pb.right - 6), Math.round(pb.bottom - 6));
    const peerMenu = open();

    const pid = document.querySelector('#rows td.td-pid');
    const db = pid.getBoundingClientRect();
    const preventedPid = !fire(pid, Math.round(db.left + 6), Math.round(db.top + 4));
    const rowMenu = open();

    // 菜单的底漆必须是不透明的「抬一档面板」，不能透出底下的表格文字：
    // 无底图皮肤下 --paint-op = --ui-opacity = 1，color-mix 到 100% 即实色。
    // 这一条防的是「菜单看起来像浮着一层纱」——截图里最难判、最容易放过去的问题。
    const mm = document.querySelector('.ctx-menu');
    const menuOpen = !!mm && !mm.hidden;
    const bg = menuOpen ? getComputedStyle(mm).backgroundColor : '';
    const nums = bg.match(/[\d.]+/g) || [];
    const mb = menuOpen ? mm.getBoundingClientRect() : null;

    return {
      preventedPeer,
      preventedPid,
      peerItems: peerMenu.items,
      peerInside: peerMenu.inside,
      rowItems: rowMenu.items,
      rowInside: rowMenu.inside,
      menuAlpha: nums.length >= 4 ? nums[nums.length - 1] : (bg ? '1' : ''),
      menuBox: mb ? { x: Math.round(mb.x), y: Math.round(mb.y), w: Math.round(mb.width), h: Math.round(mb.height) } : null,
      copyValue: peer.getAttribute('data-copy'),
      gridCopyValue: document.querySelector('#rows td.td-pid').getAttribute('data-copy'),
      // 应用列的复制值必须**恰好是名字**：格子里还有首字母徽标（取不到图标时显示）
      // 与聚合计数，按 textContent 取会带上它们（"V verge-mihomo" / "msedge×3"）。
      rowName: document.querySelector('#rows td .row-name').textContent,
      userSelect: getComputedStyle(peer).userSelect,
      pidSelectable: getComputedStyle(pid).userSelect,
    };
  });
  const peerOk = ctxProbe.peerItems[0] && ctxProbe.peerItems[0].startsWith('复制对端地址')
    && ctxProbe.peerItems.some((t) => t.startsWith('复制整行'))
    && /^\d+\.\d+\.\d+\.\d+:\d+/.test(ctxProbe.copyValue || '');
  const rowOk = ctxProbe.rowItems[0] === `复制应用${ctxProbe.rowName}`
    && ctxProbe.rowItems.some((t) => t.startsWith('复制整行'));
  report.push(`[${vp.tag}] ctxmenu ${JSON.stringify(ctxProbe)} `
    + `${ctxProbe.preventedPeer && ctxProbe.preventedPid
      && ctxProbe.peerInside && ctxProbe.rowInside && peerOk && rowOk
      && ctxProbe.userSelect === 'text' && ctxProbe.pidSelectable === 'text'
      && ctxProbe.menuAlpha === '1' ? 'OK' : 'FAIL'}`);
  // 截图必须是**菜单开着**的这一刻：先截图再验输入框豁免。反过来的话，
  // 输入框那一支会先把菜单收掉（那是它该做的事），截出来的图里什么都没有。
  await page.screenshot({ path: path.join(outDir, `${vp.tag}-ctxmenu.png`) });
  // 菜单特写：整幅截图里菜单只有指甲盖大，底漆透不透、右列对不对齐都看不出来
  const clip = ctxProbe.menuBox ? {
    x: Math.max(0, ctxProbe.menuBox.x - 20),
    y: Math.max(0, ctxProbe.menuBox.y - 20),
    width: Math.min(vp.width, ctxProbe.menuBox.w + 40),
    height: Math.min(vp.height, ctxProbe.menuBox.h + 40),
  } : null;
  if (clip) {
    await page.screenshot({ path: path.join(outDir, `${vp.tag}-ctxmenu-zoom.png`), clip });
  }

  // 输入框豁免单独一段：返回 true 即「我们的处理器没拦它」，系统菜单照常出来，
  // 剪切 / 粘贴 / 全选才用得上。顺带断言「输入框右键会把我们自己的浮层收掉」。
  const ctxSearch = await page.evaluate(() => {
    const m0 = document.querySelector('.ctx-menu');
    const wasOpen = !!m0 && !m0.hidden;
    const search = document.getElementById('search');
    const exempt = search.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2,
    }));
    const m1 = document.querySelector('.ctx-menu');
    return { exempt, wasOpen, closedAfter: !m1 || m1.hidden };
  });
  report.push(`[${vp.tag}] ctxmenu-input ${JSON.stringify(ctxSearch)} `
    + `${ctxSearch.exempt && ctxSearch.wasOpen && ctxSearch.closedAfter ? 'OK' : 'FAIL'}`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const ctxClosed = await page.evaluate(() => {
    const m = document.querySelector('.ctx-menu');
    return !!m && m.hidden;
  });

  // 拖选文字后 mouseup 补的那一下 click 不该翻动行选中（main.js 的 hasTextSelection 守卫）。
  // 分两段：有选区时点行 → 选中行不变；选区清掉再点 → 才真的换行。
  const beforeKey = await page.evaluate(() => {
    const tr = document.querySelector('#rows tr.is-selected');
    return tr ? tr.dataset.key : '';
  });
  const guard = await page.evaluate(() => {
    const cell = document.querySelector('#rows td.td-peer');
    const r = document.createRange();
    r.selectNodeContents(cell);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.querySelector('#rows tr').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const key = document.querySelector('#rows tr.is-selected');
    return { withSel: key ? key.dataset.key : '', selLen: s.toString().length };
  });
  const guardAfter = await page.evaluate(() => {
    const s = getSelection();
    s.removeAllRanges();   // 清掉选区，再点一次就该真的换行了
    document.querySelector('#rows tr').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const key = document.querySelector('#rows tr.is-selected');
    return key ? key.dataset.key : '';
  });
  const guardOk = guard.withSel === beforeKey && guardAfter !== beforeKey;
  report.push(`[${vp.tag}] ctxmenu-guard ${JSON.stringify({ beforeKey, guard, guardAfter, ctxClosed })} `
    + `${guardOk && ctxClosed ? 'OK' : 'FAIL'}`);

  // 真实右键（不是合成事件）：走完整的 pointerdown → contextmenu 路径，顺带出一张
  // 「人眼看到的菜单」截图。合成事件那一段验的是逻辑，这一段验的是真链路。
  await page.click('#rows td.td-peer.has-peer', { button: 'right' });
  await page.waitForTimeout(350);
  const realOpen = await page.evaluate(() => {
    const m = document.querySelector('.ctx-menu');
    return !!m && !m.hidden;
  });
  if (realOpen) await page.screenshot({ path: path.join(outDir, `${vp.tag}-ctxmenu-real.png`) });
  report.push(`[${vp.tag}] ctxmenu-real open=${realOpen}`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

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

// ---- 断连空态（一帧快照都不推）----
// 这屏是产品可信度的大头（没数据时画面不能塌），但主流程永远有快照，
// 空态从来没进过截图 —— 坐标轴刻度叠字就是这么漏过去的。
// 顺带断言两件事：顶栏胶囊真的转成异常、表格换成带「重试连接」的空态。
{
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => { window.__PREVIEW_NO_SNAP = true; });
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  await shoot(page, path.join(outDir, 'offline-live.png'));
  const st = await page.evaluate(() => ({
    pill: (document.getElementById('statusText') || {}).textContent,
    pillCls: document.getElementById('statusPill').className,
    rateDown: document.getElementById('totalDownValue').textContent,
    tableHidden: document.getElementById('tableWrap').hidden,
    stateTitle: (document.getElementById('procStateTitle') || {}).textContent,
    retryShown: !document.getElementById('procStateActions').hidden,
  }));
  // 断线是「中性态」不是「异常态」（STATUS.offline 的 cls 为空，异常红留给
  // 「已连上但采集报错」）——所以这里不查 is-error，查的是另外三件事：
  // 表格换成带「重试连接」的说明态、速率是占位破折号而不是 0 B/s、
  // 胶囊文案切到未连接。
  const offlineOk = st.pill === '未连接采集服务'
    && !/is-(ok|warn|error)/.test(st.pillCls)
    && st.rateDown === '—'
    && st.tableHidden
    && st.retryShown;
  report.push(`[offline] ${JSON.stringify(st)} ${offlineOk ? 'OK' : 'FAIL'}`);
  await page.close();
}

await browser.close();
server.close();
fs.writeFileSync(path.join(outDir, 'probe.txt'), report.join('\n\n'));
console.log(report.join('\n\n'));
console.log('\nshots:', outDir);
process.exit(0);
