// _probe-glass.mjs —— 「底图到底透出来多少」的量尺 + 几档 backdrop-filter 的对照。
//
// 2026-09-15 用户第二次报同一个缺陷：「不透明度拉到最低了，还是没有透出底图，
// 现在深色也一样了，之前深色是可以的」。目视截图：墙纸（橙红火焰）在面板下变成
// 一片粉白雾。要判定「是不是透镜把图压掉了」，得有一个能把「底图的形」量化出来的
// 口径，而不是只看「有图/无图两张截图的面板色差 Δ」——Δ 大也可能是「整体只是变亮了
// 一点」，形依然看不见。
//
// 口径：同一块面板区域拍两张（有底图 / 摘掉底图），逐像素相减 → 那张差值图上，
// 面板自己的内容（字、线、图）在两张里是同一批像素，相减即抵消；留下的只有
// 「底图贡献的低频场」。再把这差值图按 cells×cells 分格取格均值，量它的峰谷差
// （p2p）——这就是底图的形在面板上肉眼可辨的幅度（0..255 通道单位）。
// p2p 越小越像「一块平色」。经验门槛见报告里打印的基准。
//
// 前提：scripts/preview-v2.mjs 至少跑过一次（它会在系统临时目录里生成带假桥的
// preview.html；本探针复用那个目录，并把最新 ui/ 源码覆盖进去，保证量的是当前代码）。
//
// 用法：NP_PW=<playwright 入口> NP_CHROME=<chrome.exe> node scripts/ui-tests/_probe-glass.mjs

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const pw = await import(process.env.NP_PW || 'playwright');
const chromium = pw.chromium || (pw.default && pw.default.chromium);

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const uiSrc = path.join(repo, 'src', 'NetPeek.App', 'ui');
const outDir = path.join(repo, '.workbuddy', 'tmp');

// ---- 复用 preview-v2 生成的临时预览根（含假桥），覆盖最新源码 ----
const cands = fs.readdirSync(os.tmpdir())
  .filter((d) => d.startsWith('netpeek-v2-'))
  .map((d) => path.join(os.tmpdir(), d, 'ui', 'preview.html'))
  .filter((p) => fs.existsSync(p))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
if (!cands.length) {
  console.error('找不到 preview.html —— 先跑一次 scripts/preview-v2.mjs');
  process.exit(2);
}
const uiDir = path.dirname(cands[0]);
for (const f of fs.readdirSync(uiSrc)) {
  fs.cpSync(path.join(uiSrc, f), path.join(uiDir, f), { recursive: true });
}

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
await new Promise((r) => server.listen(8933, '127.0.0.1', r));

// ---- 用户真实壁纸与配置（与 preview-v2 的 [bg-user-*] 块同源） ----
const userStore = path.join(os.homedir(), 'AppData', 'Roaming', 'com.netpeek.app');
const userWall = path.join(userStore, 'backgrounds', '0dd6251aab60ce90.jpg');
if (!fs.existsSync(userWall)) {
  console.error('找不到用户壁纸 ' + userWall);
  process.exit(2);
}
const wallData = 'data:image/jpeg;base64,' + fs.readFileSync(userWall).toString('base64');

const mkCfg = (mode, op) => JSON.stringify({
  skin: 'image',
  backgroundImage: wallData,
  panelOpacity: op, bgBlur: 0, scrim: 0.2,
  imageMode: mode, followSystem: false, uiOpacity: 1,
  bgBrightness: 1, backdropStyle: 'underlay', wrapOpacity: 0.4,
  // 浅色那一路带上用户真实配置里的旧草稿（验迁移 + 与用户实测同源）；深色那一路
  // 不带草稿 —— 带旧亮草稿时启动时不会按 dark 重新派生，量出来的还是浅色皮肤。
  imageDraft: mode === 'light' ? {
    tokens: {
      bg: '#e4d3ce', panel: '#e7ddda', panelHi: '#c9c0bd', panel2: '#d5c5c0',
      line: '#c1b8b5', lineSoft: '#d3c9c6', text: '#201917', text2: '#5d5250',
      text3: '#8b7f7b', down: '#8d5621', up: '#39668f', ok: '#286f4d',
      warn: '#795f33', error: '#9a4b4b', accent: '#38160e', accentInk: '#f2f3f5',
      selBar: '#48271e',
    },
    source: 'standard',
  } : null,
});

// 面板身后的背景压缩策略。'new' = 用页面自己算的（新：契约反解带端 + auto-levels）；
// 'oldfixed' = 上一次那组写死的固定透镜（这次返工前的状态）；'vibrancy' = 完全不压缩。
const OLD_FIXED = {
  light: 'contrast(0.105) brightness(1.9) saturate(3.2)',
  dark: 'contrast(0.9) brightness(0.5) saturate(1.15)',
};
const VARIANTS = [
  ['new', null],
  ['oldfixed', (mode) => OLD_FIXED[mode]],
  ['vibrancy', () => 'saturate(1.5)'],
];

