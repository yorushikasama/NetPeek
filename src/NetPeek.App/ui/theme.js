// NetPeek 皮肤系统（v2）。
// 皮肤 = 一份 17 键颜色 token 表，运行时覆写到 documentElement 的同名 CSS 变量上；
// 栅格、字号阶、间距、组件结构不在 token 里，任何皮肤下布局一致，换肤是安全的。
//
// 四类皮肤来源，共用同一条「token 表 → CSS 变量」流水线：
//   1. 内置（plain / light / amber）：手写精确 token 表，出厂即用；
//   2. 跟随背景图（image）：从背景图中位切分取色生成 token 表，可再叠 AI 生成（高级项）；
//   3. 自定义（themes 里用户另存的皮肤）：在编辑器里改单键，当场生效；
//   4. 旧配置迁移：三模式主题（standard / ai / custom）启动时自动映射到以上三类。
//
// token 分层（tokens.css §分层原则）：
//   - --accent / --accent-ink / --sel-bar 管交互（选中、主按钮、开关、焦点条）；
//   - --down / --up 只管数据（图表、速率、排行），永远不进 chrome。
//
// 依赖 Tauri 命令（window.__TAURI__.core.invoke）做配置持久化与背景图落盘；
// 无 Tauri 环境（浏览器预览）时自动降级为 localStorage，方便调试。

const THEME_EVENT = 'netpeek-themechange';

// ---------- 工具：颜色 ----------

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function mix(a, b, t) {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

// ---------- OKLab（CSS Color 4，Björn Ottosson 的常数） ----------
//
// 派生混色全部搬进 OKLab：sRGB 各通道非线性，直接插值中间调偏暗偏浊、
// 往白/黑推会拐弯偏色相。OKLab 里 L 均匀、色相不漂，混出来的阶（panel→panelHi、
// text→text2→text3）才像「同一支笔由深到浅」，而不是发灰的一段。
const srgbToLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const linearToSrgb = (v) =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

function rgbToOklab({ r, g, b }) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToRgb({ L, a, b }) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const ch = (v) =>
    Math.round(255 * Math.min(1, Math.max(0, linearToSrgb(v))));
  return {
    r: ch(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: ch(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: ch(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

// OKLab 空间插值。两个在色域内的颜色朝黑/白/彼此插值不会出 gamut，
// 首尾通道照旧钳位兜底。
function mixOk(a, b, t) {
  const oa = rgbToOklab(a);
  const ob = rgbToOklab(b);
  return oklabToRgb({
    L: oa.L + (ob.L - oa.L) * t,
    a: oa.a + (ob.a - oa.a) * t,
    b: oa.b + (ob.b - oa.b) * t,
  });
}

// OKLab 彩度（a/b 平面到原点的距离）：「可用彩色 / 强调色评分」的统一标尺。
// 旧的 RGB max-min 判据随色相漂移（蓝黄同彩度差一倍多），OKLab 不挑色相。
function okChroma(rgb) {
  const o = rgbToOklab(rgb);
  return Math.hypot(o.a, o.b);
}

// WCAG 相对亮度（0..1）与对比度比：公式委托给 chroma-js（vendor/chroma.min.js，
// UMD，BSD/Apache）。这组系数错一个，全站颜色就发灰发暗 —— 手写版出过「取整后
// 掉回 4.49」的边界坑，工业实现替我们把这些坑踩平了。库缺失时宁可在这里炸出来：
// 测试与 dom-contract 会拦住「忘了带 vendor」的提交，静默换回手写公式反而是藏雷。
function chromaOf(v) {
  const C = window.chroma;
  if (!C) throw new Error('[NetPeek] chroma-js 未加载：检查 vendor/chroma.min.js 的 script 标签');
  // 分数通道（mix 的插值中间值）先取整再交给库：最终落到屏幕上的就是取整后的
  // hex，对比度判断按同一套取整值算，才不会有「判定达标、渲染出来差一点」的缝。
  if (typeof v === 'string') return C(v.trim().replace(/^#?/, '#'));
  const r = Math.max(0, Math.min(255, Math.round(v.r)));
  const g = Math.max(0, Math.min(255, Math.round(v.g)));
  const b = Math.max(0, Math.min(255, Math.round(v.b)));
  return C(r, g, b);
}

function luminance(rgb) {
  return chromaOf(rgb).luminance();
}

function contrast(a, b) {
  return window.chroma.contrast(chromaOf(a), chromaOf(b));
}

// ---------- APCA（WCAG 3 的感知对比度模型） ----------
//
// 为什么面板被底图稀释之后不能再用 WCAG 2 的比值说了算：那个比值是「相对亮度」
// 的线性比，而人眼对亮度差的感知在不同区间差着量级。面板被底图稀释成中调之后，
// 暗字对它的比值还报 6–10（远超标），实际观感却是「灰字压灰底」——中调区间的
// 亮度差最不值钱。2026-09-15 用户实测：近黑壁纸 + 浅色派生 + 面板 0.70，合成面
// 落在 L 0.36 的中调，WCAG 判定「正文 6.6 达标」，而单位字、说明字、导轨图标
// 全部糊掉（比值 1.4–2.8），只能靠人眼发现。
//
// APCA 是 WCAG 3（Silver）草案采用的替代模型：按极性分别取指数（暗字压亮底
// ^0.57/^0.56，亮字压暗底 ^0.62/^0.65），对极暗色做软钳位（模拟光晕），
// 输出带符号的 Lc（正 = 暗字压亮底，负 = 亮字压暗底），绝对值为可达性指标。
// 它在中间调与低对比区间与人的判断吻合得多，正好补上上面那个盲区。
// 常量取 Myndex 参考实现 0.1.9（4g）；算法本身在 public domain。
const APCA = {
  mainTRC: 2.4,
  normBG: 0.56, normTXT: 0.57, revTXT: 0.62, revBG: 0.65,
  sRco: 0.2126729, sGco: 0.7151522, sBco: 0.0721750,
  blkThrs: 0.022, blkClmp: 1.414, deltaYmin: 0.0005,
  scaleBoW: 1.14, scaleWoB: 1.14,
  loBoWthresh: 0.035991, loBoWoffset: 0.027,
  loWoBthresh: 0.035991, loWoBoffset: 0.027,
};

// 线性化用 ^2.4 而不是 WCAG 的 sRGB 分段曲线 —— APCA 的 sRGB 系数是配套这个的。
function apcaY({ r, g, b }) {
  const t = APCA.mainTRC;
  return APCA.sRco * Math.pow(r / 255, t)
    + APCA.sGco * Math.pow(g / 255, t)
    + APCA.sBco * Math.pow(b / 255, t);
}

function apcaSoftClamp(y) {
  return y > APCA.blkThrs ? y : y + Math.pow(APCA.blkThrs - y, APCA.blkClmp);
}

// 带符号的 Lc。|Lc| 是可达性指标：90 正文下限、75 理想正文、60 大字与 UI 部件、
// 45 有意义的图标、30 装饰性部件。
function apcaLc(fg, bg) {
  const ytx = apcaSoftClamp(apcaY(typeof fg === 'string' ? hexToRgb(fg) : fg));
  const ybg = apcaSoftClamp(apcaY(typeof bg === 'string' ? hexToRgb(bg) : bg));
  if (Math.abs(ybg - ytx) < APCA.deltaYmin) return 0;
  if (ybg > ytx) {
    const s = (Math.pow(ybg, APCA.normBG) - Math.pow(ytx, APCA.normTXT)) * APCA.scaleBoW;
    return s < APCA.loBoWthresh ? 0 : Math.round((s - APCA.loBoWoffset) * 1000) / 10;
  }
  const s = (Math.pow(ybg, APCA.revBG) - Math.pow(ytx, APCA.revTXT)) * APCA.scaleWoB;
  return s > -APCA.loWoBthresh ? 0 : Math.round((s + APCA.loWoBoffset) * 1000) / 10;
}

// 字阶的 APCA 目标，按出厂皮肤反标定（不是照抄 APCA 通用表）：两套出厂皮肤
// 实测 —— 浅色 正文 99 / 次要 78 / 弱字阶 53，朴素 86 / 49 / 24。
// 底图稀释之后取「仍站得住、又不把层级压平」的一档：浅色 75 / 60 / 40。
// 正文 75 就是 APCA 表里「理想正文」的下限（大字与 UI 部件的下限是 60）。
// 弱字阶（40）是这次修复的重点 —— 旧实现完全不守它（注释里那句「3:1 是它的
// 设计意图」，在底图把面板稀释成中调之后它只剩 Lc 16，设计意图早就没了）。
// 深色皮肤沿用原档位（次要字 45 ≈ 原来的 WCAG 4.5）；底图只会把深色面板
// 稀释得更暗，亮字在更暗的底上对比度只增不减，弱字阶不需要单独守。
const APCA_TIERS = {
  light: [['text', 75], ['text2', 60], ['text3', 40]],
  dark: [['text2', 45]],
};

// 两色在色环上的最短距离（0–180）。无彩色（灰）h 为 NaN，按 0 处理——
// 调用方只把它用在「彩色 vs 彩色」的判族上，灰色本来就该和任何彩色拉开。
function hueDistance(a, b) {
  const ha = chromaOf(a).get('hsl.h') || 0;
  const hb = chromaOf(b).get('hsl.h') || 0;
  const d = Math.abs(ha - hb) % 360;
  return d > 180 ? 360 - d : d;
}

const MIN_CONTRAST = 4.5;

// 弱字阶（--text-3）的下限。设计意图是「3:1 左右」，两套出厂皮肤的实测落在
// 2.91–2.99；但线性派生在亮底上会掉到 2.4 —— 半透面板再叠到亮图最亮的区域，
// 实测只剩 1.0–1.4，字还在渲染、人已经看不见了。托底取 2.9：不动任何手写
// 出厂值（它们不经 expandTokens），只把派生结果拉回设计带。
const WEAK_MIN_CONTRAST = 2.9;

// 把前景色在给定背景上调亮/调暗直到对比度达标（若无法达到 min，尽量逼近并报告）。
function ensureContrast(fgHex, bgHex, min = MIN_CONTRAST) {
  const bg = hexToRgb(bgHex);
  let fg = hexToRgb(fgHex);
  if (contrast(fg, bg) >= min) return fgHex;
  const baseLum = luminance(bg);
  // 背景偏暗 → 往白调；偏亮 → 往黑调
  const target = baseLum < 0.4 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const c = mixOk(fg, target, mid);
    if (contrast(c, bg) >= min) hi = mid;
    else lo = mid;
  }
  let out = mixOk(fg, target, hi);
  // 注意：对比度判断必须基于「取整后的十六进制值」——未取整值达标、取整后可能跌破阈值（如 4.49）。
  for (let i = 0; i < 32 && contrast(hexToRgb(rgbToHex(out)), bg) < min; i++) {
    out = mixOk(out, target, 0.04);
  }
  return rgbToHex(out);
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// ---------- 中位切分取色（跟随背景图皮肤用） ----------

// ---------- 取色：委托 ColorThief（vendor/color-thief.min.js，MIT，UMD） ----------
// 中位切分是「错一点、整套皮肤就脏一个色相」的算法，手写版没有过一条直接断言。
// 这里委托社区锤了十年的实现：主色用 getColor（= 最重的桶，保住「主色 = 权重
// 最大」的原语义），完整色板用 getPalette；pickBase 只保留剩下的设计决策 ——
// 强调色取其余颜色里最饱和的那个。拿不到 ColorThief 或取色抛错时退回平均色：
// 至少给出一套协调的深浅底，比黑屏或永远停在上一张壁纸的颜色诚实。

function extractPalette(imgEl) {
  try {
    const CT = window.ColorThief;
    if (CT && imgEl) {
      const thief = new CT();
      const dominant = thief.getColor(imgEl);
      const rest = (thief.getPalette(imgEl, 8) || [])
        .filter((c) => !(c[0] === dominant[0] && c[1] === dominant[1] && c[2] === dominant[2]))
        .map((c) => ({ r: c[0], g: c[1], b: c[2], weight: 0 }));
      return [{ r: dominant[0], g: dominant[1], b: dominant[2], weight: 1 }, ...rest];
    }
  } catch { /* 取色失败走平均色回落 */ }
  return null;
}

// 平均色回落：跳过透明像素，对抽样点取均值。
function averageColor(imgData) {
  const { data } = imgData;
  let n = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] < 128) continue;
    sum[0] += data[i];
    sum[1] += data[i + 1];
    sum[2] += data[i + 2];
    n++;
  }
  if (!n) return null;
  return {
    r: Math.round(sum[0] / n),
    g: Math.round(sum[1] / n),
    b: Math.round(sum[2] / n),
    weight: 1,
  };
}

// 真实像素权重：ColorThief 的 getPalette 不回传桶计数（此前非主色 weight 全是
// 0，「按权重排序」全靠它内部按频次出队的稳定序意外成立）。这里按最近邻归属
// 直接数像素 —— 每 4 像素采 1 个，512px 缩图上约 6.5 万样本 × 8 色，亚毫秒级。
function paletteWeights(imgData, palette) {
  if (!imgData || !imgData.data || !palette.length) return null;
  const { data } = imgData;
  const w = new Array(palette.length).fill(0);
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    let best = -1;
    let bd = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const c = palette[k];
      const dr = r - c.r;
      const dg = g - c.g;
      const db = b - c.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = k; }
    }
    if (best >= 0) { w[best]++; n++; }
  }
  return n ? w.map((x) => x / n) : null;
}

// OKLab 色相（0–360）。测试与色板去重用的轻量工具。
function okHue(o) {
  const h = (Math.atan2(o.b, o.a) * 180) / Math.PI;
  return h < 0 ? h + 360 : h;
}

// 从色板挑出「主色」（真实占比最大）与「强调色」候选序列。
// 强调色按「彩度 × √占比」评分：纯彩度会选到图里一粒稀有荧光桶，纯占比会选到
// 最大公约数的灰彩；√ 在两者之间取势 —— 占比太低扳不动高彩度，但比线性更偏向
// 「有点分量」的颜色。可用彩色同时看彩度门槛（OKLab ≥0.05）与明度带（0.13–0.92）：
// 近黑近白的「彩」撑不起交互强调。
function pickBase(palette) {
  if (!palette.length) return null;
  const sorted = [...palette].sort((a, b) => b.weight - a.weight);
  const score = (c) => okChroma(c) * Math.sqrt(Math.max(c.weight, 1e-4));
  const usable = (c) => {
    const o = rgbToOklab(c);
    return okChroma(c) >= 0.05 && o.L >= 0.13 && o.L <= 0.92;
  };
  const vivid = sorted.filter(usable).sort((a, b) => score(b) - score(a));
  return { main: sorted[0], vivid, accent: vivid[0] || null };
}

// ---------- 内置皮肤（手写精确表，出厂即用） ----------

// 17 键完整表。plain 与 tokens.css 的 :root 完全一致 —— 皮肤只是覆写同名变量。
const SKINS = {
  plain: {
    id: 'plain',
    name: '默认 · 朴素',
    tokens: {
      bg: '#1b1d21', panel: '#22252a', panelHi: '#2c2f36', panel2: '#17191d',
      line: '#32363e', lineSoft: '#272a30',
      text: '#e3e5e9', text2: '#9ba1a9', text3: '#686e77',
      down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
      accent: '#e3e5e9', accentInk: '#1b1d21', selBar: '#c9cdd4',
    },
  },
  light: {
    id: 'light',
    name: '浅色',
    tokens: {
      bg: '#f2f3f5', panel: '#ffffff', panelHi: '#eef0f4', panel2: '#e8eaee',
      line: '#d6dade', lineSoft: '#e4e6ea',
      text: '#23272e', text2: '#5b6270', text3: '#9098a4',
      down: '#b45a10', up: '#2e6f9e', ok: '#1f6f44', warn: '#8a6608', error: '#b3352b',
      accent: '#2f3540', accentInk: '#f2f3f5', selBar: '#565e6b',
    },
  },
  amber: {
    id: 'amber',
    name: '琥珀暖意',
    tokens: {
      bg: '#201b16', panel: '#292219', panelHi: '#332a1f', panel2: '#1a1510',
      line: '#3e3428', lineSoft: '#302820',
      text: '#efe6d8', text2: '#a89a86', text3: '#776b5b',
      down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
      accent: '#d98a3d', accentInk: '#2b1c0f', selBar: '#e2a55c',
    },
  },
};

// ---------- 令牌派生 ----------

// 从核心键（bg / panel / text / down / up + 可选 accent）派生完整 17 键表。
// 服务于动态路径：背景图取色、AI 生成、旧配置迁移。内置皮肤不走这里（手写精确值）。
//
// opts.tightRamp：给「面板会被底图稀释」的场景（跟随背景图皮肤）收两处结构：
//
// ① 字阶混比收紧（浅色侧 0.38/0.60 → 0.18/0.36）。线性混出来的 text2/text3 是
//    相对「纯面板」调的，面板被稀释成中调之后这个相对关系整体下移 —— 0.38/0.60
//    在合成面上只剩 Lc 59/32（2026-09-15 像素审计实测：顶栏那行状态字 36、
//    卡片里的单位字 49），而收紧到 0.18/0.36 之后同一合成面上是 66/50。
//    字阶是相对关系，合成面把整条阶压向中间，阶深也必须跟着收 —— 不收敛的结果
//    是「正文还能看、说明字与图标先糊」，层级还在、可读性没了。
// ② 凹档的落差收小（浅色侧 0.05 → 0.02）。0.05 的 OKLab 混比落在浅色区间是
//    约 15% 的**亮度**落差（Oklab L 与 Y 近似立方关系），顶栏 / rail / 表头那一档
//    （--panel-2）因此比面板暗出一整截 —— 本该是「一档凹色」，稀释后成了另一块
//    中调面，同一条判据在它上面总是先失守（审计里 Lc 36 那三个元素全在顶栏）。
//    深色侧不动：暗区里 15% 的亮度差本来就看不出来，亮字在更暗的底上只会更清楚。
function expandTokens(core, opts = {}) {
  const tight = !!opts.tightRamp;
  const bgRgb = hexToRgb(core.bg);
  const panelRgb = hexToRgb(core.panel);
  const textRgb = hexToRgb(core.text);
  // 文字亮 → 深色底：派生方向随之翻转
  const dark = luminance(textRgb) > 0.5;
  const toward = dark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };

  const out = {
    bg: core.bg,
    panel: core.panel,
    // 抬一档：hover、选中底、悬停读数小卡
    panelHi: rgbToHex(mixOk(panelRgb, toward, dark ? 0.06 : 0.10)),
    // 凹一档：顶栏、rail、表头、输入框
    panel2: rgbToHex(mixOk(bgRgb, { r: 0, g: 0, b: 0 }, dark ? 0.15 : (tight ? 0.02 : 0.05))),
    line: rgbToHex(mixOk(panelRgb, textRgb, dark ? 0.09 : 0.17)),
    lineSoft: rgbToHex(mixOk(panelRgb, textRgb, dark ? 0.03 : 0.09)),
    text: core.text,
    text2: rgbToHex(mixOk(textRgb, bgRgb, dark ? 0.35 : (tight ? 0.18 : 0.38))),
    text3: rgbToHex(mixOk(textRgb, bgRgb, dark ? 0.62 : (tight ? 0.36 : 0.60))),
    down: core.down,
    up: core.up,
    ok: core.ok,
    warn: core.warn,
    error: core.error,
    // 交互强调缺省 = 中性反白（深色）/ 中性深灰（浅色），与 v2 基底思路一致
    accent: core.accent || core.text,
  };

  // 弱字阶托底：text3 的设计带是 ≈3:1（见 WEAK_MIN_CONTRAST），线性混出来的值在
  // 亮底派生皮肤上只有 2.4 左右（雪地 / 天空类壁纸实测），半透面板再叠到图上
  // 最亮的区域就只剩 1.0–1.4。在派生处直接托住 —— 内置皮肤是手写精确值不走这里，
  // 用户在编辑器里钉住的 override 会在 deriveTokens 里盖回来，都不受影响。
  out.text3 = ensureContrast(out.text3, out.panel, WEAK_MIN_CONTRAST);

  // 强调底上的文字：两个候选里谁对比度高用谁（琥珀这类中间亮度色靠它选黑字）
  const acc = hexToRgb(out.accent);
  const darkInk = { r: 21, g: 23, b: 27 };
  const lightInk = { r: 242, g: 243, b: 245 };
  out.accentInk = contrast(acc, darkInk) >= contrast(acc, lightInk)
    ? rgbToHex(darkInk)
    : rgbToHex(lightInk);
  // 选中指示条 = 强调色略收敛一档
  out.selBar = rgbToHex(mixOk(acc, bgRgb, 0.10));
  return out;
}

