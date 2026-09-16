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
import zlib from 'node:zlib';
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
];const SCREENS = ['live', 'history', 'settings'];
const SETTINGS_SECS = ['general', 'appearance', 'background', 'data', 'alerts', 'service', 'about'];

// ---- 守卫契约的共享探针（背景图相关各块共用） ----
//
// 本轮把可读性判据换了两处（2026-09-15）：① 度量从 WCAG 2 的亮度比换成 APCA
// 的 Lc（面板被底图稀释成中调之后，WCAG 的比值会给出「正文 6.6 达标」这种
// 与人眼相反的结论）；② 新增「表面明度带」判据 —— 合成面必须仍是浅色表面或是
// 深色表面，不能滑进中调。于是「守卫输出的 (floor, autoDim) 是否守住契约」
// 成了各块共同要问的问题，放在这里统一定义，避免每块各写一遍判据。
// 契约 = 合成面落在明度带内 + 各字阶达到各自的 APCA 目标（含弱字阶）。
//
// 2026-09-15 二次返工（第三代口径）：带**只**承载两条与「表面本身」有关的判据 ——
// 正文契约（`glassContract().bodyLc`）与中调护栏（midMax / midMin）。其余字阶与
// 全部语义色改由 `glassHardenTokens` 对着「带的最不利端合成面」逐键加固，不花带宽。
//
// 为什么不再按「每个字阶都进带的反解」来判（第二代，已下线）：
//   · 浅色正文 75 要求合成面亮度 ≥0.63 ⟹ 带只剩 0.21 宽 ⟹ 底图的形全被压flat，
//     这正是用户连着两次抱怨的那块「粉白雾」（旧带 [0.85,1] 实测底图形只剩 6/255）；
//   · 深色次要字 45 超过那枚中灰的物理上限（实测 ≈43，纯黑也只给 43.3）⟹
//     契约恒假 ⟹ 带退化成一个点 ⟹ 透镜为 null ⟹ 地板把面板顶到 1（深色底图彻底消失）；
//   · 为绕开上一条加的自校准折扣（GLASS_TIER_REL = 0.75）实测是**无条件打折**、
//     且目标随皮肤自身对比一起塌陷、没有下限 —— 判据因此变成「永不失败」，
//     把 0.75 改成 0.3 全部断言照样过。所以它连带被删掉了。
// 于是这里的模型判据也跟着换：字阶不再拿「带端」去量，而是拿**加固后的令牌**去量，
// 门槛用实现导出的 GLASS_HARDEN_LC / GLASS_HARDEN_WEAK_LC。口径必须与渲染同源，
// 否则回归只会逼着实现把刚争来的带宽还回去。
// **独立的地面真值仍然是像素审计那一节**（`[bg-user-audit:*]` 直接量截图像素），
// 这一节的模型判据只是「不许在模型层面就说不通」。
const GUARD_PROBE = () => {
  window.__npGuard = (tokens, scrim, panelOp, Ls) => {
    const T = window.NetPeekTheme;
    // 上屏的字色 = 加固后的那份（theme-ui.applyCurrent 在置底 + 有底图时就是这么做的），
    // 所以判据也要拿加固后的表来量 —— 拿原始表量等于在量一份不会上屏的颜色。
    const hard = T.glassHardenTokens(tokens).tokens;
    const tiers = [
      ['text', T.LENS_BODY_LC],
      ['text2', T.GLASS_HARDEN_LC],
      ['text3', T.GLASS_HARDEN_WEAK_LC],
    ];
    return Ls.map((L) => {
      const g = T.backdropGuard(tokens, L, scrim, panelOp);
      const op = Math.max(panelOp, g.floor);
      const band = T.bandOf(tokens);
      // 两档面板底色都要过判据（实现同款）：panel 管卡片，panel-2 管顶栏 / rail /
      // 表头 / 输入框 —— 顶栏正是像素审计里最糊的那块。
      const surfaces = [tokens.panel, tokens.panel2]
        .filter((h) => /^#[0-9a-f]{6}$/i.test(h || ''));
      const rows = surfaces.map((surf) => {
        const eff = T.effectivePanel({ ...tokens, panel: surf }, L, Math.min(1, scrim + g.autoDim), op);
        const lum = T.luminance(T.hexToRgb(eff));
        const lcs = tiers.map(([k, min]) => [k, Math.abs(T.apcaLc(hard[k], eff)), min]);
        return {
          surf, eff, lum: Math.round(lum * 1000) / 1000, lcs,
          bandOk: lum >= band[0] - 1e-9 && lum <= band[1] + 1e-9,
          tiersOk: lcs.every(([, v, min]) => v >= min - 1e-9),
        };
      });
      return {
        L, floor: g.floor, autoDim: g.autoDim, op,
        eff: rows[0].eff, lum: rows[0].lum, lcs: rows[0].lcs,
        bandOk: rows.every((r) => r.bandOk),
        tiersOk: rows.every((r) => r.tiersOk),
        surfaces: rows.map((r) => [r.surf, r.eff, r.lum, r.bandOk, r.tiersOk]),
      };
    });
  };
};
const guardRowsOk = (rows) => rows.every((r) => r.bandOk && r.tiersOk);

// 像素级可读性审计（任一屏可复用）：先（字形还在时）把每个元素的颜色与框抓下来，
// 再抹掉字形取「背景板」，最后用元素自己的颜色去量它脚下那块背景板像素。
// 顺序不能反：隐藏字形的那条 CSS 会把 color 变成 transparent，之后读 computed style
// 拿到的全是 rgba(0,0,0,0) —— 第一次跑就是这么量出「全页 fg #000000」的假数据。
// 返回 { total, worst, below30, below45, minAbsLc }；plate 落盘成 bg-audit-plate-<tag>.png。
async function pixelAudit(page, outDir, tag) {
  const items = await page.evaluate(() => {
    const out = [];
    // 文字元素按「字形真正覆盖的矩形」取样（Range.getClientRects），而不是元素框：
    // 元素框里可能嵌着与文字无关的图形 —— 对端列的国旗是 flags.png 雪碧图
    // （.peer-flag 的 background-image，见 main.js 的 peerFlag），图表图例的小圆点
    // 是空的 <i> 配纯色底（.legend .is-down i）。按整框取「最坏像素」就会把旗帜的
    // 深蓝 #192f5d、中国红 #ee1c25、圆点的棕红当成文字底色，量出一堆并不存在的
    // Lc 1 / Lc 14 —— 2026-09-15 运行页审计的假阳性正是这么来的。
    const textRects = (node) => {
      const rg = document.createRange();
      rg.selectNodeContents(node);
      return Array.from(rg.getClientRects())
        .filter((b) => b.width > 0.5 && b.height > 0.5)
        .map((b) => [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]);
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || parseFloat(st.opacity) < 0.2) continue;
      const tag = el.tagName.toLowerCase();
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim()).join(' ').trim();
      // 只看「直接含文字的元素」与「最外层 svg 图标」：容器元素的颜色未必是它
      // 里面那行字用的颜色，混进来只会稀释结论。
      if (!own && tag !== 'svg') continue;
      let boxes = [];
      let pad = [0, 0, 0, 0];
      if (own) {
        for (const n of el.childNodes) {
          if (n.nodeType === 3 && n.textContent.trim()) boxes.push(...textRects(n));
        }
      }
      if (!boxes.length && tag === 'svg') {
        // 图标没有文字节点：退回元素框，但要扣掉内边距与边框。像壁纸缩略图的名字
        // （`padding: 10px 6px 4px`，上面 10px 是渐变还没压黑的过渡区）会被框里最亮
        // 的那个像素判成「亮字压亮底」——量出来的 Lc 29 是采样方式造出来的。
        boxes = [[Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]];
        pad = [
          parseFloat(st.paddingTop) + parseFloat(st.borderTopWidth),
          parseFloat(st.paddingRight) + parseFloat(st.borderRightWidth),
          parseFloat(st.paddingBottom) + parseFloat(st.borderBottomWidth),
          parseFloat(st.paddingLeft) + parseFloat(st.borderLeftWidth),
        ].map((v) => (Number.isFinite(v) ? v : 0));
      }
      if (!boxes.length) continue;
      out.push({
        sel: tag + (typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
        text: own.slice(0, 18),
        fg: st.color,
        pad,
        boxes,
      });
    }
    return out;
  });
  const hideHandle = await page.addStyleTag({
    content: 'body, body * { color: transparent !important; -webkit-text-fill-color: transparent !important;'
      + ' text-shadow: none !important; } svg, svg * { fill: transparent !important; stroke: transparent !important; }',
  });
  await page.waitForTimeout(120);
  const plate = (await page.screenshot({ type: 'png' })).toString('base64');
  fs.writeFileSync(path.join(outDir, `bg-audit-plate-${tag}.png`), Buffer.from(plate, 'base64'));
  const audit = await page.evaluate(async ({ b64, items }) => {
    const T = window.NetPeekTheme;
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = 'data:image/png;base64,' + b64;
    });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const W = cv.width; const H = cv.height;
    const px = ctx.getImageData(0, 0, W, H).data;
    const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    const lum = (i) => 0.2126 * lin(px[i]) + 0.7152 * lin(px[i + 1]) + 0.0722 * lin(px[i + 2]);
    const hex = (i) => '#' + [px[i], px[i + 1], px[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    const rgb2hex = (s) => {
      const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(s || '');
      return m ? '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('') : '';
    };
    const rows = [];
    for (const it of items) {
      const fg = rgb2hex(it.fg);
      if (!/^#[0-9a-f]{6}$/.test(fg)) continue;
      const pad = it.pad || [0, 0, 0, 0];
      const lums = [];
      const idxs = [];
      // 元素可能有多段文字（多行 / 多个文本节点）：逐段取样后合并，再统一取中位
      // 与最坏像素——与只量一个框时同口径。
      for (const [bx0, by0, bx1, by1] of it.boxes) {
        if (bx1 < 0 || by1 < 0 || bx0 > W || by0 > H) continue;
        // 采样「内容框」（扣掉内边距与边框）：文字矩形本身不需要再扣（pad 全 0），
        // svg 图标退回元素框时才用得上。
        const x0 = Math.max(0, bx0 + pad[3] + 1); const y0 = Math.max(0, by0 + pad[0] + 1);
        const x1 = Math.min(W, bx1 - pad[1] - 1); const y1 = Math.min(H, by1 - pad[2] - 1);
        if (x1 - x0 < 2 || y1 - y0 < 2) continue;
        const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 900)));
        for (let y = y0; y < y1; y += step) {
          for (let x = x0; x < x1; x += step) {
            const i = (y * W + x) * 4;
            lums.push(lum(i));
            idxs.push(i);
          }
        }
      }
      if (lums.length < 4) continue;
      const fgLum = T.luminance(T.hexToRgb(fg));
      // 中位像素：按亮度排序取正中那一个（既给「典型背景」也给下面的极性判断用）
      const order = lums.map((_, i) => i).sort((a, b) => lums[a] - lums[b]);
      const medIdx = order[Math.floor(order.length / 2)];
      const medLum = lums[medIdx];
      // 最坏像素：暗字踩到最暗的背景、亮字踩到最亮的背景
      let worst = 0;
      for (let i = 1; i < lums.length; i++) {
        const better = fgLum < medLum ? lums[i] < lums[worst] : lums[i] > lums[worst];
        if (better) worst = i;
      }
      rows.push({
        sel: it.sel, text: it.text, fg,
        bgWorst: hex(idxs[worst]),
        lcWorst: T.apcaLc(fg, hex(idxs[worst])),
        lcMed: T.apcaLc(fg, hex(idxs[medIdx])),
        wcagWorst: Math.round(T.contrast(fg, hex(idxs[worst])) * 100) / 100,
        medLum: Math.round(medLum * 1000) / 1000,
      });
    }
    rows.sort((a, b) => Math.abs(a.lcWorst) - Math.abs(b.lcWorst));
    return {
      total: rows.length,
      worst: rows.slice(0, 12),
      below30: rows.filter((i) => Math.abs(i.lcWorst) < 30).length,
      below45: rows.filter((i) => Math.abs(i.lcWorst) < 45).length,
      minAbsLc: rows.length ? Math.abs(rows[0].lcWorst) : null,
    };
  }, { b64: plate, items });
  await hideHandle.evaluate((el) => el.remove());
  await page.waitForTimeout(120);
  return audit;
}