// 逐格平均亮度差（有图 − 无图）。返回格均值数组与峰谷差 p2p（0..255）。
async function measure(page, b64A, b64B, box, cells = 8) {
  return page.evaluate(async ({ a, b, box, cells }) => {
    const dec = async (s) => {
      const img = await new Promise((res, rej) => {
        const i = new Image(); i.onload = () => res(i); i.onerror = rej;
        i.src = 'data:image/png;base64,' + s;
      });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return { d: ctx.getImageData(0, 0, cv.width, cv.height).data, W: cv.width, H: cv.height };
    };
    const A = await dec(a); const B = await dec(b);
    const [x0, y0, x1, y1] = box;
    const cw = (x1 - x0) / cells; const ch = (y1 - y0) / cells;
    const means = [];
    let sum = 0; let n = 0;
    for (let cy = 0; cy < cells; cy++) {
      for (let cx = 0; cx < cells; cx++) {
        const ax = Math.round(x0 + cx * cw); const bx = Math.round(x0 + (cx + 1) * cw);
        const ay = Math.round(y0 + cy * ch); const by = Math.round(y0 + (cy + 1) * ch);
        let s = 0; let k = 0;
        for (let y = ay; y < by; y++) {
          for (let x = ax; x < bx; x++) {
            const i = (y * A.W + x) * 4;
            // 通道均值差（面板漆层的整体位移）——A 减去 B
            s += ((A.d[i] - B.d[i]) + (A.d[i + 1] - B.d[i + 1]) + (A.d[i + 2] - B.d[i + 2])) / 3;
            k++;
          }
        }
        if (k) { means.push(s / k); sum += s / k; n++; }
      }
    }
    const sorted = [...means].sort((p, q) => p - q);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
    const mean = n ? sum / n : 0;
    const sd = n ? Math.sqrt(means.reduce((t, v) => t + (v - mean) * (v - mean), 0) / n) : 0;
    return {
      mean: Math.round(mean * 10) / 10,
      p2p: Math.round((pct(0.98) - pct(0.02)) * 10) / 10,
      sd: Math.round(sd * 10) / 10,
    };
  }, { a: b64A, b: b64B, box, cells });
}

const browser = await chromium.launch({ executablePath: process.env.NP_CHROME || undefined });
const lines = [];
const push = (s) => { lines.push(s); console.log(s); };

