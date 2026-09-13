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

// WCAG 相对亮度（0..1）
function luminance({ r, g, b }) {
  const f = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// WCAG 对比度比
function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

const MIN_CONTRAST = 4.5;

// 把前景色在给定背景上调亮/调暗直到对比度达标（若无法达到 4.5，尽量逼近并报告）。
function ensureContrast(fgHex, bgHex) {
  const bg = hexToRgb(bgHex);
  let fg = hexToRgb(fgHex);
  if (contrast(fg, bg) >= MIN_CONTRAST) return fgHex;
  const baseLum = luminance(bg);
  // 背景偏暗 → 往白调；偏亮 → 往黑调
  const target = baseLum < 0.4 ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const c = mix(fg, target, mid);
    if (contrast(c, bg) >= MIN_CONTRAST) hi = mid;
    else lo = mid;
  }
  let out = mix(fg, target, hi);
  // 注意：对比度判断必须基于「取整后的十六进制值」——未取整值达标、取整后可能跌破阈值（如 4.49）。
  for (let i = 0; i < 32 && contrast(hexToRgb(rgbToHex(out)), bg) < MIN_CONTRAST; i++) {
    out = mix(out, target, 0.04);
  }
  return rgbToHex(out);
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

// ---------- 中位切分取色（跟随背景图皮肤用） ----------

// 从 ImageData 提取主色板（中位切分，最多 maxColors 色）。返回 RGB 数组。
function medianCut(imgData, maxColors = 8) {
  const { data } = imgData;
  const pixels = [];
  const step = 4; // 抽样步长，控制计算量
  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue; // 跳过透明
    pixels.push([r, g, b]);
  }
  if (!pixels.length) return [];

  const buckets = [pixels];
  while (buckets.length < maxColors) {
    // 选范围（按通道跨度）最大的桶切分
    let bi = -1;
    let best = -1;
    buckets.forEach((bkt, idx) => {
      if (bkt.length < 2) return;
      const span = channelSpan(bkt);
      if (span > best) {
        best = span;
        bi = idx;
      }
    });
    if (bi < 0) break;
    const bkt = buckets[bi];
    const channel = channelWithMaxSpan(bkt);
    bkt.sort((a, b) => a[channel] - b[channel]);
    const mid = Math.floor(bkt.length / 2);
    buckets.splice(bi, 1, bkt.slice(0, mid), bkt.slice(mid));
  }

  return buckets
    .filter((b) => b.length > 0)
    .map((bkt) => {
      const sum = [0, 0, 0];
      for (const p of bkt) {
        sum[0] += p[0];
        sum[1] += p[1];
        sum[2] += p[2];
      }
      return {
        r: Math.round(sum[0] / bkt.length),
        g: Math.round(sum[1] / bkt.length),
        b: Math.round(sum[2] / bkt.length),
        weight: bkt.length,
      };
    });
}

function channelSpan(bkt) {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const p of bkt) {
    for (let c = 0; c < 3; c++) {
      if (p[c] < min[c]) min[c] = p[c];
      if (p[c] > max[c]) max[c] = p[c];
    }
  }
  return Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

function channelWithMaxSpan(bkt) {
  const min = [255, 255, 255];
  const max = [0, 0, 0];
  for (const p of bkt) {
    for (let c = 0; c < 3; c++) {
      if (p[c] < min[c]) min[c] = p[c];
      if (p[c] > max[c]) max[c] = p[c];
    }
  }
  let best = 0;
  let span = -1;
  for (let c = 0; c < 3; c++) {
    if (max[c] - min[c] > span) {
      span = max[c] - min[c];
      best = c;
    }
  }
  return best;
}

// 从色板挑出「主色」（权重最大）与「强调色」（饱和度最高者）。
function pickBase(palette) {
  if (!palette.length) return null;
  palette.sort((a, b) => b.weight - a.weight);
  const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const main = palette[0];
  const accent = palette.slice(1).sort((a, b) => sat(b) - sat(a))[0] || main;
  return { main, accent };
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
    panelHi: rgbToHex(mix(panelRgb, toward, dark ? 0.06 : 0.10)),
    // 凹一档：顶栏、rail、表头、输入框
    panel2: rgbToHex(mix(bgRgb, { r: 0, g: 0, b: 0 }, dark ? 0.15 : 0.05)),
    line: rgbToHex(mix(panelRgb, textRgb, dark ? 0.09 : 0.17)),
    lineSoft: rgbToHex(mix(panelRgb, textRgb, dark ? 0.03 : 0.09)),
    text: core.text,
    text2: rgbToHex(mix(textRgb, bgRgb, dark ? 0.35 : 0.38)),
    text3: rgbToHex(mix(textRgb, bgRgb, dark ? 0.62 : 0.60)),
    down: core.down,
    up: core.up,
    ok: core.ok,
    warn: core.warn,
    error: core.error,
    // 交互强调缺省 = 中性反白（深色）/ 中性深灰（浅色），与 v2 基底思路一致
    accent: core.accent || core.text,
  };

  // 强调底上的文字：两个候选里谁对比度高用谁（琥珀这类中间亮度色靠它选黑字）
  const acc = hexToRgb(out.accent);
  const darkInk = { r: 21, g: 23, b: 27 };
  const lightInk = { r: 242, g: 243, b: 245 };
  out.accentInk = contrast(acc, darkInk) >= contrast(acc, lightInk)
    ? rgbToHex(darkInk)
    : rgbToHex(lightInk);
  // 选中指示条 = 强调色略收敛一档
  out.selBar = rgbToHex(mix(acc, bgRgb, 0.10));
  return out;
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
    full.text3 = rgbToHex(mix(hexToRgb(t.muted), hexToRgb(t.bg), 0.4));
  }
  return full;
}

