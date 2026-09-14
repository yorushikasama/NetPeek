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
function expandTokens(core) {
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
    panel2: rgbToHex(mixOk(bgRgb, { r: 0, g: 0, b: 0 }, dark ? 0.15 : 0.05)),
    line: rgbToHex(mixOk(panelRgb, textRgb, dark ? 0.09 : 0.17)),
    lineSoft: rgbToHex(mixOk(panelRgb, textRgb, dark ? 0.03 : 0.09)),
    text: core.text,
    text2: rgbToHex(mixOk(textRgb, bgRgb, dark ? 0.35 : 0.38)),
    text3: rgbToHex(mixOk(textRgb, bgRgb, dark ? 0.62 : 0.60)),
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

// 面板叠在背景图上之后，文字实际踩着的那个颜色。
// 层序（styles.css）：底图 → 压暗纱 → 半透面板。压暗在面板之下，所以先压再叠。
// 全局界面不透明度（--ui-opacity）不参与这里：floor 只管「面板滑杆 vs 底图」的
// 可读关系，全局淡出作用于所有漆层（含底图），是用户的显式选择，不该被 floor 钳住。
function effectivePanel(tokens, backdropLum, scrim, opacity) {
  const v = lumToChannel(backdropLum);
  const dimmed = mix({ r: v, g: v, b: v }, { r: 0, g: 0, b: 0 }, clamp(scrim, 0, 1));
  return rgbToHex(mix(dimmed, hexToRgb(tokens.panel), clamp(opacity, 0, 1)));
}

// 给定底图亮度与压暗强度，求「能让次要文字与最坏亮区仍达标」的面板不透明度下限。
// 只保 text2@4.5 —— text3 不再参与：3:1 左右的弱对比是它的设计意图，让最弱的
// 字阶握着最强的一票否决，实测会把任意真实照片的下限顶到 0.94+（2026-09-13
// 用户实测：暗壁纸 floor 0.96，三个材质滑杆全部失去可感效果）。弱字阶的可读性
// 由两道既有机制间接保障：派生托底（expandTokens 相对面板 ≥2.9）与自动压暗。
// minOp 是搜索起点也是返回下界：守卫管线（backdropGuard）放宽滑杆后传 0.70 进来。
function backdropFloor(tokens, backdropLum, scrim, minOp = 0.82) {
  const fg = tokens.text2 || tokens.text;
  const ok = (op) => {
    if (!/^#[0-9a-f]{6}$/i.test(fg || '')) return true;
    return contrast(hexToRgb(fg), hexToRgb(effectivePanel(tokens, backdropLum, scrim, op))) >= MIN_CONTRAST;
  };
  if (ok(minOp)) return minOp;
  // 单调：不透明度越高，有效底色越接近纯面板色，对比度只增不减。二分够用。
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
// 也宽一档 —— 主文字（--text）仍保 4.5，次要文字（--text-2）保 3.2（介于正文与
// 弱字阶之间），弱字阶不参与（与置底同一条豁免）。若按置底的 4.5 管到 text2，
// 亮图上地板会顶到 1、膜退化成不透明面板，模式失去存在意义（2026-09-13
// 用户壁纸实测）。等效合成模型与置底同构：mix(图灰, panel, 浓度)，无黑纱。
function wrapFloor(tokens, backdropLum, minOp = 0.4) {
  const fgs = [
    [tokens.text || tokens.text2, MIN_CONTRAST],
    [tokens.text2, 3.2],
  ];
  const ok = (op) => fgs.every(([fg, min]) => {
    if (!/^#[0-9a-f]{6}$/i.test(fg || '')) return true;
    return contrast(hexToRgb(fg), hexToRgb(effectivePanel(tokens, backdropLum, 0, op))) >= min;
  });
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

// 可读性守卫（一体版）：面板不透明度滑杆放开到 0.70 之后，亮图不再靠「把滑杆
// 钳到地板」保可读，而是先补「自动压暗」——一层纯黑纱垫在 tint 纱之下、底图
// 之上，把最坏亮区压下去，让用户选的不透明度原地达标。压到 0.6 顶还不够读
// （接近纯白的图 + 很低的不透明度）才退回硬钳：给出抬高的 floor。
// 方向性：黑纱只会把有效面板压暗，因此只对「亮字压暗底」的深色皮肤生效；
// 浅色皮肤（暗字压亮底）黑纱帮倒忙，保持硬钳路径（floor 按用户压暗原样算）。
// 返回 { autoDim, floor }；scrim 参数是用户滑杆值，autoDim 叠在它之上。
function backdropGuard(tokens, backdropLum, scrim, panelOpacity) {
  const userScrim = clamp(scrim, 0, 1);
  const total = (dim) => Math.min(1, userScrim + dim);
  const okAt = (op, dim) => backdropFloor(tokens, backdropLum, total(dim), 0.70) <= op + 1e-9;
  const text2Lum = luminance(hexToRgb(tokens.text2 || tokens.text));
  const panelLum = luminance(hexToRgb(tokens.panel));
  const lightText = text2Lum >= panelLum; // 亮字压暗底：黑纱补偿有效
  if (!lightText) {
    // 暗字压亮底（浅色皮肤）：不做黑纱补偿，需要更高不透明度就直接钳
    return { autoDim: 0, floor: backdropFloor(tokens, backdropLum, userScrim, 0.70) };
  }
  if (okAt(panelOpacity, 0)) return { autoDim: 0, floor: 0.7 };
  let lo = 0;
  let hi = 0.6;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (okAt(panelOpacity, mid)) hi = mid;
    else lo = mid;
  }
  if (okAt(panelOpacity, 0.6)) return { autoDim: Math.ceil(hi * 100) / 100, floor: 0.7 };
  // 自动压暗到顶仍不达标：硬钳兜底，floor 按「压暗顶格」时的需要算
  return { autoDim: 0.6, floor: backdropFloor(tokens, backdropLum, total(0.6), 0.70) };
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

  const bg = rgbToHex(normalizedSurface(main, dark ? 0.15 : 0.88, dark ? 0.30 : 0.94, 0.03));
  const panel = rgbToHex(normalizedSurface(main, dark ? 0.20 : 0.905, dark ? 0.36 : 0.965, 0.02));

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
  }));
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

// 压暗纱的色调：从底色（壁纸主色 / 其归一色）派生一层「有颜色的暗」——
// Mica 质感的一半来自 tint 而不是灰黑。只压亮度不换色相；亮度钳到 ≤0.1，
// 这样「底图 × 黑纱」的近似合成（effectivePanel / backdropFloor）仍然保守：
// tint 比纯黑亮出来的那点量，被纱里更深的顶栏渐变盖回去。
function scrimTint(bgHex) {
  if (!/^#[0-9a-f]{6}$/i.test(String(bgHex || ''))) return '#0b0c0e';
  let c = hexToRgb(bgHex);
  for (let i = 0; i < 8 && luminance(c) > 0.1; i++) {
    c = mixOk(c, { r: 0, g: 0, b: 0 }, 0.5);
  }
  return rgbToHex(c);
}

// 背景图模式四件套 + 纱色：面板不透明度 / 背景模糊 / 背景压暗 / 背景图 url / tint。
// 仅「跟随背景图」皮肤会传背景；其余皮肤调用时 background 为空，全部归位。
//
// 换壁纸走交叉淡入：旧图留在根变量上，新图挂到临时同款 .backdrop 层上淡入
// （styles.css .is-fade-in），完成后切根变量、移除临时层。只有「图 → 另一张图」
// 才淡入——首次设置淡入会闪一块空底，撤图淡出会闪一下黑，都直切。

let lastBackdropUrl = null;
let fadingTo = null; // 正在淡入的目标 url；非空期间重复铺装不得抢根变量
let fadeSeq = 0;

function applyBackdrop({ background, panelOpacity, bgBlur, scrim, tint, autoDim, style, wrapOpacity, brightness }) {
  const root = document.documentElement;
  const hasBg = !!background;
  const wrap = hasBg && style === 'wrap';
  root.style.setProperty('--panel-op', hasBg && !wrap ? String(clamp(panelOpacity ?? 1, 0.7, 1)) : '1');
  root.style.setProperty('--bg-blur', hasBg && !wrap ? `${Math.round(clamp(bgBlur ?? 0, 0, 60))}px` : '0px');
  root.style.setProperty('--bg-brightness', hasBg ? String(clamp(brightness ?? 1, 0.5, 1.5)) : '1');
  root.style.setProperty('--backdrop-dim', hasBg && !wrap ? String(clamp(scrim ?? 0, 0.2, 0.6)) : '0');
  root.style.setProperty('--backdrop-auto', hasBg && !wrap ? String(clamp(autoDim ?? 0, 0, 0.6)) : '0');
  root.style.setProperty('--wrap-op', wrap ? String(clamp(wrapOpacity ?? 0.62, 0.4, 1)) : '0.62');
  root.style.setProperty('--backdrop-tint', scrimTint(hasBg ? tint : ''));
  document.body.classList.toggle('wrap-mode', wrap);
  document.body.classList.toggle('has-bg', hasBg);

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
      panelOpacity: clamp((state && state.panelOpacity) ?? 0.88, 0.7, 1),
      bgBlur: clamp((state && state.bgBlur) ?? 0, 0, 60),
      bgBrightness: clamp((state && state.bgBrightness) ?? 1, 0.5, 1.5),
      scrim: clamp((state && state.scrim) ?? 0.30, 0.2, 0.6),
      backdropStyle: (state && state.backdropStyle) === 'wrap' ? 'wrap' : 'underlay',
      wrapOpacity: clamp((state && state.wrapOpacity) ?? 0.62, 0.4, 0.9),
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
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
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
            + '要求：bg 与 panel 是低彩度表面色，深浅方向与壁纸整体协调，panel 比 bg 明度高约一档；'
            + 'text 相对 panel 的对比度 ≥4.5:1，色温与壁纸一致；'
            + 'accent 是交互强调色，down/up 分别是下载/上传数据色，ok/warn/error 是语义色 —— 三组颜色色相彼此错开至少 30°；'
            + 'panelOpacity 取 0.7–1，blur 取 0–60。' },
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
    panelOpacity: 0.88,   // image 皮肤：面板不透明度（滑杆 0.70–1）
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
    state.panelOpacity = clamp(std.panelOpacity ?? 0.88, 0.7, 1);
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
      state.panelOpacity = clamp(cur.panelOpacity ?? 0.88, 0.7, 1);
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
    state.panelOpacity = clamp(state.panelOpacity ?? 0.88, 0.7, 1);
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
        ? { tokens: fixed, source: state.imageDraft.source || 'standard', ...(pal ? { palette: pal } : {}) }
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
  contrast,
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
  backdropFloor,
  backdropGuard,
  wrapFloor,
  scrimTint,
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