for (const mode of ['light', 'dark']) {
  for (const [name, variant] of VARIANTS) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 720 }, deviceScaleFactor: 1 });
    await page.addInitScript((cfg) => localStorage.setItem('netpeek-theme', cfg), mkCfg(mode, 0.3));
    await page.goto('http://127.0.0.1:8933/preview.html', { waitUntil: 'load' });
    await page.waitForTimeout(2600);
    // 面板滑杆拉到最低 + 切深浅（都走真实控件：设置页的外观分区），再回运行页量。
    await page.click('.ri[data-screen="settings"]');
    await page.waitForTimeout(500);
    await page.click('.snav button[data-sec="appearance"]');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const el = document.querySelector('#stdOpacity');
      if (el) { el.value = '0.3'; el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    if (mode === 'dark') {
      await page.click('#imageModeSeg button[data-mode="dark"]');
      await page.waitForTimeout(900);
    }
    await page.click('.ri[data-screen="live"]');
    await page.waitForTimeout(900);
    const filter = typeof variant === 'function' ? variant(mode) : null;
    if (filter) {
      await page.evaluate((f) => document.documentElement.style.setProperty('--lens-filter', f), filter);
      await page.waitForTimeout(320);
    }
    const info = await page.evaluate(() => {
      const T = window.NetPeekTheme;
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      const tokens = {
        bg: v('--bg'), panel: v('--panel'), panel2: v('--panel-2'),
        text: v('--text'), text2: v('--text-2'), text3: v('--text-3'),
      };
      const card = document.querySelector('.card');
      const csCard = card ? getComputedStyle(card) : null;
      const lf = v('--lens-filter');
      const band = T.lensBand(tokens);        // 通道单位（新：带端由契约反解，不再从 c/b 反推）
      const bandLum = T.bandOf(tokens);
      const op = Math.max(parseFloat(v('--panel-op')) || 0, parseFloat(v('--panel-op-floor')) || 0)
        * (parseFloat(v('--ui-opacity')) || 1);
      const rgbOf = (h) => { const x = T.hexToRgb(h); return { r: x.r, g: x.g, b: x.b }; };
      // 合成面 = mix(grey(带端), panel, op)：带端就是透镜输出的两端
      // 注意这里必须用**契约档**（LENS_DESIGN_OP），不是实测的 --paint-op ——
      // 深色皮肤一旦退化，--paint-op 会被地板顶到 1，用它算出来的合成面与 t 无关，
      // 打印出来的 Lc 全是同一个数（踩过）。
      const opC = T.LENS_DESIGN_OP;
      const comp = (t, surf) => {
        const g = t * 255;
        const bg = { r: g, g, b: g };
        const p = rgbOf(surf);
        const mix = { r: bg.r + (p.r - bg.r) * opC, g: bg.g + (p.g - bg.g) * opC, b: bg.b + (p.b - bg.b) * opC };
        const hex = '#' + [mix.r, mix.g, mix.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
        return { lum: Math.round(T.luminance(mix) * 1000) / 1000, lc: ['text', 'text2', 'text3'].map((k) => Math.round(Math.abs(T.apcaLc(tokens[k], hex)))) };
      };
      const light = T.isLightSkin(tokens);
      // 最不利那档（浅色皮肤取更暗的面板）也要给出合成面 —— 契约就是按它反解的
      const p1 = rgbOf(tokens.panel);
      const p2 = /^#[0-9a-f]{6}$/i.test(tokens.panel2) ? rgbOf(tokens.panel2) : p1;
      const worst = light
        ? (T.luminance(p1) <= T.luminance(p2) ? tokens.panel : tokens.panel2)
        : (T.luminance(p1) >= T.luminance(p2) ? tokens.panel : tokens.panel2);
      // 反解为什么退化：把原始 token、皮肤方向、以及各 t 处 meets() 的判定打出来。
      const raw = tokens;
      const tiersRaw = (light ? T.GLASS_TIERS.light : T.GLASS_TIERS.dark)
        .map(([k, min]) => [k, min, raw[k], /^#[0-9a-f]{6}$/i.test(raw[k] || '')]);
      const probeT = [0.05, 0.1, 0.2, 0.35, 0.5, 0.64, 0.8, 0.99];
      const trace = probeT.map((t) => {
        const c = comp(t, worst);
        return [t, c.lum, c.lc];
      });
      // 自校准后的**实际**目标 = min(声明档位, 该档在最有利端实测对比 × GLASS_TIER_REL)
      const tBest = light ? band[1] : band[0];
      const bestLc = comp(tBest, worst).lc;
      const eff = ['text', 'text2', 'text3'].map((k, i) => [
        k, Math.round(Math.min(
          (light ? T.GLASS_TIERS.light : T.GLASS_TIERS.dark).find(([kk]) => kk === k)?.[1] ?? 0,
          T.GLASS_TIER_REL * bestLc[i],
        ) * 10) / 10,
      ]);
      return {
        light, lens: lf, op: Math.round(op * 1000) / 1000,
        band: band.map((x) => Math.round(x * 1000) / 1000),
        bandLum: bandLum.map((x) => Math.round(x * 1000) / 1000),
        worst, panel: tokens.panel, panel2: tokens.panel2,
        auto: v('--backdrop-auto'), dim: v('--backdrop-dim'), floor: v('--panel-op-floor'),
        cardBg: csCard ? csCard.backgroundColor : '',
        worstLo: comp(band[0], worst),
        worstHi: comp(band[1], worst),
        isLight: T.isLightSkin(raw), raw, tiersRaw, trace, eff, bestLc, rel: T.GLASS_TIER_REL,
      };
    });
    const box = await page.evaluate(() => {
      const el = document.querySelector('.card');
      const r = el.getBoundingClientRect();
      return [Math.round(r.left + 12), Math.round(r.top + 12), Math.round(r.right - 12), Math.round(r.bottom - 12)];
    });
    const shotA = (await page.screenshot({ type: 'png' })).toString('base64');
    fs.writeFileSync(path.join(outDir, `glass-${mode}-${name}.png`), Buffer.from(shotA, 'base64'));
    await page.evaluate(() => document.documentElement.style.setProperty('--theme-bg-image', 'none'));
    await page.waitForTimeout(420);
    const shotB = (await page.screenshot({ type: 'png' })).toString('base64');
    const mm = await measure(page, shotA, shotB, box);
    push(`[${mode}/${name}] lens=${info.lens}`);
    push(`    op=${info.op} floor=${info.floor} auto=${info.auto} dim=${info.dim} cardBg=${info.cardBg}`);
    push(`    panel=${info.panel} panel2=${info.panel2} 最不利=${info.worst}`);
    push(`    band(ch)=[${info.band}] band(lum)=[${info.bandLum}]`);
    push(`    最不利合成面 暗端 lum=${info.worstLo.lum} Lc=${JSON.stringify(info.worstLo.lc)}`
      + ` 亮端 lum=${info.worstHi.lum} Lc=${JSON.stringify(info.worstHi.lc)}`);
    push(`    底图在面板上的形: meanΔ=${mm.mean} p2p=${mm.p2p} sd=${mm.sd}  (box=${JSON.stringify(box)})`);
    push(`    isLightSkin=${info.isLight} raw=${JSON.stringify(info.raw)}`);
    push(`    tiers=${JSON.stringify(info.tiersRaw)}  (k, 声明档位, 实值, 是否通过 hex 过滤)`);
    push(`    REL=${info.rel} 自校准后实际目标=${JSON.stringify(info.eff)} (最有利端实测 Lc=${JSON.stringify(info.bestLc)})`);
    push(`    meets 轨迹 t→[lum, [text,text2,text3]|Lc]: ${JSON.stringify(info.trace)}`);
    await page.close();
  }
}

fs.writeFileSync(path.join(outDir, 'probe-glass.txt'), lines.join('\n'), 'utf8');
await browser.close();
server.close();