// 逐框平均像素（透出率用）：截图喂回页面里解码，再按框取均值。截图 → base64 →
// 页面内 <img> + canvas → getImageData，这条链路和 pixelAudit 同款。
async function shotBoxMeans(page, b64, boxes) {
  return page.evaluate(async ({ b64s, boxes }) => {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = 'data:image/png;base64,' + b64s;
    });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const W = cv.width; const H = cv.height;
    return boxes.map(([x0, y0, x1, y1]) => {
      const X0 = Math.max(0, x0); const Y0 = Math.max(0, y0);
      const X1 = Math.min(W, x1); const Y1 = Math.min(H, y1);
      let r = 0; let g = 0; let b = 0; let n = 0;
      const lums = [];
      for (let y = Y0; y < Y1; y += 2) {
        for (let x = X0; x < X1; x += 2) {
          const i = (y * W + x) * 4;
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
          lums.push(px[i] + px[i + 1] + px[i + 2]);
        }
      }
      if (!n) return [0, 0, 0, 0];
      const m = lums.reduce((a, v) => a + v, 0) / n;
      const sd = Math.sqrt(lums.reduce((a, v) => a + (v - m) * (v - m), 0) / n);
      return [r / n, g / n, b / n, sd];
    });
  }, { b64s: b64, boxes });
}