// 对比度校验并修正：正文字阶与语义色相对 panel ≥ 4.5。
// text3（弱文字阶）不校 —— 3:1 左右的弱对比是它的设计意图，校了层级就没了。
function validateSkin(tokens) {
  const out = { ...tokens };
  for (const k of ['text', 'text2', 'down', 'up', 'ok', 'warn', 'error', 'accent']) {
    if (/^#[0-9a-f]{6}$/i.test(out[k] || '')) out[k] = ensureContrast(out[k], out.panel);
  }
  return out;
}

// ---------- 背景图取色 → token 表 ----------

// 标准离线取色：背景图 → 色板 → 完整 17 键 token 表。
function tokensFromImage(imgData) {
  const palette = medianCut(imgData, 8);
  if (!palette.length) return { ...SKINS.plain.tokens };

  const { main, accent } = pickBase(palette);
  const lum = luminance(main);
  const dark = lum < 0.5; // 背景偏暗 → 深色 UI

  const bg = rgbToHex(main);
  // 玻璃面板底色：主色压暗 35%（深色）或提亮 55%（浅色）
  const panel = rgbToHex(mix(main, dark ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, dark ? 0.35 : 0.55));

  const text = ensureContrast(dark ? '#f2e6dc' : '#2a211b', panel);

  // 有彩色提交互强调与语义色；色板偏灰则交互退回中性反白
  const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const colorful = palette.filter((c) => sat(c) > 60).sort((a, b) => b.weight - a.weight);
  const accentHex = colorful[0] ? ensureContrast(rgbToHex(colorful[0]), panel) : text;
  const down = ensureContrast(colorful[0] ? rgbToHex(colorful[0]) : '#f0963f', panel);
  const up = ensureContrast(colorful[1] ? rgbToHex(colorful[1]) : '#62a9e8', panel);

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

// ---------- 应用令牌 ----------

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
  root.style.colorScheme = luminance(hexToRgb(t.text)) > 0.5 ? 'dark' : 'light';
  if (!opts.silent) {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { tokens: t } }));
  }
}

// 背景图模式四件套：面板不透明度 / 背景模糊 / 背景压暗 / 背景图 url。
// 仅「跟随背景图」皮肤会传背景；其余皮肤调用时 background 为空，全部归位。
function applyBackdrop({ background, panelOpacity, bgBlur, scrim }) {
  const root = document.documentElement;
  const hasBg = !!background;
  root.style.setProperty('--panel-op', hasBg ? String(clamp(panelOpacity ?? 1, 0.82, 1)) : '1');
  root.style.setProperty('--bg-blur', hasBg ? `${Math.round(clamp(bgBlur ?? 0, 0, 40))}px` : '0px');
  root.style.setProperty('--backdrop-dim', hasBg ? String(clamp(scrim ?? 0, 0.2, 0.6)) : '0');
  root.style.setProperty('--theme-bg-image', hasBg ? `url("${background}")` : 'none');
  document.body.classList.toggle('has-bg', hasBg);
}

// ---------- 皮肤解析 ----------