// ---------- 编辑器草稿：核心键 / 派生键分层 ----------
//
// 为什么草稿不能只存一张展开好的 17 键表：expandTokens 里有 8 个键是从核心键算出来的
// （顶栏底色、边线、次要字阶、强调底上的字…）。往展开表里单改一个「窗口底」，
// 那 8 个派生键会永远停在上一套底色的值上 —— 把窗口底改成浅色后，顶栏、rail、表头
// 仍然是 #17191d 的深色，浮在浅色面板上。这不是配色难看，是这套皮肤根本没法用。
//
// 所以草稿存 { core, overrides }：core 是 expandTokens 的入参，每次改动重新派生；
// overrides 记用户显式点过的派生键。少了 overrides 就分不清「这个值是算出来的、
// 该跟着更新」和「这个值是用户特意挑的、不许动」，重新派生会把人的选择冲掉。
const CORE_KEYS = ['bg', 'panel', 'text', 'down', 'up', 'ok', 'warn', 'error', 'accent'];
const DERIVED_KEYS = ['panelHi', 'panel2', 'line', 'lineSoft', 'text2', 'text3', 'accentInk', 'selBar'];

function coreOf(tokens) {
  const core = {};
  for (const k of CORE_KEYS) if (tokens && tokens[k]) core[k] = tokens[k];
  return core;
}

// 一张既有的 17 键表 → { core, overrides }。
// 与派生结果不同的派生键一律记为 override：这样迁移过来的皮肤外观分毫不变，
// 同时之后再改核心键时，那些「本来就是算出来的」键能跟着动。
function draftFromTokens(tokens) {
  const core = coreOf(tokens);
  const derived = expandTokens(core);
  const overrides = {};
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  for (const k of DERIVED_KEYS) {
    if (tokens[k] && !same(tokens[k], derived[k])) overrides[k] = tokens[k];
  }
  return { core, overrides };
}

// { core, overrides } → 完整 17 键表。兼容只有 tokens 的旧草稿。
function composeDraft(draft) {
  if (!draft || typeof draft !== 'object') return null;
  if (draft.core && draft.core.bg) {
    return { ...expandTokens(draft.core), ...(draft.overrides || {}) };
  }
  if (draft.tokens) return { ...draft.tokens };
  return null;
}

// 往草稿里写一个键。核心键进 core（触发重新派生），派生键进 overrides（钉住）。
function setDraftKey(draft, key, hex) {
  const d = draft && draft.core ? draft : { core: {}, overrides: {} };
  if (!d.overrides) d.overrides = {};
  if (CORE_KEYS.includes(key)) d.core[key] = hex;
  else d.overrides[key] = hex;
  return d;
}

// ---------- 派生规则版本：存量草稿跟着算法走 ----------
//
// 取了色、存下来的草稿是「一张算好的 17 键表」，算法改了它不会自己重算 ——
// 只改代码的话，新选图的用户拿到新颜色，老用户永远停在旧规则的结果上
// （2026-09-15 实测：明度带与字阶混比都换过之后，用户配置里那份 #e4d3ce/#e7ddda
// 的粉米色表面还在原样渲染，改动对他等于没发生）。
// 带版本号之后，启动迁移把老草稿按当前规则重算一次。
const DERIVE_REV = 3;

// 按当前规则重算一份已展开的 17 键草稿。只动两处与可读性绑死的：
//   · bg / panel 重新过明度带（色相与彩度原样保留，只挪明度）；
//   · 字阶走收紧混比（expandTokens 的 tightRamp）。
// 其余核心键（text / down / up / ok / warn / error / accent）原样保留 ——
// 用户或 AI 挑的颜色不该被算法改写。
function refreshDerivedTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return tokens;
  const light = isLightSkin(tokens);
  const core = coreOf(tokens);
  if (!core.bg || !core.panel || !core.text) return tokens;
  core.bg = rgbToHex(normalizedSurface(
    hexToRgb(core.bg), light ? 0.93 : 0.15, light ? 0.96 : 0.30, light ? 0.02 : 0.03));
  core.panel = rgbToHex(normalizedSurface(
    hexToRgb(core.panel), light ? 0.955 : 0.20, light ? 0.985 : 0.36, light ? 0.012 : 0.02));
  return validateSkin(expandTokens(core, { tightRamp: true }));
}

// 旧版（v1 三模式主题）10 键 token → 新 17 键表。用于旧配置迁移与 AI 返回值归一。
function convertLegacyTokens(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.panelHi) return { ...t }; // 已是新格式
  const core = {
    bg: t.bg,
    panel: t.panel,
    text: t.text,
    down: t.down,
    up: t.up,
    ok: t.ok,
    warn: t.warn,
    error: t.error,
    accent: t.text, // 旧格式没有交互强调，用主文字色承接（中性反白）
  };
  const full = expandTokens(core);
  // 旧键能对上的就沿用：border → line，muted → text2（text3 由 text2 派生）
  if (/^#[0-9a-f]{6}$/i.test(t.border || '')) full.line = t.border;
  if (/^#[0-9a-f]{6}$/i.test(t.muted || '')) {
    full.text2 = t.muted;
    full.text3 = rgbToHex(mixOk(hexToRgb(t.muted), hexToRgb(t.bg), 0.4));
  }
  return full;
}

// 对比度校验并修正：正文字阶与语义色相对 panel ≥ 4.5。
// text3（弱文字阶）不校 —— 3:1 左右的弱对比是它的设计意图，校了层级就没了。
function validateSkin(tokens) {
  return guardTokens(tokens).tokens;
}

// 需要保证可读性的键。text3 不在内：3:1 左右的弱对比是它的设计意图。
const GUARDED_KEYS = ['text', 'text2', 'down', 'up', 'ok', 'warn', 'error', 'accent'];