// 逐框「低频差分」标准差：同一批格子里，两张截图（有图 / 无图）的格均值逐格相减，
// 再算这组差值的标准差。这是「底图的形有没有透出来」的干净判据 —— 面板自己的内容
// 在两张图里逐像素相同，相减即抵消；留下的就是底图贡献的那层低频场。若面板把底图
// 盖死，差值只剩一个常数（整体亮度平移），标准差 ≈ 0。
// （不要用「单张图的格均值标准差」当判据：摘掉底图会让面板整体更亮，面板自己那点
//  半透明内容线的对比跟着变，噪声比信号还大 —— 实测那样量出来的是负增益。）
async function shotBoxCoarseDiff(page, b64a, b64b, boxes, cells = 6) {
  return page.evaluate(async ({ a, b, boxes, cells }) => {
    const load = (s) => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = 'data:image/png;base64,' + s;
    });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const grab = (img) => {
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { px: ctx.getImageData(0, 0, cv.width, cv.height).data, W: cv.width, H: cv.height };
    };
    const A = grab(ia);
    const B = grab(ib);
    return boxes.map(([x0, y0, x1, y1]) => {
      const X0 = Math.max(0, x0); const Y0 = Math.max(0, y0);
      const X1 = Math.min(A.W, B.W, x1); const Y1 = Math.min(A.H, B.H, y1);
      const cw = (X1 - X0) / cells; const chh = (Y1 - Y0) / cells;
      if (cw < 2 || chh < 2) return 0;
      const diffs = [];
      for (let cy = 0; cy < cells; cy++) {
        for (let cx = 0; cx < cells; cx++) {
          const ay = Math.round(Y0 + cy * chh); const by = Math.round(Y0 + (cy + 1) * chh);
          const ax = Math.round(X0 + cx * cw); const bx = Math.round(X0 + (cx + 1) * cw);
          let s = 0; let n = 0;
          for (let y = ay; y < by; y++) {
            for (let x = ax; x < bx; x++) {
              const i = (y * A.W + x) * 4;
              s += (A.px[i] + A.px[i + 1] + A.px[i + 2])
                - (B.px[i] + B.px[i + 1] + B.px[i + 2]);
              n++;
            }
          }
          if (n) diffs.push(s / n / 3);
        }
      }
      if (!diffs.length) return 0;
      const m = diffs.reduce((p, v) => p + v, 0) / diffs.length;
      return Math.sqrt(diffs.reduce((p, v) => p + (v - m) * (v - m), 0) / diffs.length);
    });
  }, { a: b64a, b: b64b, boxes, cells });
}

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
      // 皮肤卡在「皮肤」分区，而它专属的那一大块（壁纸 / 显示方式 / 四根滑杆 /
      // 取色）拆到了「背景」分区 —— 选中皮肤之后要换一屏才拍得到那块。
      await page.click('.snav button[data-sec="appearance"]');
      await page.click('.skin-card[data-skin="image"]');
      await page.waitForTimeout(600);
      await shoot(page, path.join(outDir, `${vp.tag}-settings-appearance-image.png`));
      await page.click('.snav button[data-sec="background"]');
      await page.waitForTimeout(500);
      await shoot(page, path.join(outDir, `${vp.tag}-settings-background-image.png`));
      await page.click('.snav button[data-sec="appearance"]');
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
    // alpha 上（顶栏 panel-2 漆层 × --paint-op）。
    // 地板（--ui-paint-floor）是透明窗的读性守卫：无底图时 --paint-op =
    // max(--ui-opacity, --ui-paint-floor)，地板按皮肤令牌算（theme.uiPaintFloor）、
    // 不随滑杆动 —— plain 的令牌算出 0.78，所以顶栏 alpha 不会是滑杆值的 0.7，
    // 而是被地板抬到 0.78。探针断言的口径：根变量与落盘值 = 滑杆值，顶栏漆层
    // alpha = 当期的 --paint-op（= max(滑杆, 地板)，从这里读回而不是心算地板，
    // 与渲染同源）。
    const probe = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement).getPropertyValue('--ui-opacity').trim();
      // Chromium 121+ 把 color-mix 的计算值序列化成 color(srgb r g b / a)，alpha=1
      // 时整段省略；旧 rgba() 形式也还在兜底。两种都按「数字个数 ≥4 → 末位是 alpha」解析。
      const bgc = getComputedStyle(document.querySelector('.topbar')).backgroundColor;
      const nums = bgc.match(/[\d.]+/g) || [];
      const alpha = nums.length >= 4 ? nums[nums.length - 1] : '1';
      const cs = getComputedStyle(document.documentElement);
      const paintOp = cs.getPropertyValue('--paint-op').trim();
      const match = paintOp.match(/max\(\s*([\d.]+),\s*([\d.]+)\s*\)/);
      const expected = match ? String(Math.max(parseFloat(match[1]), parseFloat(match[2]))) : '1';
      return {
        root, alpha, expected,
        paintOp,
        uiFloor: cs.getPropertyValue('--ui-paint-floor').trim(),
        hasBg: document.body.classList.contains('has-bg'),
        anim: document.documentElement.classList.contains('theme-anim'),
        skin: (document.querySelector('.skin-card.is-on') || {}).dataset ? document.querySelector('.skin-card.is-on').dataset.skin : '(none)',
      };
    });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('netpeek-theme') || '{}').uiOpacity);
    const ok = probe.root === '0.7' && stored === 0.7 && probe.alpha === probe.expected && !probe.hasBg && probe.skin === 'plain';
    report.push(`[${vp.tag}] ui-opacity: var=${probe.root} topbarAlpha=${probe.alpha} paintOp=${probe.paintOp} expected=${probe.expected} stored=${stored} hasBg=${probe.hasBg} skin=${probe.skin} ${ok ? 'OK' : 'FAIL'}`);
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