// state + 皮肤 id → { tokens, background, panelOpacity, bgBlur, scrim }。
// 皮肤 id：内置 'plain' | 'light' | 'amber'；'image'（跟随背景图）；其余视为 themes 里的自定义皮肤名。
// 小窗等只想要颜色的调用方，忽略返回值里的 background 即可（mini 不做 backdrop）。
function resolveSkin(state, id) {
  const skinId = id || (state && state.skin) || 'plain';
  if (SKINS[skinId]) {
    return { tokens: { ...SKINS[skinId].tokens }, background: '', panelOpacity: 1, bgBlur: 0, scrim: 0 };
  }
  if (skinId === 'image') {
    const draft = state && state.imageDraft;
    return {
      tokens: draft && draft.tokens ? { ...draft.tokens } : { ...SKINS.plain.tokens },
      background: (state && state.backgroundImage) || '',
      panelOpacity: clamp((state && state.panelOpacity) ?? 0.92, 0.82, 1),
      bgBlur: clamp((state && state.bgBlur) ?? 0, 0, 40),
      scrim: clamp((state && state.scrim) ?? 0.30, 0.2, 0.6),
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
          // 仍要求旧 10 键：这套键名模型见过、生成质量稳，拿到手再 convertLegacyTokens 归一
          { type: 'text', text: '根据这张壁纸生成一套 UI 主题令牌，输出 JSON（不要代码块）：{"bg":"#hex","panel":"#hex","border":"#hex","text":"#hex","muted":"#hex","down":"#hex","up":"#hex","ok":"#hex","warn":"#hex","error":"#hex","panelOpacity":0.9,"blur":12}。颜色需与壁纸风格协调，保证文字可读。' },
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
  const keys = ['bg', 'panel', 'border', 'text', 'muted', 'down', 'up', 'ok', 'warn', 'error'];
  for (const k of keys) {
    if (!/^#[0-9a-f]{6}$/i.test(parsed[k] || '')) throw new Error(`AI 返回缺少或非法颜色 ${k}`);
  }
  return {
    tokens: {
      bg: parsed.bg, panel: parsed.panel, border: parsed.border,
      text: parsed.text, muted: parsed.muted,
      down: parsed.down, up: parsed.up, ok: parsed.ok, warn: parsed.warn, error: parsed.error,
    },
    panelOpacity: typeof parsed.panelOpacity === 'number' ? parsed.panelOpacity : 0.9,
    blur: typeof parsed.blur === 'number' ? parsed.blur : 12,
  };
}

// ---------- 状态：默认值与旧配置迁移 ----------

function defaultState() {
  return {
    skin: 'plain',        // 内置 id | 'image' | themes 里的自定义皮肤名
    backgroundImage: '',  // 仅 image 皮肤使用（已落盘路径）
    panelOpacity: 0.92,   // image 皮肤：面板不透明度
    bgBlur: 0,            // image 皮肤：背景模糊半径 px
    scrim: 0.30,          // image 皮肤：背景压暗
    imageDraft: null,     // image 皮肤的 token 表草稿 { tokens, source: 'standard'|'ai' }
    custom: null,         // 自定义编辑器草稿 { tokens }（17 键完整表）
    themes: {},           // 已另存的自定义皮肤 { name: { name, tokens } }
    active: 'plain',      // 等于 skin（保留独立字段便于以后做「预览未应用」）
    ai: { provider: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' }, consented: false },
  };
}

// 就地迁移/补全，保证 state 满足新格式。
function migrateState(state) {
  // 旧版三模式（mode: standard | ai | custom）→ 新皮肤归属
  if (typeof state.mode === 'string') {
    const std = state.standard || {};
    state.panelOpacity = clamp(std.panelOpacity ?? 0.92, 0.82, 1);
    state.bgBlur = clamp(std.blur ?? 0, 0, 40);
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
    delete state.custom;
    delete state.pendingBackground;
    delete state.aiApplied;
  }

  if (!SKINS[state.skin] && state.skin !== 'image' && !(state.themes && state.themes[state.skin])) {
    state.skin = 'plain';
  }
  state.active = state.skin;
  if (!state.themes || typeof state.themes !== 'object') state.themes = {};
  for (const th of Object.values(state.themes)) {
    if (!th || typeof th !== 'object' || !th.tokens) continue;
    const fixed = convertLegacyTokens(th.tokens);
    if (fixed) th.tokens = fixed;
  }

  if (state.skin === 'image') {
    state.panelOpacity = clamp(state.panelOpacity ?? 0.92, 0.82, 1);
    state.bgBlur = clamp(state.bgBlur ?? 0, 0, 40);
    state.scrim = clamp(state.scrim ?? 0.30, 0.2, 0.6);
    if (state.imageDraft && state.imageDraft.tokens) {
      const fixed = convertLegacyTokens(state.imageDraft.tokens);
      state.imageDraft = fixed ? { tokens: fixed, source: state.imageDraft.source || 'standard' } : null;
    } else {
      state.imageDraft = null;
    }
  } else {
    state.backgroundImage = '';
    state.imageDraft = null;
  }

  if (state.custom && !state.custom.tokens) state.custom = null;
  if (state.custom && state.custom.tokens) {
    const fixed = convertLegacyTokens(state.custom.tokens);
    state.custom = fixed ? { tokens: fixed } : null;
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
  luminance,
  contrast,
  ensureContrast,
  clamp,
  medianCut,
  pickBase,
  tokensFromImage,
  expandTokens,
  convertLegacyTokens,
  validateSkin,
  applyTokens,
  applyBackdrop,
  resolveSkin,
  aiGenerate,
  configStorage,
  initTheme,
};