// validateSkin 的「带回执」版本：既给修正后的表，也给出被动过哪些键。
// 为什么要这个回执：原来 applyDraft 根本不校验，编辑器会照单全收对比度 1.03 的
// 主文字（字直接看不见）；而保存时 validateSkin 又静默改写用户挑的颜色 ——
// 预览到的和存下来的不是一个东西。两头都不诚实。有了 adjusted，UI 可以当场
// 按守卫后的颜色渲染、同时把「这个色我替你提亮了」说出来。
function guardTokens(tokens) {
  const out = { ...tokens };
  const adjusted = [];
  for (const k of GUARDED_KEYS) {
    if (!/^#[0-9a-f]{6}$/i.test(out[k] || '')) continue;
    let fixed = ensureContrast(out[k], out.panel);
    // panel-2 是输入框 / 顶栏 / 表头的底色：浅色皮肤里它比 panel 更暗，深色文字在
    // 它上面的对比度更低 —— 只对 panel 达标的 text/text2 在它上面可能跌破 4.5。
    // 两块底色各校一遍，ensureContrast 只会往达标方向推，串联取的就是更严的那个。
    if (k === 'text' || k === 'text2') {
      fixed = ensureContrast(fixed, out.panel2);
    }
    if (fixed.toLowerCase() !== String(out[k]).toLowerCase()) {
      adjusted.push(k);
      out[k] = fixed;
    }
  }
  // 强调底上的字单独看一眼：它比的是 accent 而不是 panel。
  if (/^#[0-9a-f]{6}$/i.test(out.accentInk || '')) {
    const fixed = ensureContrast(out.accentInk, out.accent);
    if (fixed.toLowerCase() !== String(out.accentInk).toLowerCase()) {
      adjusted.push('accentInk');
      out.accentInk = fixed;
    }
  }
  return { tokens: out, adjusted };
}

// 从核心键重新派生整张表，然后把用户显式改过的派生键盖回去。
// overrides 是一个 { 键名: true } 的集合 —— 只有它能区分「这个值是算出来的、
// 该跟着核心键更新」和「这个值是用户特意挑的、重新派生不许动」。
function deriveTokens(tokens, overrides = {}) {
  const out = expandTokens(coreOf(tokens));
  for (const k of DERIVED_KEYS) {
    if (overrides[k] && /^#[0-9a-f]{6}$/i.test(tokens[k] || '')) out[k] = tokens[k];
  }
  return out;
}

// ---------- 背景图上的可读性 ----------

// 线性亮度 → 等亮度灰的 sRGB 通道值（luminance 的逆函数）。
function lumToChannel(lum) {
  const l = Math.min(1, Math.max(0, lum));
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

// 皮肤方向：亮字压暗底（深色皮肤）还是暗字压亮底（浅色皮肤）。
// 纱的方向、守卫的补偿方向、底图亮度的分位口径都跟着它走 —— 深色皮肤怕图里的
// 成片亮区（亮字没地方落），浅色皮肤怕成片暗区（暗字没地方落），互为镜像。
function isLightSkin(tokens) {
  const t2 = luminance(hexToRgb(tokens.text2 || tokens.text));
  const p = luminance(hexToRgb(tokens.panel));
  return t2 < p;
}

// 纱的合成目标色：深色皮肤混向黑（压暗亮区），浅色皮肤混向亮纱（抬亮暗区）。
// 亮纱不用纯白，用 scrimTint 的浅色分支（从皮肤底色派生的「有颜色的亮」）——
// Mica 的浅色质感同样来自 tint 而不是惨白；更重要的是守卫拿同一个色当模型目标，
// 与 CSS 实际铺的两层纱（tint 纱 + auto 补偿层）方向一致，近似合成才是保守的。
function veilOf(tokens) {
  if (!isLightSkin(tokens)) return { r: 0, g: 0, b: 0 };
  return hexToRgb(scrimTint(tokens.bg, true));
}

// 纱浓度的方向化有效值 —— CSS（--backdrop-dim）与守卫模型（backdropGuard 的
// scrim 入参）共用的唯一口径，两边必须同源，可读性判定才不会和实际渲染漂移。
// 深色皮肤：滑杆值即有效值（0.2–0.6，压暗是深色皮肤的主语言，图暗下去不心疼）。
// 浅色皮肤：亮纱只做「轻度统一观感」，浓度按 0.45 折算（0.2–0.6 → 0.09–0.27）。
// 旧版把 0.2 当下限直接全量铺白纱，暗壁纸缝隙里的图被抬成一片粉白、戏剧性全无
// （2026-09-15 用户实测：暗红壁纸钉浅色 = 整窗发白发粉）；用户把滑杆拖到下限
// 0.2 仍然糊 —— 折算让存量配置不动滑杆就回到「图为主、纱为辅」。
function effectiveScrim(scrim, lightSkin) {
  const v = clamp(scrim ?? 0.30, 0.2, 0.6);
  return lightSkin ? Math.round(v * 0.45 * 100) / 100 : v;
}

// ---------- 面板局部背景归一化（glass lens） ----------
//
// 面板自己的 backdrop-filter 先把「身后的底图」压进本皮肤方向的那条明度带，然后
// 才叠半透漆层。这一步解开的是整个可读性方案里最硬的死结 —— 旧版只能二选一：
// 想要可读，就把面板不透明度地板一路抬到 0.9+（底图彻底看不见）；想要看见底图，
// 就得忍受面板和近黑底图混成一块中调灰粉。局部归一化把矛盾解在「面板身后那块
// 背景」上：缝隙里的底图保持原样锐利（戏剧性一点不丢），只有面板下方那一块被抬成
// 浅色柔色玻璃 —— 这正是 macOS vibrancy / Win11 Acrylic 的做法（它们也从不让
// 原始图直接透出材质，透出的是压过一条窄带的「亮度层」）。
//
// CSS 的 filter 是逐通道仿射：out = in * (c·b) + 0.5·b·(1 − c)
// （contrast(c) 绕 0.5 收缩，再 brightness(b) 缩放）。于是「把 [0,1] 映到目标带
// [lo,hi]」有闭式解：斜率 c·b = hi − lo，截距 0.5·b·(1 − c) = lo。
// 带的两端不是常量，是从「可读性契约」反解出来的（见 lensBand）：浅色带底 =
// 「合成面最不利的那一档面板上正文恰好达标」的那条线，深色对称取带顶，另一端固定。
// 底图自己那段灰在带内被拉张开（auto-levels），于是**带有多宽，底图的形就有多大**。
// contrast 收缩会把彩度一起压掉（色相被拉向中灰），所以要补 saturate()，补偿量
// 必须跟着 c 走（见 chromaComp）。
//
// 亮度口径上 saturate 可以忽略（filter 的 saturate 矩阵是保亮度的），所以守卫模型
// 只算 contrast + brightness 两步；blur 也不进模型 —— 它取的是邻域均值，比最坏像素
// 温和，忽略它只会让守卫更保守。
//
// 2026-09-15 第二次返工（用户第二次报同一缺陷：不透明度拉到最低还是透不出底图）：
// 旧版把带写死成浅色 [0.85, 1] 通道 —— 一条 0.15 宽、贴着纯白的窄带。底图自己的
// 形在里面只剩几个灰阶，实测面板上只剩 p2p 11/255，肉眼就是一块粉白雾；而 saturate
// 也写死 3.2（那是给 c=0.105 配的补偿量），透镜改成自适应后 c 变大、补过头，整幅
// 发粉。现在两端按契约反解、彩度补偿跟着 c 走。
// 面板不透明度滑杆的下限（另一处是 index.html 的 range min，必须同步改）。
// 它能放到 0.30，是因为透镜接手了「底图偏暗 / 偏亮」那一档 —— 局部归一化之后
// 0.30 的漆层仍读得出「一块有色玻璃 + 正文字阶达标」。
const MIN_PANEL_OP = 0.30;
// 反解带端时假设的面板不透明度：**取滑杆下限**，不取默认档。这样契约在整个滑杆
// 行程上都成立 —— 拖到最低时正文字阶恰好是 LENS_BODY_LC，往上拖只会更好。
// （若取默认档 0.45，拖到下限就会比契约低一档，用户看到的是「越透明字越虚」。）
const LENS_DESIGN_OP = MIN_PANEL_OP;
// 正文契约：合成面上主文字（--text）必须守住的 |Lc|。60 是 APCA 对 16px 正文的
// 「可用」线；严格表的 75 要求浅色合成面亮度 ≥ 0.63，会把玻璃钉回近白（带只剩
// 0.23 宽，就是用户两次报上来的那块粉白雾）。
//
// 2026-09-16 —— 带的判据从「多档字阶 AND + 自校准折扣」收敛成**两条**：
// 正文契约 + 中调护栏（下面两个常量）。其余所有字色不再参与反解，改由玻璃加固层
// （glassHardenTokens）对着最不利合成面逐键校 —— 这一步不花带宽。
//
// 为什么必须换掉旧口径（三个实测事实）：
// ① 旧口径把 text2/text3 也写进反解，而它们在深色皮肤上贴着物理天花板（深色次要
//    字是一枚中灰，压近黑底 |Lc| 上限 ≈43，声明档却写 45），于是 meets 恒假、带退化
//    成一个点、透镜变 null、守卫把面板地板顶到 1 —— 就是 b0c3db2 修的「深色全不透明」。
// ② 为绕开①加的自校准折扣（旧 GLASS_TIER_REL = 0.75）实测**不是兜底而是无条件
//    打折**：plain 的 text2 物理上限 50.3、声明 45 明明可达，实际目标却被折到 37.7。
//    折扣让契约变成永不失败的判据 —— 构造一套低对比深色皮肤，目标会一起塌到
//    text 29.6 / text2 14.0，系统认为完全达标（实测 text3 只剩 Lc 9.5）。
// ③ 旧口径下带的决定权偶然落在「被折扣后的 text2」上，纯属巧合：谁的折后目标
//    最紧，带就由谁定。这解释了为什么四轮返工每次都在别处冒出新问题。
//
// 新口径下带宽不降反升（实测 plain 0.305→0.389、light 0.182→0.367），因为卡住带的
// 那个折后 text2 走了，接手的是一条有明确物理含义的线。
const LENS_BODY_LC = 60;
// 中调护栏：合成面自己的亮度必须留在本方向的表面区里 —— 深色皮肤 ≤ 0.10、
// 浅色皮肤 ≥ 0.40（相对亮度）。这是明度带最初存在的理由（Mica 的 tonal band）：
// 2026-09-15 实测过一次反例 —— 合成面滑到 #ada4a1（L 0.36）时「既不是浅色面板也
// 不是深色面板」，比值判定还报达标，顶栏状态字实测只有 Lc 36。
//
// 护栏与正文契约取更严的那条（两者对亮度同向单调，AND 即最保守）。实测里深色侧
// 总是护栏更紧（正文在护栏端还有 Lc 72–74 的富余），浅色侧总是正文契约更紧 ——
// 这个不对称是对的：深色皮肤的亮字在中调面上会先失去「表面感」，浅色皮肤的暗字
// 先失去对比度。
//
// 阈值怎么定的（扫了 0.10/0.12/0.15 × 0.40/0.42/0.45 九组）：0.10/0.40 在「带最宽」
// 与「加固位移最小」两头同时最优。放宽到 0.15 带只多 0.10，但加固位移从 ≤50 涨到
// ≥57、字阶被压平（text2 的原始 Lc 掉到 24.6，加固要把它推 39/255）。
const GLASS_MID_MAX_DARK = 0.10;
const GLASS_MID_MIN_LIGHT = 0.40;
const LENS_BAND_TOP = 0.99;           // 浅色带顶（通道值）：留一点白，不烧成纯色
const LENS_BAND_BOTTOM_DARK = 0.05;   // 深色带底（通道值）：留一点黑，暗部不压死
// 玻璃加固的目标 |Lc|：合成面上除正文以外的所有文字/图标色都要守住这条线。
// 45 是 APCA 对「非正文但仍需读」（次要说明、数据单位、语义色数字）的可用线，
// 也正好是旧 APCA_TIERS.dark 里那一档的值 —— 换句话说加固把旧口径**声明过但
// 从未真正守住**的那条线兑现了。
const GLASS_HARDEN_LC = 45;
// 弱字阶（--text-3）单独一档：它的设计意图本来就是「弱」—— 实测三套出厂皮肤在
// 纯面板上只有 Lc 23–25，把它推到 45 等于取消这个层级（字阶会从 88/48/23 压成
// 90/75/55，层级信息全平）。旧口径下它在合成面上的实测值是 Lc 7.6–13.9，
// 那已经是「渲染了但看不见」。
//
// 30 而不是 25：30 是 APCA 给「装饰性 / 非必读部件」的下限，也是 preview-v2 的
// 像素审计一直在用的硬地板（`below30 === 0`）。取 25 会让模型层自认达标、而
// 同一批像素在审计里判失败 —— 两套口径对同一件事给出相反结论，是这套主题系统
// 反复踩的那类缺陷（回归拿另一套档位去量玻璃）。实测代价也确认了它便宜：
// 五套皮肤 25→30 的字阶顺序全部保持，最大位移只从 55 涨到 62/255。
const GLASS_HARDEN_WEAK_LC = 30;

// 彩度补偿：contrast(c) 把彩度按 ≈2c 缩（相对亮度之比），saturate 补回来。
// 钳在 [0.7, 2.6]：auto-levels 在大斜率时 c 接近 1，此时不是要补而是略微收一点。
function chromaComp(c) {
  return clamp(Math.round((0.5 / c) * 100) / 100, 0.7, 2.6);
}

// 由带的两端（通道值）反解 CSS filter 三件套。仿射 out = in·(c·b) + 0.5·b·(1−c)
// 把 [0,1] 映到 [t0,t1] ⟹ 斜率 s = t1−t0 = c·b、截距 t0 ⟹ b = 2·t0 + s、c = s/b。
function lensParams(t0, t1) {
  const s = t1 - t0;
  const b = 2 * t0 + s;
  if (!(s > 0) || !(b > 0) || !isFinite(b)) return null;
  const c = s / b;
  if (!(c > 0) || !isFinite(c)) return null;
  return {
    contrast: Math.round(c * 1000) / 1000,
    brightness: Math.round(b * 1000) / 1000,
    saturate: chromaComp(c),
  };
}

// 最不利那档面板底色：面板底色有两档（--panel 卡片 / --panel-2 顶栏·rail·表头·
// 输入框），后者凹一档。浅色皮肤怕「更暗」（暗字没地方落）取更暗的，深色取更亮的。
// 带的反解、护栏判定、加固层的目标底色共用这一份，避免三处口径漂移。
function worstSurface(tokens) {
  const p1 = hexToRgb(tokens.panel);
  const p2 = /^#[0-9a-f]{6}$/i.test(tokens.panel2 || '') ? hexToRgb(tokens.panel2) : p1;
  return isLightSkin(tokens)
    ? (luminance(p1) <= luminance(p2) ? p1 : p2)
    : (luminance(p1) >= luminance(p2) ? p1 : p2);
}

// 带的两条判据，导出成一份数据供回归脚本使用（判定口径必须与渲染同源，否则回归
// 只会逼着实现把带宽还回去 —— 2026-09-15 踩过：回归拿 APCA_TIERS 的 75/60/40 去量
// 玻璃合成面，那套档位在归一化玻璃上无解）。
// 返回 { bodyLc, midMax, midMin }：正文契约档 + 中调护栏的方向化边界（另一侧为 null）。
function glassContract(tokens) {
  const light = isLightSkin(tokens);
  return {
    bodyLc: LENS_BODY_LC,
    midMax: light ? null : GLASS_MID_MAX_DARK,
    midMin: light ? GLASS_MID_MIN_LIGHT : null,
  };
}

// 合成面（带上某点的灰与最不利那档面板按设计不透明度调和）—— lensBand 的反解、
// 护栏判定、加固层的目标底色全部走这一个函数，避免三处口径漂移。
function glassComposite(tokens, t, op = LENS_DESIGN_OP) {
  const surf = worstSurface(tokens);
  const g = clamp(t, 0, 1) * 255;
  return rgbToHex({
    r: g + (surf.r - g) * op, g: g + (surf.g - g) * op, b: g + (surf.b - g) * op,
  });
}

// 加固层的目标底色：带的**最不利那一端**上的合成面。浅色皮肤最不利 = 带底（最暗，
// 暗字最难读）、深色皮肤 = 带顶（最亮，亮字最难读）。加固对着它校，于是整条带上
// 每一点都达标 —— 与「透镜输出结构上不越带」那条不变量配合，覆盖的是**每个像素**。
function glassWorstComposite(tokens) {
  const [t0, t1] = lensBand(tokens);
  return glassComposite(tokens, isLightSkin(tokens) ? t0 : t1);
}

function lensBand(tokens) {
  const light = isLightSkin(tokens);
  const { bodyLc, midMax, midMin } = glassContract(tokens);
  const composite = (t) => hexToRgb(glassComposite(tokens, t));
  // 两条判据取 AND（都对亮度同向单调，AND 即最保守那条线）：
  //   ① 正文契约：合成面上 --text 的 |Lc| ≥ bodyLc
  //   ② 中调护栏：合成面自己的亮度留在本方向的表面区里
  // 其余字色**不在这里** —— 它们由 glassHardenTokens 对着最不利合成面加固，不花带宽。
  const meets = (t) => {
    const rgb = composite(t);
    const L = luminance(rgb);
    if (midMax != null && L > midMax + 1e-9) return false;
    if (midMin != null && L < midMin - 1e-9) return false;
    if (/^#[0-9a-f]{6}$/i.test(tokens.text || '')) {
      if (Math.abs(apcaLc(tokens.text, rgbToHex(rgb))) < bodyLc) return false;
    }
    return true;
  };
  if (light) {
    let lo = 0;
    let hi = LENS_BAND_TOP;
    // 铁律兜底：正常皮肤走不到这里（带顶近白，浅色皮肤的暗字在它上面 |Lc| 远超 60，
    // 护栏的 midMin 也必然满足），只有病态皮肤（浅色方向却配了一枚亮正文）会落进来。
    // 那时退化成整条带 = 恒等透镜 —— 仍是一个**有效**透镜，绝不返回 null。
    // 返回 null 会让 backdropGuard 退回「无透镜」分支把面板地板顶到 1，底图彻底
    // 消失（2026-09-15 的「深色变全不透明」就是这条链）。宁可「不归一化」，
    // 也不能「没有透镜」。加固层在这种皮肤上照样对着最不利合成面兜住字色。
    if (!meets(hi)) return [0, LENS_BAND_TOP];
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (meets(mid)) hi = mid; else lo = mid;
    }
    return [hi, LENS_BAND_TOP];
  }
  let lo = LENS_BAND_BOTTOM_DARK;
  let hi = 1;
  // 同上的铁律兜底。深色侧带底 0.05 是近黑，亮正文在它上面 |Lc| 通常 90+，护栏的
  // midMax 也满足，所以正常皮肤走不到。
  if (!meets(lo)) return [LENS_BAND_BOTTOM_DARK, 1];
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (meets(mid)) lo = mid; else hi = mid;
  }
  return [LENS_BAND_BOTTOM_DARK, lo];
}

// 回落透镜：把底图**整条** [0,1] 映射进明度带（不按图自己的直方图拉张）。图还没
// 解码完 / 图太平 / 参数退化时走这一支；解码完之后由 lensFromImage 接管 —— 带的两端
// 两种情况下同源，所以「回落」只是少了一层拉张，契约不变。
function lensOf(tokens) {
  const [t0, t1] = lensBand(tokens);
  return lensParams(t0, t1);
}

// ---------- 玻璃加固：除正文以外的字色对着合成面校 ----------
//
// 带只承载两条判据（正文契约 + 中调护栏，见 lensBand），其余字色在这里解决。
// 分开的理由是这两件事花的**不是同一份预算**：带宽是「底图的形」的预算 —— 每多让
// 一档字阶去解带，带就窄一截，用户看到的就是「底图透不出来」；而把字色本身往对比
// 方向推一点是**零带宽代价**的。
//
// 2026-09-15 之前的四轮返工全在推带（面板下限 0.88→0.30、正文档位 APCA 75→60、
// 声明档位→×0.75 自校准、守卫整体退休），带已经榨干了，而字色这根杠杆一次没动过。
// 实测：把缺失档位塞回带里，深色侧 text3@32 直接无解（带退化 → 透镜 null → 地板
// 顶到 1，原地重现 2026-09-15 20:00 修掉的那个缺陷）、放宽到 25 带宽从 0.305 塌到
// 0.031、语义色 @45 塌到 0.003。同一批档位交给加固：位移 ≤50/255、字阶顺序全部
// 保持、带宽反而从 0.305 升到 0.389（护栏比旧的「被折扣的 text2」更宽松地圈住带）。
//
// 施加范围（theme-ui.applyCurrent）：**只在置底 + 有底图**时。没有底图时面板是实底，
// 出厂皮肤手写的 88/48/23 字阶就是设计意图本身，不该被动；贴膜模式没有面板级透镜、
// 走 wrapFloor 那条独立判据；小窗是透明窗 + 实底面板，同理拿原始表。

// 需要加固的键：实际会作为**文字 / 图标色**压在合成面上的那些。
// 不在内的三个都是有意的：
//   --text     由带的正文契约保证（≥ LENS_BODY_LC），加固再推一遍是重复劳动；
//   --accent   全仓库只作背景（按钮底 styles.css:728、开关 :1363、选区 :28）与
//              原生控件的 accent-color(:1641)，从不作为压在玻璃上的文字色 ——
//              把它一起加固的结果是 amber 的品牌琥珀 #d98a3d 被洗成 #efc8a6，
//              给一个不存在的场景做补偿；
//   --sel-bar / --line* 同理，是指示条与边线，不是文字。
const GLASS_HARDEN_KEYS = ['text2', 'text3', 'up', 'down', 'ok', 'warn', 'error'];

// 把前景色沿「远离底色」的方向推到 |Lc| 达标，走 OKLab 混色（与 ensureContrast
// 同一条路）：色相与彩度尽量保住、主要动明度 —— 语义色推完还得认得出是橙是蓝。
//
// 不用二分：|Lc| 对混比**不是单调**的。前景若起步在底色的「另一侧」（如深底上比
// 底还暗一点的弱字阶），往白推的过程里 |Lc| 会先降到 0（跨过底色）再升，二分会
// 收敛到错的一侧。逐步扫描取第一个达标点，既避开这个坑，又天然给出最小位移。
// 判定用**取整后**的十六进制值：未取整达标、取整后跌破是踩过的坑（§2.47）。
function ensureApca(fgHex, bgHex, min) {
  if (!/^#[0-9a-f]{6}$/i.test(fgHex || '') || !/^#[0-9a-f]{6}$/i.test(bgHex || '')) return fgHex;
  if (Math.abs(apcaLc(fgHex, bgHex)) >= min) return fgHex;
  const fg = hexToRgb(fgHex);
  // 底色偏暗 → 往白推；偏亮 → 往黑推。0.4 的门限与 ensureContrast 同源。
  const target = luminance(hexToRgb(bgHex)) < 0.4 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  const STEPS = 256; // 步长 ≈1/255，与通道量化同一格，再细没有意义
  for (let i = 1; i <= STEPS; i++) {
    const hex = rgbToHex(mixOk(fg, target, i / STEPS));
    if (Math.abs(apcaLc(hex, bgHex)) >= min) return hex;
  }
  // 推到端点仍不达标：返回端点（纯白 / 纯黑），这是这个色相能给的极限。
  // 不返回原色 —— 原色是**已知不达标**的那个值，端点至少是最接近达标的。
  return rgbToHex(target);
}

// 加固后的令牌表 + 回执。回执（adjusted）不是可选的：guardTokens 当年的教训是
// 「预览到的和存下来的不是一个东西」两头都不诚实，UI 要能把「这个色我替你推了」
// 说出来（theme-ui 的 opFloorNote）。
//
// 缓存：拖滑杆不会走到这里（applyBackdropOnly 只重铺 backdrop、不重算令牌），
// 但换肤 / 编辑器逐帧改色会 —— 一次 7 键 × 最多 256 步的 OKLab 往返不该白算两遍。
//
// 缓存的是**决定**（哪个键推成哪个值），不是整张令牌表。这个区别不是洁癖，是
// 一个实测缺陷：键只能覆盖参与计算的那几个值（panel/panel2/text + 7 个字色），
// 而整表里还有 accent / bg / line* / sel-bar 等一大票**穿过去**的键。缓存整表时，
// 两套皮肤只要计算输入逐位相同、却在某个穿透键上不同（例如同一套深色底 + 字色、
// 只有强调色不一样 —— 用户在编辑器里单独改 accent 就是这个形状），后来的那次会
// 命中前一次的表，把**别人的** accent 一起拿回去上屏。单测实测到的就是这一幕：
// 派生暗红的 accent #f0e5e2 被返回成 #f2ecea。
// 把决定叠回调用方自己的表，穿透键就永远来自调用方，结构上不可能串味。
const hardenCache = new Map();
function glassHardenTokens(tokens) {
  if (!tokens || !/^#[0-9a-f]{6}$/i.test(tokens.panel || '')) return { tokens, adjusted: [] };
  const ck = [tokens.panel, tokens.panel2, tokens.text, ...GLASS_HARDEN_KEYS.map((k) => tokens[k])].join('|');
  let plan = hardenCache.get(ck);
  if (!plan) {
    const bg = glassWorstComposite(tokens);
    plan = [];
    for (const k of GLASS_HARDEN_KEYS) {
      if (!/^#[0-9a-f]{6}$/i.test(tokens[k] || '')) continue;
      // 弱字阶单独一档：把它推到 45 等于取消这个层级（字阶会从 88/48/23 压成
      // 90/75/55，层级信息全平）。见 GLASS_HARDEN_WEAK_LC。
      const min = k === 'text3' ? GLASS_HARDEN_WEAK_LC : GLASS_HARDEN_LC;
      const fixed = ensureApca(tokens[k], bg, min);
      if (fixed.toLowerCase() !== String(tokens[k]).toLowerCase()) plan.push([k, fixed]);
    }
    // 上限只为防编辑器逐帧改色把表撑大；主题表数量级是个位数，1024 远够。
    if (hardenCache.size > 1024) hardenCache.clear();
    hardenCache.set(ck, plan);
  }
  const out = { ...tokens };
  for (const [k, v] of plan) out[k] = v;
  return { tokens: out, adjusted: plan.map(([k]) => k) };
}

// 写进 CSS 变量（applyBackdrop 用）。数值与守卫模型同源，不手抄两遍。
function lensFilter(lens) {
  return `contrast(${lens.contrast}) brightness(${lens.brightness}) saturate(${lens.saturate})`;
}

// 逐通道走 contrast + brightness（与 CSS filter 的语义一致，含 clamp）。通道按
// 0..255 进出，与别处的 hexToRgb / mix 同一量纲。
function lensApply(rgb, lens) {
  const ch = (v) => clamp(((v / 255 - 0.5) * lens.contrast + 0.5) * lens.brightness, 0, 1) * 255;
  return { r: ch(rgb.r), g: ch(rgb.g), b: ch(rgb.b) };
}

// ---------- 自适应透镜（auto-levels） ----------
//
// 回落透镜把底图**整条** [0,1] 映射进明度带 —— 对「自己就占满整条灰」的图没问题，
// 对「自己只占一小段灰」的壁纸就浪费掉大半条带：2026-09-15 用户那张壁纸的块均值
// 等效灰通道只落在 0.06–0.13（宽 0.07），回落透镜只把这 0.07 铺进带里的一小截，
// 剩下的带空着。所以透镜还要**按这张图自己的直方图拉张开**：把图的实际灰范围
// [p2, p98] 铺满整条带。Mica 采样壁纸生成材质做的也是这件事。
//
// 带的两端不因 auto-levels 而变（那是可读性契约），变的只是「用图的哪一小段灰去铺
// 它」—— 契约在，底图的形也满幅。这才是「不透明度拉到最低也看得见底图」的那一步。
//
// 灰范围下限：宽度低于这个值（约 5/255）的图基本是一块平色，拉张只会把 JPEG 的
// 压缩噪声放大成色块，不如交给回落透镜老实铺平。门槛取 0.02 是为「几乎纯色」的
// 极端图（如整幅 #0a0a0a）。
const MIN_IMG_RANGE = 0.02;
// 斜率上限：极暗且极平的图算出的 s 会很大，钳住免得噪声主导。
const MAX_LENS_SLOPE = 6;

// 由底图自己的灰范围反解透镜参数。lo / hi 是**原始**（未铺纱）的等效灰通道，
// 0..1。veil（纱色）与 scrim（已方向化的有效浓度）由调用方给出 —— 透镜实际吃到
// 的输入是「纱铺过的图」，必须用铺纱之后的 [lo, hi] 反解：暗图 + 亮纱时，纱会把
// 整段推到带顶之上，用原始范围反解出来的斜率会把它们全 clamp 成白，底图反而
// 彻底消失（这是本实现的第一个坑，实测踩到过）。
// brightness 是「背景亮度」滑杆的倍率：CSS 里它作用在 .backdrop::before 的
// filter 上，位于纱之下、面板透镜之上，所以要先乘进来再铺纱。
// 返回值可能是 null（图太平 / 参数退化），调用方回落到 lensOf(tokens)。
//
// 2026-09-15 第三次返工 —— 归一化的**锚点**：
// 旧版把图的 [p2, p98] 映到 [t0, t1]（锚点 = veiled(p2)）。这在数学上把图的内部对比
// 用满，但代价是**比 p2 更暗的像素会掉到带底之下**（截距 t = t0 − s·loV 是负的：
// 输入 0 的输出 = t < t0）。而带是整个设计的**不变量** —— 契约（各档字阶达标）、
// 守卫（地板退休、滑杆不被拿走）、像素审计全都以「透镜输出 ∈ 带」为前提，输出一旦
// 掉出去，三条保证同时作废。实测踩到：用户壁纸里成片的近黑区落在 `.top-meta` 那行
// 后面，像素审计量到弱字阶 Lc 28.6（旧窄带时代是 60.3）。
// 现在锚点改成「输入可能达到的最低值」= veiled(0) = vc·a（纱把纯黑抬到的那一点）：
// 于是 out(0) = t0、out(veiled(1)) ≥ t1，**输出结构上不可能越过带底**。
// 代价是图自己的 [p2,p98] 只占带的一段：(hiV−loV)/(hiV−zeroV)（近黑图 ≈100%、
// 中调图 ≈55–75%）。拿回来的东西更值：任何像素都在带内，契约对**每个像素**成立，
// 而不是只管 98% 再赌剩下的 2% 不成片。
// 上端**故意**只用 p98 当锚（不用白点 veiled(1)）：用白点会把图的可用范围按
// (hiV−zeroV)/(veiled(1)−zeroV) 压掉一个数量级（实测浅色侧是 7.7×），形全没了。
// 代价是 p98 之上那 2% 的像素输出会略微越过带顶（越界量 = s·(veiled(1)−hiV)，
// 浅色侧被 clamp 在 1.0；深色侧实测 ≈0.03 通道 ≈ 6 灰阶，可忽略）。
function lensFromImage(lo, hi, tokens, scrim, brightness = 1) {
  const [t0, t1] = lensBand(tokens);
  if (!(t1 - t0 > 0)) return null;
  const beta = clamp(brightness ?? 1, 0.2, 3);
  const vc = lumToChannel(luminance(veilOf(tokens))) / 255;
  const a = clamp(scrim ?? 0, 0, 1);
  const veiled = (v) => {
    const l = clamp(v * beta, 0, 1);
    return l + (vc - l) * a;
  };
  const loV = veiled(lo);
  const hiV = veiled(hi);
  const range = hiV - loV;
  if (!(range > MIN_IMG_RANGE)) return null;
  // 锚在输入下限 zeroV：out(0) = t0，带底成为输出的硬下界（见上面的长注释）。
  const zeroV = veiled(0);
  const span = hiV - zeroV;
  if (!(span > 0)) return null;
  let s = (t1 - t0) / span;
  if (!(s > 0) || !isFinite(s)) return null;
  // 斜率只管一件事：不发散（上限）。**不能**再加「截距 ≥ 0.05」这类下限 ——
  // 带底降到 0.613 之后，把一张暗图的最亮端送到带顶本来就需要大斜率、而这必然
  // 对应负截距；那条下限会把最亮端按在带顶之下（实测 0.85 vs 0.99），等于把刚
  // 争来的带宽原样还回去（本轮单测当场抓到）。真正要防的发散是 b = 2t + s ≤ 0
  // （那会让 CSS 的 contrast/brightness 取到 ≤0，语义未定义）—— 交给下面的
  // b > 0 判据回落 lensOf，而不是靠斜率下限硬撑。
  s = Math.min(s, MAX_LENS_SLOPE);
  // 反解出 contrast / brightness：out = s·in + t，CSS 里 s = c·b、t = 0.5·b·(1−c)
  // → b = 2t + s、c = s / b。
  const t = t0 - s * zeroV;
  const b = 2 * t + s;
  if (!(b > 0) || !isFinite(b)) return null;
  const c = s / b;
  if (!(c > 0) || !isFinite(c)) return null;
  return {
    contrast: Math.round(c * 1000) / 1000,
    brightness: Math.round(b * 1000) / 1000,
    saturate: chromaComp(c),
  };
}

// 面板叠在背景图上之后，文字实际踩着的那个颜色。
// 层序（styles.css）：底图 → 纱（方向随皮肤）→ 面板自己的 lens（backdrop-filter）
// → 半透面板。纱与 lens 都在面板之下，先纱、再 lens、最后叠漆。
// veil 是纱的合成目标（黑 / 亮纱），与 CSS 两层同色纱等效：mix(图, veil, 纱浓度)
// 再 lens(…) 再 mix(…, panel, 不透明度)。
// lens 传 null 表示这个模式下没有面板级 backdrop-filter（贴膜模式：膜直接由
// 面板底色与壁纸调和，没有「身后那块背景」可言）。
// 全局界面不透明度（--ui-opacity）不参与这里：floor 只管「面板滑杆 vs 底图」的
// 可读关系，全局淡出作用于所有漆层（含底图），是用户的显式选择，不该被 floor 钳住。
function effectivePanel(tokens, backdropLum, scrim, opacity, veil = veilOf(tokens), lens = lensOf(tokens)) {
  const v = lumToChannel(backdropLum);
  const veiled = mix({ r: v, g: v, b: v }, veil, clamp(scrim, 0, 1));
  const behind = lens ? lensApply(veiled, lens) : veiled;
  return rgbToHex(mix(behind, hexToRgb(tokens.panel), clamp(opacity, 0, 1)));
}

// ---------- 表面明度带（Mica 的 tonal band） ----------
//
// 「合成面必须仍是一块可读的表面」这条规则本身没变，但**带的两端不再是常量**：
// 由 lensBand 按可读性契约反解（带底 = 合成面最暗处正文达标的那条线）。
//
// 为什么放弃常量：旧版浅色带写死 [0.64, 1] 亮度，配合旧透镜把面板身后的背景压进
// 一条近白窄带 —— 合成面确实稳稳落在带内，但底图自己的形只剩几个灰阶（实测面板上
// p2p 11/255），用户看到的是「一块粉白雾」，连着两次当成缺陷报上来。带底放低之后
// 合成面仍是一块**浅色玻璃**（不是旧版那种中调灰粉：中调来自「暗图 + 粉米面板」
// 的灰混，这里来自带内带宽的底图本身，色相与明暗都跟着底图走）。
//
// 带同时用于守卫与像素审计（「合成面没滑进中调」），口径 = 面板身后那块背景被
// 归一化之后落在哪一段亮度（通道 → 亮度）。

// 面板不透明度滑杆的下限（另一处是 index.html 的 range min，必须同步改）。
// 常量定义挪到透镜一节（lensBand 的反解就以它为基准），这里只留说明：旧版下限
// 写死 0.70、且守卫算出的地板会把滑杆的 min 顶上去（theme-ui 里那行
// `els.opacity.min =`），于是「看见底图」这个能力被整个拿走了 —— 2026-09-15
// 用户实测：滑杆拉到底就是 0.93，底图一点透不出来。

function bandOf(tokens) {
  const [t0, t1] = lensBand(tokens);
  const lumOf = (t) => luminance({ r: t * 255, g: t * 255, b: t * 255 });
  return [lumOf(t0), lumOf(t1)];
}

// 给定底图亮度与纱浓度，求「合成面仍落在明度带内、且各字阶仍达 APCA 目标」
// 的面板不透明度下限。两条判据共用一条二分：不透明度越高，合成面越接近纯面板
// 色（浅色皮肤下更亮、深色皮肤下更暗），明度带与对比度都朝达标方向单调。
// 字阶档位按方向分（APCA_TIERS）：浅色守 正文 80 / 次要 60 / 弱字阶 40，
// 深色守 次要字 45（≈ 原来那条 WCAG 4.5）。弱字阶这次进守卫，是本次修复的
// 重点：它此前被「3:1 是设计意图」豁免掉，而底图把面板稀释成中调之后它的
// 实际值只剩 Lc 16 —— 设计意图早就没了，豁免的是「已经不存在的东西」
// （2026-09-13 那次让它握一票否决的教训是「档位不能照抄」，不是「不许守」）。
// minOp 是搜索起点也是返回下界：守卫管线（backdropGuard）与滑杆下限共用 0.30。
// lens 是「面板身后那块背景会被归一成什么」的模型（自适应透镜，见 lensFromImage）：
// 必须与 CSS 实际铺的 --lens-filter 同源，否则判定的和渲染的不是同一件事。
function backdropFloor(tokens, backdropLum, scrim, minOp = MIN_PANEL_OP, lens = lensOf(tokens)) {
  const band = bandOf(tokens);
  const tiers = isLightSkin(tokens) ? APCA_TIERS.light : APCA_TIERS.dark;
  // 面板底色有两档：--panel（卡片）与 --panel-2（顶栏 / rail / 表头 / 输入框）。
  // panel-2 比 panel 暗一档，底图稀释之后的合成面跟着更暗 —— 顶栏那行状态字
  // （「已采集 28:36:15 · 61 个进程」）就是这么糊掉的：2026-09-15 像素审计实测
  // Lc 36，而卡片里同字号是 49。两档都要过判据，取更严的那个。
  const surfaces = [tokens.panel];
  if (/^#[0-9a-f]{6}$/i.test(tokens.panel2 || '')) surfaces.push(tokens.panel2);
  const ok = (op) => surfaces.every((surf) => {
    const eff = effectivePanel(
      surf === tokens.panel ? tokens : { ...tokens, panel: surf }, backdropLum, scrim, op, undefined, lens);
    const L = luminance(hexToRgb(eff));
    if (L < band[0] - 1e-9 || L > band[1] + 1e-9) return false;
    return tiers.every(([key, min]) => {
      const fg = tokens[key];
      if (!/^#[0-9a-f]{6}$/i.test(fg || '')) return true;
      return Math.abs(apcaLc(fg, eff)) >= min - 1e-9;
    });
  });
  if (ok(minOp)) return minOp;
  // 单调：不透明度越高，有效底色越接近纯面板色。二分够用。
  let lo = minOp;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  // 上取整到两位小数：滑块步长是 0.01，返回 0.9137 这种值滑块落不上去。
  return Math.min(1, Math.ceil(hi * 100) / 100);
}

// 贴膜模式的浓度地板：膜 = 图与面板色调和，装饰性天然比置底强一档，守护档位
// 也宽一档 —— 主文字（--text）守 APCA 80，次要文字（--text-2）守 60（深色方向
// 45），弱字阶不参与：贴膜模式下「图就是表面」，模式本身要的就是那层图案，
// 把它守到弱字阶达标就等于把膜推成不透明面板、模式失去存在意义
// （2026-09-13 用户壁纸实测）。等效合成模型与置底同构：mix(图灰, panel, 浓度)，
// 无纱、也不套明度带（膜本来就是与图同调的中调面）。
function wrapFloor(tokens, backdropLum, minOp = 0.4) {
  const light = isLightSkin(tokens);
  const tiers = light
    ? [['text', APCA_TIERS.light[0][1]], ['text2', APCA_TIERS.light[1][1]]]
    : [['text2', APCA_TIERS.dark[0][1]]];
  const ok = (op) => {
    // 贴膜模式没有面板级 backdrop-filter（膜就是表面，不存在「身后的背景」），
    // 所以显式把 lens 传成 null —— 不传的话会吃到 lensOf(tokens) 的默认透镜，
    // 模型比渲染乐观，判定就漂了。
    const eff = effectivePanel(tokens, backdropLum, 0, op, undefined, null);
    return tiers.every(([key, min]) => {
      const fg = tokens[key];
      if (!/^#[0-9a-f]{6}$/i.test(fg || '')) return true;
      return Math.abs(apcaLc(fg, eff)) >= min - 1e-9;
    });
  };
  if (ok(minOp)) return minOp;
  // 与 backdropFloor 同款单调二分 + 上取整到两位小数
  let lo = minOp;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return Math.min(1, Math.ceil(hi * 100) / 100);
}

// 可读性守卫：只在**没有透镜**的路径上工作（无底图 / 贴膜），返回 { autoDim, floor }。
//
// 置底模式 + 底图的路径上透镜已经退休了守卫：面板身后那块背景被 lensBand 反解
// 出来的带归一化，合成面的最坏值只由用户选的不透明度决定 —— 再去垫一层地板或
// 一层自动纱，就是替用户改他的选择，而「滑杆被系统拿走、拉到底也看不见底图」
// 正是 2026-09-15 用户连着两次报上来的同一个缺陷。
//
// 换句话说：带的两端由 lensBand 在**设计不透明度**（LENS_DESIGN_OP）上反解，
// 用户把滑杆拖到 0.30 时合成面确实低于那条线 —— 那是他自己要的透明度，不是
// 需要被补偿的缺陷。想更清楚就把滑杆拖回去，这句话现在由提示条说，不由地板说。
//
// scrim 是用户滑杆值（已方向化）；autoDim 叠在它之上（名字沿用历史：深色皮肤它
// 真的是「压暗」，浅色皮肤是「提亮」）。
function backdropGuard(tokens, backdropLum, scrim, panelOpacity, lens = lensOf(tokens)) {
  if (lens) return { autoDim: 0, floor: MIN_PANEL_OP };
  return {
    autoDim: 0,
    floor: backdropFloor(tokens, backdropLum, clamp(scrim, 0, 1), MIN_PANEL_OP, null),
  };
}

// ---------- 透明窗上的可读性：全局界面不透明度的漆层地板 ----------
//
// 上面那一整套（透镜 / 带 / 加固 / 守卫）管的都是「面板 vs 应用内底图」。它们对
// **面板 vs 桌面**这件事是主动放弃管辖的，三处都写明过：透镜只在「置底 + 有底图」
// 施加、无底图时 --paint-op 直接等于 --ui-opacity、地板 --panel-op-floor 只在有图
// 的分支里参与。于是全局界面不透明度是一条**完全没有守卫的旁路**：窗口本身
// transparent:true，滑杆拉低之后桌面和别的窗口直接顶到面板文字后面。
// 2026-09-15 用户截图实测：没设底图 + 滑杆拉低，壁纸与另一个终端窗口的正文清晰
// 地透在顶栏那行元信息与图表轴标签后面。
//
// 为什么此前三条验收链一条都没抓到：preview-v2 / _probe-glass 都在 Playwright 的
// 无头页面里渲染，页面背后是浏览器的合成底（白 / 透明），**不存在「桌面」这个图层**；
// 像素审计量的也是那张合成图。桌面亮度这个量在 webview 里根本采不到 —— 这既是
// 当初把它排除在守卫之外的现实原因，也是这里必须取「最坏桌面」的原因：
// 深色皮肤假设纯白桌面（亮字最难落脚），浅色皮肤假设纯黑，互为镜像。
//
// 判据是**相对保留**而不是绝对档位，这一条是本节的关键，也是唯一不会退化的形式：
// 深色皮肤的弱字阶在**不透明**面板上本来就只有 Lc 23–25（那是字阶层级的设计意图），
// 拿 APCA 的 30/45 这类绝对表去要求它，f=1（面板全不透明）时就已经不达标 ——
// 实测五套皮肤里 plain / amber / lowcontrast 三套「全达标最小不透明度 = null」，
// 也就是**连 1.0 都解不出来**。那正是 b0c3db2 修掉的那个缺陷的形状：判据无解 →
// 地板顶到 1 → 滑杆被系统拿走。相对保留没有这个问题：地板处的对比一定 ≥ ρ 倍的
// 不透明基线，而 ρ<1 让 f=1 恒过，所以扫描不可能退化。
const UI_PAINT_RETAIN = 0.75;
// 全局不透明度滑杆的下限（index.html 的 range min、applyUiOpacity 与 migrateState
// 的钳制共用这一个数）。地板的推导要用到它：漆层地板管的是「漆」，窗口底色与底图
// 仍然一路淡到这个下限 —— 桌面从缝隙、圆角外、底图后面透上来，那是滑杆的主要观感。
const UI_OPACITY_MIN = 0.5;

// 最坏桌面：桌面亮度在 webview 里采不到，只能取「对本皮肤方向最不利」的那一端。
function worstDesktop(tokens) {
  return isLightSkin(tokens) ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
}

// 文字实际压着的那个合成面。两种层结构（都按滑杆拖到下限、漆层落在 f 的最坏情形算）：
//   主窗（两层漆）：.frame 先铺 --bg × u，各表面再铺 --panel × f
//     ⟹ C = f·P + (1−f)·u·BG + (1−f)(1−u)·D，桌面权重 (1−f)(1−u)
//   小窗 / 能量球（单层漆，solo）：面板直接压在桌面上，body 是透明的
//     ⟹ C = f·P + (1−f)·D，桌面权重 (1−f)
// 同一个 f 在两种结构下漏进来的桌面差一倍，所以地板必须分别算 —— 拿主窗那份去铺
// 小窗，等于让小窗超出预算一倍。
//
// u 钉在下限而不是跟着当前滑杆值走：地板要是随 u 变，实测会**非单调** —— 漏光预算
// 那一版里 plain 的地板在 u=0.68 触底 0.676、再回升到 u=0.50 处的 0.790，也就是
// 「越往透明拖，面板越不透明」。那与「滑杆被系统拿走」是同一类缺陷。钉死在下限
// 换来的是一条平地板：单调（对 u 恒定）、且因 u ≥ 0.5 有 (1−u) ≤ 0.5，桌面权重
// 已经只有单层结构的一半。
function uiComposite(tokens, surfHex, f, solo) {
  const P = hexToRgb(surfHex);
  const D = worstDesktop(tokens);
  if (solo) return mix(P, D, 1 - f);
  const u = UI_OPACITY_MIN;
  const BG = hexToRgb(tokens.bg);
  const rest = 1 - f;
  return {
    r: f * P.r + rest * u * BG.r + rest * (1 - u) * D.r,
    g: f * P.g + rest * u * BG.g + rest * (1 - u) * D.g,
    b: f * P.b + rest * u * BG.b + rest * (1 - u) * D.b,
  };
}

// 参与判据的字色：实际会作为文字 / 图标色压在漆层上的那些（与 GLASS_HARDEN_KEYS
// 同一口径，另外把 --text 也算进来 —— 这里没有「带的正文契约」替它兜着）。
// --accent 仍然不在内：全仓库只作按钮底与 accent-color，从不作压在漆上的文字色。
const UI_PAINT_KEYS = ['text', 'text2', 'text3', 'up', 'down', 'ok', 'warn', 'error'];

// 漆层地板：桌面漏进来之后，每一档字色仍要保住它在**不透明面板**上那份对比的 ρ 倍。
// 两档面板底色（--panel 卡片 / --panel-2 顶栏·rail·表头）都要过，取更严的那个 ——
// 用户截图里最先糊的 `.top-meta`（顶栏那行「已采集 74:02:27 · 128 个进程」）与图表
// 轴标签正是坐在 panel-2 上，而 panel-2 比 panel 凹一档。
//
// 不加「中调护栏」那条判据：它是明度带（Mica tonal band）在**归一化底图**上的规则，
// 这条路上没有带，面板色就是皮肤的设计意图本身。更要紧的是它能在 f=1 处失败
// （中调面板的自定义皮肤），那就又把地板顶到 1 —— 而实测五套皮肤的护栏预算
// （λ 0.24–0.31）本来就比保留预算（0.075–0.11）宽一倍以上，加它对真实皮肤零影响、
// 只带来退化风险。
//
// 扫描而不二分：|Lc| 对混比不是单调的（前景若起步在底色的另一侧，跨过底色时 |Lc|
// 会先降到 0 再升），二分会收敛到错的一侧 —— 与 ensureApca 同一个坑、同一个对策。
function uiPaintFloor(tokens, solo = false) {
  const surfaces = [tokens.panel];
  if (/^#[0-9a-f]{6}$/i.test(tokens.panel2 || '')) surfaces.push(tokens.panel2);
  const targets = [];
  for (const surf of surfaces) {
    if (!/^#[0-9a-f]{6}$/i.test(surf || '')) continue;
    for (const k of UI_PAINT_KEYS) {
      const fg = tokens[k];
      if (!/^#[0-9a-f]{6}$/i.test(fg || '')) continue;
      // 基线 = 该字色在这块**不透明**面板上的实测对比，目标是它的 ρ 倍。
      targets.push([fg, surf, Math.abs(apcaLc(fg, surf)) * UI_PAINT_RETAIN]);
    }
  }
  if (!targets.length) return 1;
  const meets = (f) => targets.every(([fg, surf, min]) => (
    Math.abs(apcaLc(fg, rgbToHex(uiComposite(tokens, surf, f, solo)))) >= min - 1e-9
  ));
  // 从 1 往下扫 0.01 一格（与滑杆步长、CSS 两位小数同一格），取最后一个仍达标的 f。
  let f = 1;
  for (let i = 100; i >= 0; i--) {
    const cand = i / 100;
    if (!meets(cand)) break;
    f = cand;
  }
  return f;
}

// ---------- 内置壁纸 ----------

// 三张图此前躺在 ui/wallpapers/ 里没有任何代码引用（253 KB 死资源），
// 而「跟随背景图」皮肤却要求用户自己去找一张图 —— 开箱即用的那一步是缺的。
// 清单放在这里而不是写死在 HTML 里：取色、预览、选中态都要用到同一份数据。
const WALLPAPERS = [
  { src: 'wallpapers/wall-1.jpg', name: '深空' },
  { src: 'wallpapers/wall-2.jpg', name: '暮山' },
  { src: 'wallpapers/wall-3.jpg', name: '晨雾' },
];

// ---------- 背景图取色 → token 表 ----------

// 表面归一：窗口底 / 面板只继承源色相与相对明暗。彩度钳到 ≤0.02–0.03（Mica 式
// 的「有一点颜色但不抢」），明度钳进各自档位带 —— 主色原样当底色的时代，中灰
// 壁纸把整套 UI 拖闷、中等明度的高饱和壁纸让整窗刺眼，都是缺了这一步。
// 深浅两档的带是配套的：面板带恰好比底带高一档（深色 +0.05、浅色 +0.025），
// 无论主色落在哪里，bg → panel 都保持一个稳定的抬起量。
function normalizedSurface(rgb, lMin, lMax, maxC) {
  const o = rgbToOklab(rgb);
  const c = okChroma(rgb);
  const k = c > maxC ? maxC / c : 1;
  return oklabToRgb({
    L: Math.min(lMax, Math.max(lMin, o.L)),
    a: o.a * k,
    b: o.b * k,
  });
}

// 标准离线取色：背景图 → 色板 → 完整 17 键 token 表。
// mode：'auto' 按主色亮度分深浅；'dark' / 'light' 是用户在深浅偏好里钉死的方向。
function tokensFromImage(imgData, imgEl, mode = 'auto') {
  let palette = extractPalette(imgEl);
  if (!palette && imgData) {
    const avg = averageColor(imgData);
    palette = avg ? [avg] : [];
  }
  if (!palette.length) return { ...SKINS.plain.tokens };

  const weights = paletteWeights(imgData, palette);
  if (weights) palette.forEach((c, i) => { c.weight = weights[i]; });

  const { main, vivid, accent } = pickBase(palette);
  const dark = mode === 'light' ? false
    : mode === 'dark' ? true
    : luminance(main) < 0.5;

  // 浅色表面的彩度上限比深色更紧（0.02 / 0.012）：同样的彩度在亮表面被视觉放大
  // 成明显的「粉底/奶黄」，暗图钉浅色时整窗发闷（2026-09-15 暗红壁纸实测）。
  // Mica 浅色表面同样以中性为主、壁纸色相只留一丝。
  //
  // 浅色的明度带按出厂浅色皮肤反标定（bg #f2f3f5 ≈ Oklab L 0.965、panel #ffffff
  // = 1.0）：壁纸只贡献色相与一丝彩度，不参与决定「这块表面有多亮」——它是
  // 「浅色」皮肤，就该是浅色表面的亮度。旧带 [0.88, 0.94] / [0.905, 0.965] 把
  // 近黑壁纸派生成 #e4d3ce / #e7ddda（L 0.88 / 0.906），比出厂浅色暗一整档，
  // 再被半透面板一稀释就落到中调灰粉 —— 「发白发粉、没有高级感」的源头之一。
  // 深色侧的带不动。
  const bg = rgbToHex(normalizedSurface(main, dark ? 0.15 : 0.93, dark ? 0.30 : 0.96, dark ? 0.03 : 0.02));
  const panel = rgbToHex(normalizedSurface(main, dark ? 0.20 : 0.955, dark ? 0.36 : 0.985, dark ? 0.02 : 0.012));

  // 文字随色温：白/黑基底上掺一丝源色相（彩度 ≤0.012），暖壁纸配暖白、冷壁纸
  // 配冷白。原实现写死暖调（#f2e6dc），蓝壁纸配暖白字是色温打架。
  const o = rgbToOklab(main);
  const k = Math.min(1, 0.012 / Math.max(okChroma(main), 1e-4));
  const text = ensureContrast(rgbToHex(oklabToRgb({
    L: dark ? 0.93 : 0.22,
    a: o.a * k,
    b: o.b * k,
  })), panel);

  // 有彩色提交互强调与语义色；色板偏灰则交互退回中性反白。
  // accent / down / up 必须两两不同族（色相 ≥ 30°）：v2 的分工是「--accent 管交互、
  // --down/--up 只管数据」（tokens.css §分层原则），原来 accent 和 down 都吃
  // colorful[0]，壁纸取色皮肤下主按钮与下载图表同色，交互色和数据色混成一团。
  // 阶梯选取：accent 取评分最高彩色；down / up 依次取其后不与已选色撞族的彩色，
  // 不够再退回固定橙 / 钢蓝 / 紫；实在避不开（色板就两个同族彩色）用阶梯末位兜底。
  const accentHex = accent ? ensureContrast(rgbToHex(accent), panel) : text;
  const pool = vivid.slice(1).map(rgbToHex);
  const pickHue = (candidates, ...avoid) =>
    candidates.find((hex) => avoid.every((a) => hueDistance(hex, a) >= 30))
      ?? candidates[candidates.length - 1];
  const down = ensureContrast(pickHue([...pool, '#f0963f'], accentHex), panel);
  const up = ensureContrast(pickHue([...pool.slice(1), '#62a9e8', '#8b7fd4'], accentHex, down), panel);

  return validateSkin(expandTokens({
    bg,
    panel,
    text,
    down,
    up,
    ok: ensureContrast('#4cc38a', panel),
    warn: ensureContrast('#e5b567', panel),
    error: ensureContrast('#e57373', panel),
    accent: accentHex,
  }, { tightRamp: true }));
}

// 给外观屏的「强调色色板」用：与 tokensFromImage 同一条分析管线，吐出去重后的
// 候选色（hex + 占比）。展示序 = 占比序；同族近亲（色相差 <25° 且明度差 <0.12）
// 不重复占位，灰色只留一颗。
function extractImagePalette(imgData, imgEl) {
  let palette = extractPalette(imgEl);
  if (!palette && imgData) {
    const avg = averageColor(imgData);
    palette = avg ? [avg] : [];
  }
  if (!palette.length) return [];
  const weights = paletteWeights(imgData, palette);
  if (weights) palette.forEach((c, i) => { c.weight = weights[i]; });
  const out = [];
  for (const c of [...palette].sort((a, b) => b.weight - a.weight)) {
    const o = rgbToOklab(c);
    const chroma = okChroma(c);
    const gray = chroma < 0.02;
    const near = out.some((e) => {
      if (gray && e.gray) return true;
      const dh = Math.abs(okHue(o) - e.hue);
      const d = dh > 180 ? 360 - dh : dh;
      return d < 25 && Math.abs(o.L - e.L) < 0.12;
    });
    if (near) continue;
    out.push({ hex: rgbToHex(c), weight: c.weight, hue: okHue(o), L: o.L, gray });
    if (out.length >= 6) break;
  }
  return out.map(({ hex, weight }) => ({ hex, weight: Math.round(weight * 100) / 100 }));
}

// ---------- 应用令牌 ----------

// 上一次上报给后端的深浅。拖动「界面不透明度」这类滑杆会让 applyTokens 每帧跑一次，
// 每次都过一次 IPC 是白扔的 —— 同一个值只报一次。
let reportedNativeDark = null;

/**
 * 把有效深浅告诉后端，让托盘的原生弹出菜单跟着变（§37）。
 *
 * 托盘菜单是系统画的 HMENU，没有「上色」接口，能影响的只有进程级的
 * 「应用是深还是浅」这一个开关；皮肤配色（琥珀、玻璃、底图）进不去，这是那条路的天花板。
 *
 * 浏览器里直接开 index.html 时没有 __TAURI__（预览脚本也走这条路），静默跳过。
 * invoke 失败也不上报错：这是纯外观同步，失败的表现就是「菜单还是系统默认色」，
 * 比在控制台里制造一条谁都看不懂的错误好。
 */
function reportNativeMenuTheme(dark) {
  if (dark === reportedNativeDark) return;
  reportedNativeDark = dark;
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') return;
  try {
    const p = tauri.core.invoke('set_tray_theme', { dark });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* 后端没有这个命令（旧版本）：保持系统默认色 */ }
}

// 纯色系：17 键全量覆写到 documentElement。皮肤切换走这里。
function applyTokens(tokens, opts = {}) {
  const root = document.documentElement;
  const t = tokens;
  const set = (k, v) => root.style.setProperty(k, v);
  set('--bg', t.bg);
  set('--panel', t.panel);
  set('--panel-hi', t.panelHi);
  set('--panel-2', t.panel2);
  set('--line', t.line);
  set('--line-soft', t.lineSoft);
  set('--text', t.text);
  set('--text-2', t.text2);
  set('--text-3', t.text3);
  set('--down', t.down);
  set('--up', t.up);
  set('--ok', t.ok);
  set('--warn', t.warn);
  set('--error', t.error);
  set('--accent', t.accent);
  set('--accent-ink', t.accentInk);
  set('--sel-bar', t.selBar);
  // 透明窗上的漆层地板（uiPaintFloor）：与令牌同源、同一次上屏写入 —— 它只依赖
  // 这张表（字色 × 面板色 × 皮肤方向），不依赖滑杆位置，所以拖滑杆不必重算，
  // 换肤则必须重算。opts.solo 区分层结构：主窗两层漆、小窗/能量球一层漆
  // （mini.js 传 solo: true），同一个 f 在单层结构下漏进来的桌面是两倍。
  set('--ui-paint-floor', String(uiPaintFloor(t, !!opts.solo)));
  // colorScheme 跟着原生控件（滚动条、date input、勾选框）走
  const dark = luminance(hexToRgb(t.text)) > 0.5;
  root.style.colorScheme = dark ? 'dark' : 'light';
  // 托盘右键菜单是系统画的原生菜单，它只吃「应用是深是浅」这一个开关（§37）。
  // 有效深浅的判断就在这里，所以由这里告诉后端 —— 后端自己读系统设置是不对的：
  // 皮肤能把深浅方向钉死，跟系统设置无关。
  reportNativeMenuTheme(dark);
  // 换肤的 220ms 色彩过渡窗口：DOM 的颜色全部取自 CSS 变量，变量一改整站瞬变，
  // 而图表（ECharts 自己带 190ms 过渡）会滑过去 —— 一半滑一半跳，割裂感就在这。
  // 首次上屏不开窗口：启动时从 tokens.css 默认值到用户皮肤的那次变化必须瞬切，
  // 不然开机是一闪。之后每次挂 .theme-anim 让颜色类属性走 220ms 过渡、260ms 摘掉
  // —— 每秒一帧的数据更新不在窗口里，不会被过渡拖住。
  if (tokensPaintedOnce && !reduceMotion()) {
    root.classList.add('theme-anim');
    clearTimeout(themeAnimTimer);
    themeAnimTimer = setTimeout(() => root.classList.remove('theme-anim'), 260);
  }
  tokensPaintedOnce = true;
  if (!opts.silent) {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { tokens: t } }));
  }
}

let tokensPaintedOnce = false;
let themeAnimTimer = null;
function reduceMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// 全局界面不透明度：挂在根上的一个变量，主窗（.frame 底色 + .backdrop + 各表面
// 漆层 --paint-op）、小窗（.panel 底色）与能量球（球漆 / 光照层）都从它取。
// 只淡「漆」不淡字——文字、边线、图标不参与淡出，滑杆拉到 50% 文字仍然清晰，
// 桌面从漆层底下透上来。50% 是滑杆下限（与 migrateState 的钳制一致）；
// 有背景图时面板漆层还受 --panel-op-floor（按底图亮度算出的可读下限）二次托底。
function applyUiOpacity(v) {
  const n = Number(v);
  // 非法输入（NaN / 空串）回落「不透明」：坏值不该让界面凭空变半透
  document.documentElement.style.setProperty('--ui-opacity',
    String(Number.isFinite(n) ? clamp(n, 0.5, 1) : 1));
}

// 纱的色调：从底色（壁纸主色 / 其归一色）派生一层「有颜色的纱」——
// Mica 质感的一半来自 tint 而不是灰黑/惨白。只动亮度不换色相：
// 深色皮肤（缺省）压亮度，钳到 ≤0.1 —— 这样「底图 × 黑纱」的近似合成
// （effectivePanel / backdropFloor）仍然保守：tint 比纯黑亮出来的那点量，
// 被纱里更深的顶栏渐变盖回去。
// 浅色皮肤（light=true）抬亮度，钳到 ≥0.9 —— 亮纱把底图的暗区托起来给暗字
// 落脚，同一条「有颜色的 tint」逻辑镜像到浅色侧；守卫的 veilOf 拿同一个色当
// 模型目标，与 CSS 两层纱的合成方向一致。
function scrimTint(bgHex, light = false) {
  if (!/^#[0-9a-f]{6}$/i.test(String(bgHex || ''))) return light ? '#f4f5f7' : '#0b0c0e';
  let c = hexToRgb(bgHex);
  if (light) {
    for (let i = 0; i < 8 && luminance(c) < 0.9; i++) {
      c = mixOk(c, { r: 255, g: 255, b: 255 }, 0.5);
    }
    // Mica 浅色纱是「一丝色相的中性亮」，不是粉白：提亮保留了源色相的彩度，
    // 暗红壁纸的纱提亮后是一层明显的粉纱、缝隙里的图跟着泛粉（2026-09-15 实测）。
    // 提亮后把 OKLab 彩度压到 ≤0.012 —— 色温还在，粉感消失。
    const o = rgbToOklab(c);
    const kc = Math.min(1, 0.012 / Math.max(okChroma(c), 1e-4));
    c = oklabToRgb({ L: o.L, a: o.a * kc, b: o.b * kc });
  } else {
    for (let i = 0; i < 8 && luminance(c) > 0.1; i++) {
      c = mixOk(c, { r: 0, g: 0, b: 0 }, 0.5);
    }
  }
  return rgbToHex(c);
}

// 背景图模式四件套 + 纱色：面板不透明度 / 背景模糊 / 纱浓度 / 背景图 url / tint。
// 纱的方向由 lightSkin 决定：深色皮肤铺黑纱（压暗），浅色皮肤铺亮纱（提亮）——
// tint 与顶栏渐变、自动补偿层的颜色全部跟着翻。仅「跟随背景图」皮肤会传背景；
// 其余皮肤调用时 background 为空，全部归位。

let lastBackdropUrl = null;
let fadingTo = null; // 正在淡入的目标 url；非空期间重复铺装不得抢根变量
let fadeSeq = 0;

function applyBackdrop({ background, panelOpacity, bgBlur, scrim, tint, autoDim, style, wrapOpacity, brightness, lightSkin, lens, tokens }) {
  const root = document.documentElement;
  const hasBg = !!background;
  const wrap = hasBg && style === 'wrap';
  root.style.setProperty('--panel-op', hasBg && !wrap ? String(clamp(panelOpacity ?? 1, MIN_PANEL_OP, 1)) : '1');
  root.style.setProperty('--bg-blur', hasBg && !wrap ? `${Math.round(clamp(bgBlur ?? 0, 0, 60))}px` : '0px');
  root.style.setProperty('--bg-brightness', hasBg ? String(clamp(brightness ?? 1, 0.5, 1.5)) : '1');
  root.style.setProperty('--backdrop-dim', hasBg && !wrap ? String(effectiveScrim(scrim, lightSkin)) : '0');
  root.style.setProperty('--backdrop-auto', hasBg && !wrap ? String(clamp(autoDim ?? 0, 0, 0.6)) : '0');
  root.style.setProperty('--wrap-op', wrap ? String(clamp(wrapOpacity ?? 0.45, 0.4, 1)) : '0.62');
  root.style.setProperty('--backdrop-tint', scrimTint(hasBg ? tint : '', !!lightSkin));
  // 顶栏渐变与自动补偿层的纯色方向（CSS 里 rgb(var(--backdrop-veil) / a)）：
  // tint 是低彩度版，这两层用同方向的全饱和纯色。无图/贴膜时回到黑（缺省；
  // 无图时该层整个不渲染，贴膜的亮度补偿有自己的白/黑层）。
  root.style.setProperty('--backdrop-veil', hasBg && !wrap && lightSkin ? '255 255 255' : '0 0 0');
  // 面板级背景归一化（styles.css 的 backdrop-filter 里那一串 contrast/brightness/
  // saturate）。带的两端由 lensBand 反解、CSS 只消费同一组数，改一处两边一起变。
  // 无图 / 贴膜时回到中性（贴膜的面板不走 backdrop-filter，这条只是兜底，免得变量
  // 悬空）。lens 由调用方按当前底图自己的直方图算出（自适应 auto-levels，见
  // lensFromImage）；传空就回落 lensOf(tokens) —— 图还没解码完 / 图太平 / 参数退化
  // 时走这一支，带的两端同源，只是少一层按图拉张。
  const fallbackLens = tokens ? lensOf(tokens) : null;
  const useLens = lens || fallbackLens;
  root.style.setProperty('--lens-filter', hasBg && !wrap && useLens
    ? lensFilter(useLens) : 'saturate(1.5)');
  document.body.classList.toggle('wrap-mode', wrap);
  document.body.classList.toggle('has-bg', hasBg);
  // 方向类：卡片浮起阴影按皮肤方向分档（浅色亮玻璃柔影 / 深色重影）。
  // 只在置底模式点亮——贴膜模式的面板自己贴图，不浮在图上。
  document.body.classList.toggle('light-skin', hasBg && !wrap && !!lightSkin);

  // 换壁纸走交叉淡入：旧图留在根变量上，新图挂到临时同款 .backdrop 层上淡入
  // （styles.css .is-fade-in），完成后切根变量、移除临时层。只有「图 → 另一张图」
  // 才淡入——首次设置淡入会闪一块空底，撤图淡出会闪一下黑，都直切。
  // 淡入已在飞且目标没变（换肤重应用 / 拖滑杆触发的重铺）：直接退出。
  // 不挡的话第二次调用会把根变量提前切到新图，交叉淡入瞬间变成硬切。
  if (hasBg && fadingTo === background) return;

  const prev = lastBackdropUrl;
  lastBackdropUrl = background || null;
  const setUrl = () => root.style.setProperty('--theme-bg-image', hasBg ? `url("${background}")` : 'none');
  if (reduceMotion() || !hasBg || !prev || prev === background) {
    fadeSeq++; // 作废在飞的淡入：其回调只清理临时层，不再切根变量
    fadingTo = null;
    setUrl();
    return;
  }
  fadingTo = background;
  const seq = ++fadeSeq;
  const base = document.querySelector('.backdrop');
  if (!base || typeof base.after !== 'function') {
    fadingTo = null;
    setUrl();
    return;
  }
  const temp = document.createElement('div');
  temp.className = 'backdrop is-fade-in';
  temp.style.setProperty('--theme-bg-image', `url("${background}")`);
  base.after(temp);
  void temp.offsetWidth; // 先强制一帧布局，transition 才会真的从 opacity:0 起跑
  temp.classList.add('is-visible');
  setTimeout(() => {
    temp.remove();
    if (seq !== fadeSeq) return; // 已有更新的换图在跑，根变量由那次负责切
    fadingTo = null;
    setUrl();
  }, 360);
}

// ---------- 皮肤解析 ----------

// state + 皮肤 id → { tokens, background, panelOpacity, bgBlur, scrim }。
// 皮肤 id：内置 'plain' | 'light' | 'amber'；'image'（跟随背景图）；其余视为 themes 里的自定义皮肤名。
// 小窗等只想要颜色的调用方，忽略返回值里的 background 即可（mini 不做 backdrop）。
// 系统深浅偏好。vm 沙箱与老 WebView 没有 matchMedia 时按深色处理（= 不切换）。
function systemPrefersDark() {
  return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
}

// 跟随系统只作用于两张中性基底：plain / light 存的是「深色还是浅色」的意图，
// 开启 followSystem 后由系统深浅决定实际解析到哪张。琥珀、跟随背景图、自定义
// 与另存皮肤是用户的显式审美选择，不参与自动切换。
function effectiveBuiltin(state, skinId) {
  if (skinId !== 'plain' && skinId !== 'light') return skinId;
  if (!state || state.followSystem !== true) return skinId;
  return systemPrefersDark() ? 'plain' : 'light';
}

function resolveSkin(state, id) {
  const skinId = id || (state && state.skin) || 'plain';
  if (SKINS[skinId]) {
    const eff = effectiveBuiltin(state, skinId);
    return { tokens: { ...SKINS[eff].tokens }, background: '', panelOpacity: 1, bgBlur: 0, scrim: 0 };
  }
  if (skinId === 'image') {
    const draft = state && state.imageDraft;
    return {
      tokens: draft && draft.tokens ? { ...draft.tokens } : { ...SKINS.plain.tokens },
      background: (state && state.backgroundImage) || '',
      panelOpacity: clamp((state && state.panelOpacity) ?? 0.45, MIN_PANEL_OP, 1),
      bgBlur: clamp((state && state.bgBlur) ?? 0, 0, 60),
      bgBrightness: clamp((state && state.bgBrightness) ?? 1, 0.5, 1.5),
      scrim: clamp((state && state.scrim) ?? 0.30, 0.2, 0.6),
      backdropStyle: (state && state.backdropStyle) === 'wrap' ? 'wrap' : 'underlay',
      wrapOpacity: clamp((state && state.wrapOpacity) ?? 0.45, 0.4, 0.9),
    };
  }
  // 编辑器草稿本身就是一种皮肤。原来它只存在 state.custom 里、由 UI 直接调 applyTokens
  // 上屏，resolveSkin 完全不认 —— 于是改完的颜色重启就没了（磁盘上存着，没人读回来），
  // 而小窗启动走的正是 resolveSkin，显示的是基底皮肤，和主界面不一致。
  // 让草稿从这里解析出来，重启与小窗两条路都自动跟上，命名另存也回到它该有的意思：
  // 把草稿提升成一个可留存的预设，而不是「不想丢就只能存」。
  // 这里不套 validateSkin：那会把用户挑的 #ff0000 静默改成 #ff4b4b，于是「预览到的」
  // 和「存下来的」不是一个东西 —— 人挑了色、看到的是另一个色，还不知道为什么。
  // 可读性问题改由 auditSkin 报出来、UI 在对应色块上提示，选择权留给用户。
  if (skinId === 'custom') {
    const tokens = composeDraft(state && state.custom);
    return {
      tokens: tokens || { ...SKINS.plain.tokens },
      background: '', panelOpacity: 1, bgBlur: 0, scrim: 0,
    };
  }
  const th = state && state.themes && state.themes[skinId];
  if (th && th.tokens) {
    return { tokens: { ...th.tokens }, background: '', panelOpacity: 1, bgBlur: 0, scrim: 0 };
  }
  return { tokens: { ...SKINS.plain.tokens }, background: '', panelOpacity: 1, bgBlur: 0, scrim: 0 };
}

// ---------- 配置持久化 ----------

function configStorage() {
  const hasTauri = !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  return {
    hasTauri,
    async load() {
      if (!hasTauri) {
        try { return JSON.parse(localStorage.getItem('netpeek-theme') || 'null'); } catch { return null; }
      }
      const raw = await window.__TAURI__.core.invoke('load_theme_config');
      try { return raw ? JSON.parse(raw) : null; } catch (e) {
        // 配置文件损坏（Rust 侧已备份为 theme-config.json.corrupt-<ts> 并回退空串）。
        // 这里必须出声：静默回退 = 用户自改的皮肤「凭空消失」还没任何提示。
        console.warn('[NetPeek] 主题配置损坏，已回退默认值（原文件已备份，可手动找回）：', e);
        return null;
      }
    },
    async save(cfg) {
      if (!hasTauri) {
        localStorage.setItem('netpeek-theme', JSON.stringify(cfg));
        return;
      }
      await window.__TAURI__.core.invoke('save_theme_config', { json: JSON.stringify(cfg) });
    },
    async saveBackground(dataUrl) {
      if (!hasTauri) return dataUrl; // 浏览器调试：直接用 data URL
      return window.__TAURI__.core.invoke('save_background_image', { dataUrl });
    },
    async readBackground(path) {
      if (!hasTauri || !path) return path || '';
      return window.__TAURI__.core.invoke('read_background_image', { path });
    },
  };
}

// ---------- AI 取色（跟随背景图皮肤的高级项）：OpenAI 兼容多模态接口 ----------

// 提示词直接要新 9 个核心键（进 expandTokens 派生完整 17 键），不再要旧 10 键
// 再迁移：模型按「表面色低彩度、文字对 panel ≥4.5:1、三个彩色互不同族」这些
// 本地取色同款约束出牌，产出与标准管线同构。旧格式（border/muted）仍接受 ——
// 老配置过的自定义端点可能还吐旧键，归一链路留着。
async function aiGenerate(provider, imgDataUrl) {
  // 校验提供方配置与授权（授权在 UI 层把关）
  if (!provider || !provider.endpoint || !provider.apiKey || !provider.model) {
    throw new Error('未配置 AI 提供方（endpoint / API key / model）');
  }
  const url = provider.endpoint.replace(/\/$/, '');
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '根据这张壁纸生成一套 UI 主题令牌，输出 JSON（不要代码块）：'
            + '{"bg":"#hex","panel":"#hex","text":"#hex","down":"#hex","up":"#hex","ok":"#hex","warn":"#hex","error":"#hex","accent":"#hex","panelOpacity":0.9,"blur":12}。'
            + '要求：bg 与 panel 是低彩度表面色，深浅方向必须与壁纸整体明暗一致（暗壁纸输出深色表面、亮壁纸输出浅色表面，不要把暗壁纸抬成浅色），panel 比 bg 明度高约一档；'
            + 'text 相对 panel 的对比度 ≥4.5:1，色温与壁纸一致；'
            + 'accent 是交互强调色，down/up 分别是下载/上传数据色，ok/warn/error 是语义色 —— 三组颜色色相彼此错开至少 30°；'
            + 'panelOpacity 取 0.3–1（面板身后那块背景由内置透镜局部归一化，压低也读得清），blur 取 0–60。' },
          { type: 'image_url', image_url: { url: imgDataUrl } },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`AI 请求失败 HTTP ${res.status}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 未返回 JSON');
  const parsed = JSON.parse(m[0]);
  const CORE = ['bg', 'panel', 'text', 'down', 'up', 'ok', 'warn', 'error', 'accent'];
  const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || '');
  if (CORE.every((k) => isHex(parsed[k]))) {
    // 新格式：9 核心键直接进派生管线
    return {
      tokens: Object.fromEntries(CORE.map((k) => [k, parsed[k]])),
      panelOpacity: typeof parsed.panelOpacity === 'number' ? parsed.panelOpacity : 0.9,
      blur: typeof parsed.blur === 'number' ? parsed.blur : 12,
    };
  }
  // 旧格式（10 键带 border/muted）：保持兼容，归一交给调用方
  const LEGACY = ['bg', 'panel', 'border', 'text', 'muted', 'down', 'up', 'ok', 'warn', 'error'];
  for (const k of LEGACY) {
    if (!isHex(parsed[k])) throw new Error(`AI 返回缺少或非法颜色 ${k}`);
  }
  return {
    tokens: Object.fromEntries(LEGACY.map((k) => [k, parsed[k]])),
    panelOpacity: typeof parsed.panelOpacity === 'number' ? parsed.panelOpacity : 0.9,
    blur: typeof parsed.blur === 'number' ? parsed.blur : 12,
  };
}

// ---------- 状态：默认值与旧配置迁移 ----------

function defaultState() {
  return {
    skin: 'plain',        // 内置 id | 'image' | themes 里的自定义皮肤名
    backgroundImage: '',  // 仅 image 皮肤使用（已落盘路径）
    panelOpacity: 0.45,   // image 皮肤：面板不透明度（滑杆 0.30–1）。透镜把面板身后
                          // 那块背景归一成柔色之后，0.45 就已经「底图看得见 + 字读得清」
    bgBlur: 0,            // image 皮肤：背景模糊半径 px
    bgBrightness: 1,      // image 皮肤：背景亮度 0.5–1.5，暗图提亮 / 亮图压暗
    scrim: 0.30,          // image 皮肤：背景压暗
    backdropStyle: 'underlay',
                          // image 皮肤显示方式：underlay = 壁纸垫底、面板悬浮（默认）；
                          // wrap = 贴膜——壁纸按窗口坐标对齐,每块面板表面"剪"下
                          // 落在自己身上的那块图,缝隙与窗口底是不可贴区、露素底
    wrapOpacity: 0.62,    // 贴膜浓度：面板底色与壁纸的调和比,越高越偏面板色
    imageMode: 'auto',    // image 皮肤：深浅偏好 auto | dark | light
    imageDraft: null,     // image 皮肤的 token 表草稿 { tokens, source, palette? }
    custom: null,         // 自定义编辑器草稿 { core, overrides }（core 9 键，派生键可钉住）
    themes: {},           // 已另存的自定义皮肤 { name: { name, tokens } }
    followSystem: false,  // 开启后，朴素 / 浅色皮肤跟随系统深浅自动切换（resolveSkin 出口映射）
    uiOpacity: 1,         // 全局界面不透明度 0.5–1：底色/底图/能量球变透，文字不淡
    ai: { provider: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' }, consented: false },
  };
}

// 就地迁移/补全，保证 state 满足新格式。
function migrateState(state) {
  // 旧版三模式（mode: standard | ai | custom）→ 新皮肤归属
  if (typeof state.mode === 'string') {
    const std = state.standard || {};
    state.panelOpacity = clamp(std.panelOpacity ?? 0.45, MIN_PANEL_OP, 1);
    state.bgBlur = clamp(std.blur ?? 0, 0, 60);
    state.scrim = clamp(std.scrim ?? 0.30, 0.2, 0.6);
    state.backgroundImage = state.pendingBackground || '';

    // 旧 themes → 新 themes：default 是出厂皮肤（= plain），即席取色结果不值得留
    const themes = {};
    for (const [name, th] of Object.entries(state.themes || {})) {
      if (name === 'default' || !th || !th.tokens) continue;
      const tokens = convertLegacyTokens(th.tokens);
      if (tokens) themes[name] = { name, tokens };
    }
    state.themes = themes;

    if (state.backgroundImage) {
      // 有背景图的用户迁到「跟随背景图」：取色草稿留空（进外观屏后自动补），
      // 面板先以 plain 中性基底浮在旧图上 —— 视觉连续，且 v2 本来就是半透面板。
      state.skin = 'image';
      state.imageDraft = null;
    } else if (state.mode === 'custom' && state.active && themes[state.active]) {
      state.skin = state.active; // 用户另存过的自定义皮肤，原样保留
    } else {
      state.skin = 'plain';
    }

    delete state.mode;
    delete state.active;
    delete state.standard;
    delete state.pendingBackground;
    delete state.aiApplied;
  }

  // 上一代 v2 配置（已提交的 HEAD 时代）：唯一事实源是 state.current，没有 skin 字段。
  // 不迁移的话，老用户升级后 state.skin 为 undefined、一路回落到 plain —— 挑好的颜色
  // 无声丢失，和 followSystem 丢失是同一场重写造出来的两处回归。
  if (!state.skin && state.current && typeof state.current === 'object') {
    const cur = state.current;
    const sameTokens = (a, b) => Object.keys(b).every(
      (k) => String(a[k] || '').toLowerCase() === String(b[k]).toLowerCase(),
    );
    if (cur.background) {
      state.skin = 'image';
      state.backgroundImage = cur.background;
      state.imageDraft = cur.tokens ? { tokens: { ...cur.tokens }, source: cur.source || 'standard' } : null;
      state.panelOpacity = clamp(cur.panelOpacity ?? 0.45, MIN_PANEL_OP, 1);
      state.bgBlur = clamp(cur.blur ?? 0, 0, 60);
      state.scrim = clamp(cur.scrim ?? 0.30, 0.2, 0.6);
    } else if (cur.tokens) {
      const builtin = Object.entries(SKINS).find(([, s]) => sameTokens(cur.tokens, s.tokens));
      if (builtin) {
        state.skin = builtin[0];
      } else {
        state.custom = draftFromTokens(cur.tokens);
        state.skin = 'custom';
      }
    }
    delete state.current;
    delete state.advanced;       // 高级折叠是旧外观屏的结构，新屏不设折叠
    delete state.bgHintDismissed; // 无背景广告牌已废除，提示不存在了
  }

  // 'custom' 也是合法皮肤（编辑器草稿）。不放进白名单的话，用户改完色重启
  // 就会被这里判成非法皮肤、退回 plain —— 那正是原来「改完重启就没了」的最后一道关。
  if (!SKINS[state.skin] && state.skin !== 'image' && state.skin !== 'custom'
      && !(state.themes && state.themes[state.skin])) {
    state.skin = 'plain';
  }
  if (typeof state.followSystem !== 'boolean') state.followSystem = false;
  // 「跟随桌面壁纸」功能已移除：老配置里可能残留这两个字段,清掉保持配置干净
  delete state.followDesktop;
  delete state.desktopSource;
  // 界面不透明度：50% 是滑杆下限。文字不参与淡出，这个下限是「最淡一档」
  // 而不是可读线。缺失/非数字一律回落「不透明」——损坏的配置不该让界面凭空变半透。
  state.uiOpacity = (state.uiOpacity == null || !Number.isFinite(Number(state.uiOpacity)))
    ? 1
    : clamp(Number(state.uiOpacity), 0.5, 1);
  if (!state.themes || typeof state.themes !== 'object') state.themes = {};
  for (const th of Object.values(state.themes)) {
    if (!th || typeof th !== 'object' || !th.tokens) continue;
    const fixed = convertLegacyTokens(th.tokens);
    if (fixed) th.tokens = fixed;
  }

  if (state.skin === 'image') {
    // 一次性归位：透镜（LENS）上线前，面板不透明度被「可读性地板」逼在 0.7–1.0 的
    // 近实心区间（地板最高算到 0.97，用户把滑杆拉到底也就是 0.93）——那个区间只剩
    // 「底图看不见」一个作用，而用户的意图恰恰相反。所以把这一档历史值一次性落回
    // 0.45：透镜接手后 0.45 就是「底图看得见 + 文字达标」。
    // opRev 保证只做一次：之后用户自己调到 0.8 不会再被改回去。
    if ((state.opRev ?? 0) < 1) {
      if (Number(state.panelOpacity) >= 0.55) state.panelOpacity = 0.45;
      state.opRev = 1;
    }
    state.panelOpacity = clamp(state.panelOpacity ?? 0.45, MIN_PANEL_OP, 1);
    state.bgBlur = clamp(state.bgBlur ?? 0, 0, 60);
    // 亮度：非法/缺省回落 1（不调）；区间 0.5–1.5
    state.bgBrightness = clamp(Number(state.bgBrightness) || 1, 0.5, 1.5);
    state.scrim = clamp(state.scrim ?? 0.30, 0.2, 0.6);
    // 显示方式：非法值回落置底；贴膜浓度钳在滑杆区间
    if (state.backdropStyle !== 'wrap') state.backdropStyle = 'underlay';
    state.wrapOpacity = clamp(Number(state.wrapOpacity) || 0.62, 0.4, 0.9);
    // 深浅偏好：非法值回落自动（按主色亮度分边）
    if (state.imageMode !== 'dark' && state.imageMode !== 'light') state.imageMode = 'auto';
    if (state.imageDraft && state.imageDraft.tokens) {
      const fixed = convertLegacyTokens(state.imageDraft.tokens);
      // 色板（强调色点选的候选清单）是可选附件，迁移时原样保留
      const pal = Array.isArray(state.imageDraft.palette)
        ? state.imageDraft.palette.filter((c) => c && /^#[0-9a-f]{6}$/i.test(c.hex || ''))
        : undefined;
      state.imageDraft = fixed
        ? {
          tokens: state.imageDraft.rev === DERIVE_REV ? fixed : refreshDerivedTokens(fixed),
          source: state.imageDraft.source || 'standard',
          rev: DERIVE_REV,
          ...(pal ? { palette: pal } : {}),
        }
        : null;
    } else {
      state.imageDraft = null;
    }
  } else {
    state.backgroundImage = '';
    state.imageDraft = null;
  }

  // 草稿归一到 { core, overrides }。老草稿是一张 17 键表（甚至是 v1 的 10 键），
  // 先补全再拆分层 —— draftFromTokens 会把与派生值不同的键记成 override，
  // 所以迁移过来的皮肤外观分毫不变。
  if (state.custom && typeof state.custom === 'object') {
    if (state.custom.core && state.custom.core.bg) {
      state.custom = { core: { ...state.custom.core }, overrides: { ...(state.custom.overrides || {}) } };
    } else if (state.custom.tokens) {
      const fixed = convertLegacyTokens(state.custom.tokens);
      state.custom = fixed ? draftFromTokens(fixed) : null;
    } else {
      state.custom = null;
    }
  } else {
    state.custom = null;
  }
  // 皮肤指向草稿、草稿却没了（配置被手改过）：退回出厂皮肤，别让界面拿一张空表去渲染
  if (state.skin === 'custom' && !state.custom) {
    state.skin = 'plain';
  }

  if (!state.ai) state.ai = { provider: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' }, consented: false };
  if (!state.ai.provider) state.ai.provider = { endpoint: '', apiKey: '', model: 'gpt-4o-mini' };
  return state;
}

// 初始化：加载配置、迁移、返回运行时状态。
async function initTheme() {
  const storage = configStorage();
  const raw = await storage.load();
  const cfg = raw && typeof raw === 'object' ? raw : null;
  const fresh = !cfg;
  const state = migrateState(cfg || defaultState());
  return { state, storage, fresh };
}

// 汇出供 UI 与小窗使用
window.NetPeekTheme = {
  THEME_EVENT,
  SKINS,
  hexToRgb,
  rgbToHex,
  mix,
  mixOk,
  rgbToOklab,
  oklabToRgb,
  okChroma,
  okHue,
  paletteWeights,
  luminance,
  lumToChannel,
  contrast,
  apcaLc,
  APCA_TIERS,
  bandOf,
  DERIVE_REV,
  refreshDerivedTokens,
  ensureContrast,
  clamp,
  pickBase,
  tokensFromImage,
  extractImagePalette,
  coreOf,
  expandTokens,
  convertLegacyTokens,
  validateSkin,
  guardTokens,
  deriveTokens,
  effectivePanel,
  lensOf,
  lensApply,
  lensFilter,
  lensParams,
  lensBand,
  lensFromImage,
  LENS_DESIGN_OP,
  LENS_BODY_LC,
  GLASS_MID_MAX_DARK,
  GLASS_MID_MIN_LIGHT,
  GLASS_HARDEN_LC,
  GLASS_HARDEN_WEAK_LC,
  GLASS_HARDEN_KEYS,
  glassContract,
  glassComposite,
  glassWorstComposite,
  glassHardenTokens,
  ensureApca,
  worstSurface,
  chromaComp,
  MIN_IMG_RANGE,
  MIN_PANEL_OP,
  backdropFloor,
  backdropGuard,
  wrapFloor,
  UI_PAINT_RETAIN,
  UI_OPACITY_MIN,
  UI_PAINT_KEYS,
  worstDesktop,
  uiComposite,
  uiPaintFloor,
  scrimTint,
  isLightSkin,
  veilOf,
  effectiveScrim,
  migrateState,
  composeDraft,
  draftFromTokens,
  setDraftKey,
  CORE_KEYS,
  DERIVED_KEYS,
  WALLPAPERS,
  applyTokens,
  applyBackdrop,
  resolveSkin,
  systemPrefersDark,
  applyUiOpacity,
  aiGenerate,
  configStorage,
  initTheme,
};