// ---- 浅色背景图可见性回归（2026-09-15 用户报告：浅色皮肤下背景图几乎看不见）----
// 根因：浅色皮肤（暗字压亮底）在守卫里没有补偿路径，backdropFloor 按 text2@4.5
// 管「被底图稀释过的面板」，而白面板的亮度本就贴着暗字 4.5 所需的背景亮度上限
// —— 地板恒顶到 1，面板永远不透明，图只在缝隙里露一点，还要挨强制 ≥0.2 的黑纱。
// 第二轮（同日，用户反馈「整体可视性还是很差、有些图标和字看不清」）换了两处
// 判据：APCA 取代 WCAG 比值（比值在中调上会骗人）、新增表面明度带（合成面不许
// 滑进中调），弱字阶（单位字、说明字、图标）第一次进守卫。
// 断言全部读 CSS 变量与计算样式（守卫管线的最终落点），不碰内部状态。
{
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript(GUARD_PROBE);
  await page.addInitScript((cfg) => localStorage.setItem('netpeek-theme', cfg),
    '{"skin":"image","backgroundImage":"wallpapers/wall-3.jpg","panelOpacity":0.88,"bgBlur":8,"scrim":0.30,"imageMode":"light","imageDraft":null,"uiOpacity":1}');
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  const probe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const hex = (name) => cs.getPropertyValue(name).trim();
    const lumOf = (h) => window.chroma(h).luminance();
    const topbar = getComputedStyle(document.querySelector('.topbar')).backgroundColor;
    const nums = topbar.match(/[\d.]+/g) || [];
    // 守卫契约矩阵：全亮度带上的可读性 —— 在用户选的不透明度（必要时被 floor
    // 抬升）与守卫补偿下，合成面必须落在明度带内，正文 / 次要 / 弱字阶三档
    // 都必须达到各自的 APCA 目标（弱字阶 40 是这一轮补上的）。
    const tokens = {
      bg: hex('--bg'), panel: hex('--panel'), text: hex('--text'),
      text2: hex('--text-2'), text3: hex('--text-3'),
    };
    return {
      hasBg: document.body.classList.contains('has-bg'),
      lightSkin: window.NetPeekTheme.isLightSkin(tokens),
      text2Lum: lumOf(hex('--text-2')), panelLum: lumOf(hex('--panel')),
      floorVar: cs.getPropertyValue('--panel-op-floor').trim(),
      autoVar: cs.getPropertyValue('--backdrop-auto').trim(),
      tintLum: lumOf(hex('--backdrop-tint')),
      veil: cs.getPropertyValue('--backdrop-veil').trim(),
      topbarAlpha: nums.length >= 4 ? nums[nums.length - 1] : '1',
      scrimLabel: (document.querySelector('#scrimLabel b') || {}).textContent || '',
      lens: cs.getPropertyValue('--lens-filter').trim(),
      lowOp: window.__npGuard(tokens, 0.30, 0.40, [0.02, 0.35, 0.6, 0.95]),
      sweep: window.__npGuard(tokens, 0.30, 0.45, [0.02, 0.1, 0.25, 0.45, 0.65, 0.85, 0.99]),
    };
  });
  const sweepOk = guardRowsOk(probe.sweep);
  const lightOk = probe.hasBg && probe.lightSkin
    && probe.text2Lum < probe.panelLum          // 浅色皮肤真的派生出来了
    && parseFloat(probe.floorVar) === 0         // 地板不钳滑杆（透镜接手后亮图同样自由）
    && probe.autoVar === '0'                    // 浅色侧不再铺自动亮纱（会连缝隙一起洗）
    && probe.veil === '255 255 255'             // 纱方向切到亮
    && probe.tintLum > 0.8                      // tint 是亮纱
    && parseFloat(probe.topbarAlpha) < 0.6      // 亮底图上漆层真的透出底图（0.45）
    && /contrast\(/.test(probe.lens)            // 透镜写进 CSS
    && guardRowsOk(probe.lowOp)                 // 0.40 的薄面板在亮图上同样达标
    && probe.scrimLabel === '背景亮纱'
    && sweepOk;
  report.push(`[bg-light] ${JSON.stringify({
    ...probe,
    lowOp: probe.lowOp.map((r) => [r.L, r.op, r.lum, r.bandOk, r.tiersOk]),
    sweep: probe.sweep.map((r) => [r.L, r.autoDim, r.floor, r.lum, r.bandOk, r.tiersOk]),
  })} ` + `${lightOk ? 'OK' : `FAIL(sweepOk=${sweepOk})`}`);
  await page.click('.ri[data-screen="live"]');
  await page.waitForTimeout(800);
  await shoot(page, path.join(outDir, 'bg-light-live.png'));
  await page.click('.ri[data-screen="settings"]');
  await page.waitForTimeout(500);
  await page.click('.snav button[data-sec="background"]');
  await page.waitForTimeout(500);
  await shoot(page, path.join(outDir, 'bg-light-settings.png'));
  await page.close();
}

// 中调图（暮山）+ 浅色：可见性最典型的用例 —— 山体要在半透面板下透出来，
// 同时暗字仍可读。断言同款（地板不钳 + 漆层半透 + 亮纱方向），截图给人眼。
{
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript(GUARD_PROBE);
  await page.addInitScript((cfg) => localStorage.setItem('netpeek-theme', cfg),
    '{"skin":"image","backgroundImage":"wallpapers/wall-2.jpg","panelOpacity":0.88,"bgBlur":6,"scrim":0.30,"imageMode":"light","imageDraft":null,"uiOpacity":1}');
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  const probe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const hex = (name) => cs.getPropertyValue(name).trim();
    const card = getComputedStyle(document.querySelector('.card')).backgroundColor;
    const nums = card.match(/[\d.]+/g) || [];
    const tokens = {
      bg: hex('--bg'), panel: hex('--panel'), text: hex('--text'),
      text2: hex('--text-2'), text3: hex('--text-3'),
    };
    return {
      hasBg: document.body.classList.contains('has-bg'),
      lightSkin: window.NetPeekTheme.isLightSkin(tokens),
      floorVar: cs.getPropertyValue('--panel-op-floor').trim(),
      veil: cs.getPropertyValue('--backdrop-veil').trim(),
      cardAlpha: nums.length >= 4 ? nums[nums.length - 1] : '1',
      scrimLabel: (document.querySelector('#scrimLabel b') || {}).textContent || '',
      lens: cs.getPropertyValue('--lens-filter').trim(),
      lowOp: window.__npGuard(tokens, 0.30, 0.40, [0.02, 0.35, 0.6, 0.95]),
      sweep: window.__npGuard(tokens, 0.30, 0.45, [0.02, 0.1, 0.25, 0.45, 0.65, 0.85, 0.99]),
    };
  });
  const midOk = probe.hasBg && probe.lightSkin
    && parseFloat(probe.floorVar) === 0         // 中调图：地板完全不介入，图按滑杆透
    && probe.veil === '255 255 255'
    && parseFloat(probe.cardAlpha) < 0.6        // 漆层 0.45：山体在半透面板下透出来
    && /contrast\(/.test(probe.lens)
    && guardRowsOk(probe.lowOp)                 // 0.40 的薄面板在山体上同样达标
    && probe.scrimLabel === '背景亮纱'
    && guardRowsOk(probe.sweep);
  report.push(`[bg-light-mid] ${JSON.stringify({
    ...probe,
    lowOp: probe.lowOp.map((r) => [r.L, r.op, r.lum, r.bandOk, r.tiersOk]),
    sweep: probe.sweep.map((r) => [r.L, r.floor, r.lum, r.bandOk, r.tiersOk]),
  })} ` + `${midOk ? 'OK' : 'FAIL'}`);
  await page.click('.ri[data-screen="live"]');
  await page.waitForTimeout(800);
  await shoot(page, path.join(outDir, 'bg-light-mid-live.png'));
  await page.close();
}

