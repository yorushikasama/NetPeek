// NetPeek 三模式主题系统。
// 三个并列模式：①自定义背景+标准离线取色（默认） ②自定义背景+AI 自适应（可保存） ③定制化主题。
// 共用一条流水线：分析 → 设计令牌（CSS 变量）→ WCAG 4.5:1 对比度校验 → 应用 → 可保存为主题。
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

// ---------- 中位切分取色 ----------

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

// 从色板挑出「主色」「强调色」：主色取权重最大且偏中性的色；强调取饱和度高者。
function pickBase(palette) {
  if (!palette.length) return null;
  palette.sort((a, b) => b.weight - a.weight);
  const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const main = palette[0];
  const accent = palette.slice(1).sort((a, b) => sat(b) - sat(a))[0] || main;
  return { main, accent };
}

// ---------- 令牌生成 ----------

// 标准离线取色：背景图 → 色板 → 完整设计令牌（hex 字符串）。
function tokensFromImage(imgData) {
  const palette = medianCut(imgData, 8);
  if (!palette.length) return tokensFromPreset('dark');

  const { main, accent } = pickBase(palette);
  const lum = luminance(main);
  const dark = lum < 0.5; // 背景偏暗 → 深色 UI

  const bg = rgbToHex(main);
  // 玻璃面板底色：主色压暗 35%（深色）或提亮 55%（浅色）
  const panel = rgbToHex(mix(main, dark ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }, dark ? 0.35 : 0.55));
  const border = rgbToHex(mix(main, dark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }, 0.25));

  const text = ensureContrast(dark ? '#f2e6dc' : '#2a211b', panel);
  const muted = ensureContrast(mix(hexToRgb(text), dark ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }, 0.55), panel);

  // 强调色：从色板提取有彩色；色板偏灰则用默认橙/蓝
  const sat = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const colorful = palette.filter((c) => sat(c) > 60).sort((a, b) => b.weight - a.weight);
  const down = ensureContrast(colorful[0] ? rgbToHex(colorful[0]) : '#f0913f', panel);
  const up = ensureContrast(colorful[1] ? rgbToHex(colorful[1]) : '#7fa8c9', panel);

  return {
    source: 'standard',
    background: '',
    tokens: {
      bg,
      panel,
      border,
      text,
      muted,
      down,
      up,
      ok: ensureContrast('#6fb87a', panel),
      warn: ensureContrast('#d9b44a', panel),
      error: ensureContrast('#e14b3a', panel),
    },
    panelOpacity: 0.92,
    blur: 12,
  };
}

// 内置预设主题（定制化模式用）
function tokensFromPreset(name) {
  const presets = {
    dark: {
      bg: '#111418',
      panel: '#1b1f26',
      border: '#2a2f38',
      text: '#f2e6dc',
      muted: '#a89184',
      down: '#f0913f',
      up: '#7fa8c9',
      ok: '#6fb87a',
      warn: '#d9b44a',
      error: '#e14b3a',
    },
    light: {
      bg: '#f5f2ee',
      panel: '#ffffff',
      border: '#ddd6cc',
      text: '#2a211b',
      muted: '#7a6a5e',
      down: '#c96a1a',
      up: '#2e6f9e',
      ok: '#2e7d4f',
      warn: '#9a7414',
      error: '#c03a2b',
    },
    contrast: {
      bg: '#000000',
      panel: '#101418',
      border: '#3a3f47',
      text: '#ffffff',
      muted: '#d0c8c0',
      down: '#ff9f43',
      up: '#5cb3ff',
      ok: '#3ddc84',
      warn: '#ffd24a',
      error: '#ff6b5e',
    },
  };
  const t = presets[name] || presets.dark;
  return {
    source: 'custom',
    background: '',
    tokens: { ...t },
    panelOpacity: 1,
    blur: 0,
  };
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

// ---------- 应用令牌 ----------

function applyTheme(theme, opts = {}) {
  const { tokens, background, panelOpacity, blur } = theme;
  const root = document.documentElement;
  const t = tokens;
  root.style.setProperty('--bg', t.bg);
  root.style.setProperty('--panel', t.panel);
  root.style.setProperty('--border', t.border);
  root.style.setProperty('--text', t.text);
  root.style.setProperty('--muted', t.muted);
  root.style.setProperty('--down', t.down);
  root.style.setProperty('--up', t.up);
  root.style.setProperty('--ok', t.ok);
  root.style.setProperty('--warn', t.warn);
  root.style.setProperty('--error', t.error);
  root.style.setProperty('--panel-opacity', String(panelOpacity ?? 0.92));
  root.style.setProperty('--blur', `${blur ?? 12}px`);
  root.style.setProperty('--theme-bg-image', background ? `url("${background}")` : 'none');
  // 深色底配深色 UI；浅色底配浅色 UI，原生控件同步
  root.style.colorScheme = luminance(hexToRgb(t.bg)) < 0.5 ? 'dark' : 'light';

  document.body.classList.toggle('has-bg', !!background);

  if (!opts.silent) {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
  }
}

// ---------- 主题列表 ----------

function makeTheme(name, source, tokens, background, panelOpacity, blur) {
  return { name, source, tokens, background, panelOpacity, blur };
}

function cloneTheme(t) {
  return JSON.parse(JSON.stringify(t));
}

// ---------- AI 模式：调用 OpenAI 兼容多模态接口 ----------

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

// 对比度校验并修正：确保 text/muted/down/up/ok/warn/error 相对 panel ≥ 4.5
function validateTokens(tokens) {
  const out = { ...tokens };
  for (const k of ['text', 'muted', 'down', 'up', 'ok', 'warn', 'error']) {
    out[k] = ensureContrast(tokens[k], tokens.panel);
  }
  return out;
}

// 初始化：加载配置并应用
async function initTheme() {
  const storage = configStorage();
  const raw = await storage.load();
  const cfg = raw && typeof raw === 'object' ? raw : null;
  const fresh = !cfg;
  const state = cfg || {
    mode: 'standard', // standard | ai | custom
    themes: {},
    active: 'default',
    standard: { panelOpacity: 0.92, blur: 12 },
    custom: tokensFromPreset('dark'),
    ai: { provider: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' }, consented: false, lastImageHash: '' },
  };
  // 兼容缺字段的旧配置
  if (!state.themes) state.themes = {};
  if (!state.standard) state.standard = { panelOpacity: 0.92, blur: 12 };
  if (!state.ai) state.ai = { provider: { endpoint: '', apiKey: '', model: 'gpt-4o-mini' }, consented: false };
  if (!state.ai.provider) state.ai.provider = { endpoint: '', apiKey: '', model: 'gpt-4o-mini' };
  if (!state.custom) state.custom = tokensFromPreset('dark');
  // 保证默认主题存在
  if (!state.themes.default) {
    state.themes.default = { ...tokensFromPreset('dark'), name: '默认深色', source: 'custom' };
  }
  if (!state.active) state.active = 'default';
  return { state, storage, fresh };
}

// 汇出供 UI 与测试使用
window.NetPeekTheme = {
  THEME_EVENT,
  hexToRgb,
  rgbToHex,
  luminance,
  contrast,
  ensureContrast,
  medianCut,
  tokensFromImage,
  tokensFromPreset,
  validateTokens,
  applyTheme,
  makeTheme,
  cloneTheme,
  aiGenerate,
  configStorage,
  initTheme,
};