// ---- 合成「暗红戏剧性壁纸」：用户实测场景（暗黑系游戏壁纸）的代餐 ----
// 主色近黑暖调（对应实测 palette 里占 52% 的 #140906）、左下一簇高饱和火焰亮区。
// 用来复现「暗图钉浅色 → 整窗发白发粉」的原始问题，并守护新渲染（轻纱 + 磨砂
// + 方向阴影）不再退化。PNG 用 node zlib 手写编码（IHDR/IDAT/IEND + CRC32）。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  let c = 0xffffffff;
  for (const b of body) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
const CUSTOM_RED_PNG = (() => {
  const W = 720;
  const H = 450;
  const px = Buffer.alloc(W * H * 4);
  const gx = W * 0.3;
  const gy = H * 0.78;
  const gr = W * 0.62;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - gx, y - gy) / gr;
      const glow = Math.max(0, 1 - d);
      const g2 = glow * glow;
      const n = ((x * 73856093) ^ (y * 19349663)) % 9; // 伪随机轻噪点，给 ColorThief 桶多样性
      const vy = y / H;
      const i = (y * W + x) * 4;
      px[i] = Math.min(255, 24 + vy * 14 + 214 * g2 + 40 * glow + n);
      px[i + 1] = Math.min(255, 6 + vy * 4 + 84 * g2 + 16 * glow + (n >> 1));
      px[i + 2] = Math.min(255, 4 + 26 * g2);
      px[i + 3] = 255;
    }
  }
  return 'data:image/png;base64,' + encodePNG(W, H, px).toString('base64');
})();

// 用户实测场景（2026-09-15）：暗红戏剧性壁纸 + 深浅偏好钉「浅色」+ 面板 0.70 +
// 无全局模糊。第一轮修复解决的是「整窗发白发粉」（亮纱浓度收敛 + 纱色中性 +
// 磨砂 + 方向阴影）；第二轮（同日用户回访「整体可视性还是很差」）补的是
// 「近黑壁纸 + 浅色面板 = 合成面滑进中调」——守卫现在按表面明度带把面板
// 不透明度抬到「合成面仍是一块浅色表面」的高度，字阶（含弱字阶）按 APCA 守。
// 断言：浅色派生保留、纱轻且中性、真磨砂、方向阴影、地板被抬进 0.8+（明度带
// 判据生效）、全亮度带上明度带与三档字阶都成立。
{
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript(GUARD_PROBE);
  const customCfg = JSON.stringify({
    skin: 'image', backgroundImage: CUSTOM_RED_PNG, panelOpacity: 0.7, bgBlur: 0,
    scrim: 0.2, imageMode: 'light', imageDraft: null, uiOpacity: 1,
    bgBrightness: 1, backdropStyle: 'underlay',
  });
  await page.addInitScript((cfg) => localStorage.setItem('netpeek-theme', cfg), customCfg);
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  const probe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const hex = (name) => cs.getPropertyValue(name).trim();
    const card = getComputedStyle(document.querySelector('.card'));
    const nums = card.backgroundColor.match(/[\d.]+/g) || [];
    const T = window.NetPeekTheme;
    const tokens = {
      bg: hex('--bg'), panel: hex('--panel'), text: hex('--text'),
      text2: hex('--text-2'), text3: hex('--text-3'),
    };
    const tintRgb = T.hexToRgb(hex('--backdrop-tint'));
    const effScrim = T.effectiveScrim(0.2, true);
    return {
      hasBg: document.body.classList.contains('has-bg'),
      lightClass: document.body.classList.contains('light-skin'),
      lightSkin: T.isLightSkin(tokens),
      panelLum: T.luminance(T.hexToRgb(tokens.panel)),
      dim: parseFloat(cs.getPropertyValue('--backdrop-dim').trim()),
      auto: parseFloat(cs.getPropertyValue('--backdrop-auto').trim()),
      floorVar: parseFloat(cs.getPropertyValue('--panel-op-floor').trim()) || 0,
      tintSpread: Math.max(tintRgb.r, tintRgb.g, tintRgb.b) - Math.min(tintRgb.r, tintRgb.g, tintRgb.b),
      tintLum: T.luminance(tintRgb),
      veil: cs.getPropertyValue('--backdrop-veil').trim(),
      frost: /blur/.test(card.backdropFilter || ''),
      cardAlpha: nums.length >= 4 ? nums[nums.length - 1] : '1',
      // 浅色亮玻璃的边与影：顶棱 72% 白 + 34px 环境影（2026-09-15 的那套「高级感」）
      glassEdge: /0\.72/.test(card.boxShadow || '') && /34px/.test(card.boxShadow || ''),
      lens: cs.getPropertyValue('--lens-filter').trim(),
      scrimLabel: (document.querySelector('#scrimLabel b') || {}).textContent || '',
      // 0.40 的「薄面板」必须原地达标 —— 用户这次的核心诉求就是「滑杆拉到底也能读」
      lowOp: window.__npGuard(tokens, effScrim, 0.40, [0.02, 0.25, 0.85]),
      // 迁移后用户的 0.45 一档，在全亮度带上都要达标
      sweep: window.__npGuard(tokens, effScrim, 0.45, [0.02, 0.1, 0.25, 0.45, 0.65, 0.85, 0.99]),
    };
  });
  const sweepOk = guardRowsOk(probe.sweep);
  const customOk = probe.hasBg && probe.lightClass && probe.lightSkin
    && probe.panelLum > 0.6
    && probe.dim <= 0.15
    && probe.tintSpread <= 24
    && probe.tintLum > 0.8
    && probe.veil === '255 255 255'
    && probe.frost
    && probe.glassEdge
    && /contrast\(/.test(probe.lens)        // 面板级透镜真的写进 CSS 了
    && parseFloat(probe.floorVar) === 0     // 地板不再钳滑杆（旧版这里被抬到 0.93）
    && parseFloat(probe.cardAlpha) < 0.6    // 漆层真的薄了：近黑壁纸下也只有 0.45
    && probe.scrimLabel === '背景亮纱'
    && guardRowsOk(probe.lowOp)             // 0.40 的薄面板原地达标
    && sweepOk;
  report.push(`[bg-custom-light] ${JSON.stringify({
    ...probe,
    lowOp: probe.lowOp.map((r) => [r.L, r.op, r.lum, r.bandOk, r.tiersOk]),
    sweep: probe.sweep.map((r) => [r.L, r.floor, r.lum, r.bandOk, r.tiersOk, r.lcs.map((x) => x[1])]),
  })} ` + `${customOk ? 'OK' : `FAIL(sweepOk=${sweepOk})`}`);
  await page.click('.ri[data-screen="live"]');
  await page.waitForTimeout(800);
  await shoot(page, path.join(outDir, 'bg-custom-light-live.png'));
  await page.click('.ri[data-screen="settings"]');
  await page.waitForTimeout(500);
  await page.click('.snav button[data-sec="background"]');
  await page.waitForTimeout(500);
  await shoot(page, path.join(outDir, 'bg-custom-light-settings.png'));
  await page.close();
}

// ---- 用户实测场景的像素级可读性审计（2026-09-15） ----
//
// 前面那些块验的是「模型自己算出来的数」：模型只检查它列出来的那几档，档位之外的
// 元素（单位字、说明字、导轨图标、徽标）它根本不看 —— 而用户报的恰恰是「有些图标
// 和字体看不清」。这一块换成像素级的口径：把字形全部抹成透明截一张「背景板」，
// 再把页面上每一个带文字或图标的元素抓出来，用它自己的颜色与它脚下那块背景板
// 像素逐个算 APCA Lc（取最坏像素），谁不达标一眼可见，且与模型无关。
//
// 种子用用户真实的 theme-config.json（含那份旧版粉米色草稿），壁纸用真实文件
// ——顺带验证「派生规则版本迁移」把老草稿按当前规则重算了一遍。
// 壁纸走 data URL 而不是相对路径：预览假桥的 read_background_image 返回空串
// （它没有真实后端），非内置壁纸的绝对路径会被解析成「没有背景图」，整块审计
// 就退化成在量一块没有底图的界面（第一次跑就是这么假绿的）。
const userStore = path.join(os.homedir(), 'AppData', 'Roaming', 'com.netpeek.app');
const userWall = path.join(userStore, 'backgrounds', '0dd6251aab60ce90.jpg');
if (fs.existsSync(userWall)) {
  const userWallData = 'data:image/jpeg;base64,' + fs.readFileSync(userWall).toString('base64');
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  const userCfg = JSON.stringify({
    skin: 'image',
    backgroundImage: userWallData,
    panelOpacity: 0.7, bgBlur: 0, scrim: 0.2,
    imageMode: 'light', followSystem: false, uiOpacity: 1,
    bgBrightness: 1, backdropStyle: 'underlay', wrapOpacity: 0.4,
    // 旧草稿：旧明度带 + 旧字阶混比 + 没有 rev 标记 → 启动迁移必须重算
    imageDraft: {
      tokens: {
        bg: '#e4d3ce', panel: '#e7ddda', panelHi: '#c9c0bd', panel2: '#d5c5c0',
        line: '#c1b8b5', lineSoft: '#d3c9c6', text: '#201917', text2: '#5d5250',
        text3: '#8b7f7b', down: '#8d5621', up: '#39668f', ok: '#286f4d',
        warn: '#795f33', error: '#9a4b4b', accent: '#38160e', accentInk: '#f2f3f5',
        selBar: '#48271e',
      },
      source: 'standard',
    },
  });
  await page.addInitScript((cfg) => localStorage.setItem('netpeek-theme', cfg), userCfg);
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  await page.click('.ri[data-screen="settings"]');
  await page.waitForTimeout(500);
  // 像素審計选「背景」分区：图相关的控件（壁纸网格、四根滑杆、色板、AI 字段）全在这一屏，
  // 而用户报的“有些图标和字体看不清”正是这类小件——拉拉杆那一屏才是最密的样本。
  await page.click('.snav button[data-sec="background"]');
  await page.waitForTimeout(600);

  // ① 模型侧：迁移后的令牌、守卫给出的地板、合成面落在哪
  const model = await page.evaluate(() => {
    const T = window.NetPeekTheme;
    const cs = getComputedStyle(document.documentElement);
    const hex = (n) => cs.getPropertyValue(n).trim();
    const tokens = {
      bg: hex('--bg'), panel: hex('--panel'), panel2: hex('--panel-2'),
      text: hex('--text'), text2: hex('--text-2'), text3: hex('--text-3'),
    };
    // 种子里写的是 0.7（旧版「地板」逼出来的档），启动迁移（opRev 一次性归位）
    // 会把它落到 0.45 —— 这里读 CSS 上的真实值，不写死，否则模型和渲染会漂。
    const panelOp = parseFloat(hex('--panel-op')) || 0;
    const floorV = parseFloat(hex('--panel-op-floor')) || 0;
    const effOp = Math.max(panelOp, floorV);
    const dim = parseFloat(hex('--backdrop-dim')) || 0;
    const auto = parseFloat(hex('--backdrop-auto')) || 0;
    const band = T.bandOf(tokens);
    // 两档面板底色各自的合成面：用守卫同款模型，底图亮度取用户那张图实测的
    // 最坏成片暗区（p10 = 0.0014，浅色侧口径）。panel-2 是顶栏 / rail 那档。
    const L = 0.0014;
    const of = (surf) => {
      const eff = T.effectivePanel({ ...tokens, panel: surf },
        L, Math.min(1, dim + auto), effOp);
      const lum = T.luminance(T.hexToRgb(eff));
      return {
        surf, eff, lum: Math.round(lum * 1000) / 1000,
        bandOk: lum >= band[0] - 1e-9 && lum <= band[1] + 1e-9,
        lc: [tokens.text, tokens.text2, tokens.text3].map((f) => T.apcaLc(f, eff)),
      };
    };
    const p1 = of(tokens.panel);
    const p2 = of(tokens.panel2);
    // 0.40 的「薄面板」：透镜上线后这一档也必须原地达标，否则「滑杆拉到底还能读」
    // 就只是一句话（用户这次的核心诉求）。
    const ofOp = (surf, op) => {
      const eff = T.effectivePanel({ ...tokens, panel: surf }, L, Math.min(1, dim + auto), op);
      const lum = T.luminance(T.hexToRgb(eff));
      return {
        surf, eff, lum: Math.round(lum * 1000) / 1000,
        bandOk: lum >= band[0] - 1e-9 && lum <= band[1] + 1e-9,
        lcs: [tokens.text, tokens.text2, tokens.text3].map((f) => Math.abs(T.apcaLc(f, eff))),
      };
    };
    const low = [ofOp(tokens.panel, 0.4), ofOp(tokens.panel2, 0.4)];
    // 判定口径与渲染同源，但第三代（2026-09-15）把三档拆到了两个机制上，所以这里
    // 也不再是一张「字阶表」：
    //   · text          由带的正文契约保证 ⟹ 门槛 LENS_BODY_LC；
    //   · text2 / text3 由 glassHardenTokens 对着最不利合成面加固 ⟹ 门槛
    //                   GLASS_HARDEN_LC / GLASS_HARDEN_WEAK_LC。
    // 关键：这里读到的 tokens 来自**页面上真实的 CSS 变量**，而置底 + 有底图时
    // theme-ui 写进去的就是加固后的表 —— 所以拿加固档位来量它是同源的，量的正是
    // 用户眼前那一份颜色。若哪天接线漏了（写进去的是原始表），这三条会当场变红，
    // 这也正是把它放在这里的价值：它是「加固到底有没有真的上屏」的唯一门禁。
    const TIER_KEYS = ['text', 'text2', 'text3'];
    const TIER_MIN = {
      text: T.LENS_BODY_LC,
      text2: T.GLASS_HARDEN_LC,
      text3: T.GLASS_HARDEN_WEAK_LC,
    };
    const meetsTiers = (lcs) => lcs.every((v, i) => Math.abs(v) >= TIER_MIN[TIER_KEYS[i]] - 1e-9);
    return {
      lightSkin: T.isLightSkin(tokens),
      skinTokens: tokens,
      migrated: tokens.panel !== '#e7ddda' && tokens.bg !== '#e4d3ce',
      // 一次性的不透明度归位真的发生了吗（种子 0.7 → 0.45）
      opMigrated: Math.abs(panelOp - 0.45) < 1e-9,
      lens: hex('--lens-filter'),
      panelOp, floor: floorV, effOp, dim, auto,
      band,
      panel: p1, panel2: p2,
      lowOp: low.map((r) => [r.surf, r.eff, r.lum, r.bandOk, r.lcs.map((v) => Math.round(v))]),
      lowOpOk: low.every((r) => r.bandOk && meetsTiers(r.lcs)),
      tiersOk: [p1, p2].every((r) => r.bandOk && meetsTiers(r.lc)),
    };
  });

  // ③ 地面真值（像素审计）的门槛：minAbsLc ≥ 30 且无任何元素跌破 30。
  //    30 有两个身份，正好重合，这是它被选中的原因：
  //      · APCA 对「装饰性部件」的绝对下限（低于它就是渲染了但看不见）；
  //      · 玻璃加固层里弱字阶那一档的目标（theme.GLASS_HARDEN_WEAK_LC）。
  //    两者必须相等，否则这个门禁会否掉实现**刚刚兑现**的那条线：加固把 text3 推到
  //    恰好达标（实测 plain 30.0 / userdark 30.5），门槛留在 32 的话审计会稳定报
  //    FAIL，而被指控的正是修复本身。这条对应关系由 theme.test 的
  //    「像素审计门槛与加固档位不漂」一节看住 —— 改 theme.js 那个常量而忘了改这里，
  //    单测会直接点名这一行。
  //    其余字色（text2 / 语义色）的目标是 45（GLASS_HARDEN_LC），比这条门槛高得多，
  //    所以 `below45` 这个计数继续留着：它是「加固是否真的覆盖到了每个键」的哨兵，
  //    数字不为 0 就说明有元素走在契约覆盖之外（例如新加的组件用了没进
  //    GLASS_HARDEN_KEYS 的色），不藏。
  const AUDIT_MIN_LC = 30; // == theme.GLASS_HARDEN_WEAK_LC（漂移由 theme.test 锁住）
  const audit = await pixelAudit(page, outDir, 'settings');
  const auditOk = model.lightSkin && model.migrated && model.tiersOk
    && model.opMigrated                        // 旧版地板逼出的 0.7 已归位到 0.45
    && /contrast\(/.test(model.lens || '')     // 透镜真的写进 CSS，不是只在模型里
    && model.lowOpOk                           // 0.40 的薄面板原地达标（滑杆真的自由了）
    && parseFloat(model.floor) <= 0.5          // 地板退到「只垫底」（旧版这里是 0.93）
    && audit.minAbsLc >= AUDIT_MIN_LC && audit.below30 === 0;
  report.push(`[bg-user-audit] model=${JSON.stringify(model)}`);
  const reportAudit = (tag, a) => {
    report.push(`[bg-user-audit:${tag}] elements=${a.total} minAbsLc=${a.minAbsLc} below30=${a.below30} below45=${a.below45}`);
    for (const it of a.worst) {
      report.push(`[bg-user-audit:${tag}]   Lc ${String(Math.abs(it.lcWorst)).padStart(5)} WCAG ${String(it.wcagWorst).padStart(5)} `
        + `fg ${it.fg} bg ${it.bgWorst} ${it.sel} 「${it.text}」`);
    }
  };
  reportAudit('settings', audit);
  await shoot(page, path.join(outDir, 'bg-user-audit-settings.png'));
  await page.click('.ri[data-screen="live"]');
  await page.waitForTimeout(900);
  const auditLive = await pixelAudit(page, outDir, 'live');
  reportAudit('live', auditLive);
  // 运行页含实时数据，判据与设置页一致（同一组数，别各写一套）：
  // 不许有元素跌破 APCA 的装饰线 30，最差也要 ≥ 玻璃契约里最弱那一档（text3 = 32）。
  const auditLiveOk = auditLive.below30 === 0 && auditLive.minAbsLc >= AUDIT_MIN_LC;
  report.push(`[bg-user-audit] settingsOk=${auditOk} liveOk=${auditLiveOk} `
    + `${auditOk && auditLiveOk ? 'OK' : 'FAIL'}`);
  await shoot(page, path.join(outDir, 'bg-user-audit-live.png'));

  // ③ 透出率：底图到底有没有从面板里透出来。同一屏拍两次 —— 第二次只把底图那一层
  //    的 url 摘掉（其余一切不动：滑杆、透镜、纱、类名全保持原样），逐面板量内部
  //    像素的平均差。差 ≈ 0 就是「面板把底图盖死了」，正是用户那句「不透明度都拉到
  //    0.93 了底图还是透不出来」的直接判据。这条不看模型，只看像素。
  const glassBoxes = await page.evaluate(() => Array.from(
    document.querySelectorAll('.card, .rc'), (el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.left + 10), Math.round(r.top + 10),
        Math.round(r.right - 10), Math.round(r.bottom - 10)];
    },
  ).filter(([a, b, c, d]) => c - a > 60 && d - b > 60));
  const shotA = (await page.screenshot({ type: 'png' })).toString('base64');
  const meansA = await shotBoxMeans(page, shotA, glassBoxes);
  await page.evaluate(() => document.documentElement.style.setProperty('--theme-bg-image', 'none'));
  await page.waitForTimeout(420);
  const shotB = (await page.screenshot({ type: 'png' })).toString('base64');
  fs.writeFileSync(path.join(outDir, 'bg-user-nowall-live.png'), Buffer.from(shotB, 'base64'));
  const meansB = await shotBoxMeans(page, shotB, glassBoxes);
  const deltas = meansA.map((m, i) => Math.round((
    Math.abs(m[0] - meansB[i][0]) + Math.abs(m[1] - meansB[i][1]) + Math.abs(m[2] - meansB[i][2])) / 3));
  const minDelta = deltas.length ? Math.min(...deltas) : 0;
  const meanDelta = deltas.length ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
  // ④ 底图的「形」有没有透出来（不只是「整体亮度变了」）。自适应透镜（auto-levels）就是
  //    为这一条加的：固定透镜下近黑壁纸只剩 3/255 的身后幅度，均值差（Δ）照样能过，但形
  //    一点都看不见，这条判据会掉到 1 以下。判据细节见 shotBoxCoarseDiff 的注释。
  const formSd = await shotBoxCoarseDiff(page, shotA, shotB, glassBoxes);
  const formMean = formSd.length
    ? Math.round(formSd.reduce((a, b) => a + b, 0) / formSd.length * 10) / 10 : 0;
  const formVisible = formSd.filter((v) => v >= 1.5).length;
  const formOk = formSd.length >= 4 && formMean >= 2.5
    && formVisible >= Math.ceil(formSd.length * 0.6);
  const glassOk = deltas.length >= 4 && minDelta >= 12;
  report.push(`[bg-user-glass] panels=${deltas.length} Δ=${JSON.stringify(deltas)} minΔ=${minDelta} `
    + `meanΔ=${meanDelta} ${glassOk ? 'OK' : 'FAIL'}`);
  report.push(`[bg-user-glass:form] diffSd=${JSON.stringify(formSd.map((v) => Math.round(v * 10) / 10))} `
    + `mean=${formMean} ≥1.5 的 ${formVisible}/${formSd.length} ${formOk ? 'OK' : 'FAIL'}`
    + `（判据：均值 ≥2.5 且六成以上 ≥1.5）`);
  await page.close();
} else {
  report.push(`[bg-user-audit] SKIP（找不到用户的壁纸 ${userWall}）`);
}

// ---- 深色背景图回归（同一轮修复不得动坏深色路径）----
// 深空壁纸 auto → 深色皮肤：黑纱方向、暗 tint、地板不钳、滑杆文案维持「背景压暗」。
// 这一轮换了度量（APCA）与新增明度带（暗侧上界 0.30），深色路径同样要过契约。
{
  const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
  await page.addInitScript(GUARD_PROBE);
  await page.addInitScript((cfg) => localStorage.setItem('netpeek-theme', cfg),
    '{"skin":"image","backgroundImage":"wallpapers/wall-1.jpg","panelOpacity":0.88,"bgBlur":8,"scrim":0.30,"imageDraft":null,"uiOpacity":1}');
  await page.goto('http://127.0.0.1:8932/preview.html', { waitUntil: 'load' });
  await page.waitForTimeout(2600);
  const probe = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const hex = (name) => cs.getPropertyValue(name).trim();
    const lumOf = (h) => window.chroma(h).luminance();
    const tokens = {
      bg: hex('--bg'), panel: hex('--panel'), text: hex('--text'),
      text2: hex('--text-2'), text3: hex('--text-3'),
    };
    const topbar = getComputedStyle(document.querySelector('.topbar')).backgroundColor;
    const nums = topbar.match(/[\d.]+/g) || [];
    return {
      hasBg: document.body.classList.contains('has-bg'),
      lightSkin: window.NetPeekTheme.isLightSkin(tokens),
      text2Lum: lumOf(hex('--text-2')), panelLum: lumOf(hex('--panel')),
      floorVar: cs.getPropertyValue('--panel-op-floor').trim(),
      tintLum: lumOf(hex('--backdrop-tint')),
      veil: cs.getPropertyValue('--backdrop-veil').trim(),
      topbarAlpha: nums.length >= 4 ? nums[nums.length - 1] : '1',
      scrimLabel: (document.querySelector('#scrimLabel b') || {}).textContent || '',
      lens: cs.getPropertyValue('--lens-filter').trim(),
      lowOp: window.__npGuard(tokens, 0.30, 0.40, [0.02, 0.35, 0.6, 0.95]),
      sweep: window.__npGuard(tokens, 0.30, 0.45, [0.02, 0.1, 0.25, 0.45, 0.65, 0.85, 0.99]),
    };
  });
  const darkOk = probe.hasBg && !probe.lightSkin
    && probe.text2Lum > probe.panelLum
    && parseFloat(probe.floorVar) === 0         // 地板不钳滑杆（暗侧同样交给透镜垫底）
    && probe.tintLum < 0.15
    && probe.veil === '0 0 0'
    && parseFloat(probe.topbarAlpha) < 0.6      // 暗底图上漆层真的透出底图（0.45）
    && /contrast\(/.test(probe.lens)            // 暗侧透镜：dim 到深色带
    && guardRowsOk(probe.lowOp)
    && probe.scrimLabel === '背景压暗'
    && guardRowsOk(probe.sweep);
  report.push(`[bg-dark] ${JSON.stringify({
    ...probe,
    lowOp: probe.lowOp.map((r) => [r.L, r.op, r.lum, r.bandOk, r.tiersOk]),
    sweep: probe.sweep.map((r) => [r.L, r.autoDim, r.floor, r.lum, r.bandOk, r.tiersOk]),
  })} ` + `${darkOk ? 'OK' : 'FAIL'}`);
  await page.click('.ri[data-screen="live"]');
  await page.waitForTimeout(800);
  await shoot(page, path.join(outDir, 'bg-dark-live.png'));
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

// ---- 判决与退出码 ----
//
// 这个脚本一直以 process.exit(0) 结尾 —— 上面 20 多处 `? 'OK' : 'FAIL'` 全都只是
// 打进报告里的一个字符串。于是它不是门禁，而是一份**需要人读**的报告：谁跑完不去
// 逐行扫 FAIL，就等于没跑。像素审计（bg-user-audit）是本仓库唯一的地面真值，
// 它判定失败却仍然退 0，这件事本身比任何一条具体断言都更值得修。
//
// 判决口径就是报告里已有的那些标记，不另立一套：任何一行出现 FAIL（含
// `FAIL(sweepOk=false)` 这种带括号的形式）就整体失败。
// 用 \b 前缀避免把将来可能出现的 "NOFAIL" 之类词误判。
const verdicts = report.filter((l) => /\b(?:OK|FAIL)\b/.test(l));
const failed = report.filter((l) => /\bFAIL/.test(l));
// 一条判决都没有 == 报告格式漂了（有人改了 push 的写法），这时**不能**当成通过：
// 「没有失败」和「没有检查」在退出码上必须区分开，否则门禁会静默失效。
if (verdicts.length === 0) {
  console.error('\n判决行为 0 —— 报告格式与判定口径已漂移，视为失败（不是「全过」）。');
  process.exit(2);
}
if (failed.length) {
  console.error(`\n${failed.length}/${verdicts.length} 项判定失败：`);
  for (const l of failed) console.error('  · ' + l.split('\n')[0].slice(0, 200));
  process.exit(1);
}
console.log(`\n${verdicts.length} 项判定全部通过。`);
process.exit(0);
