// 外观屏交互层。
//
// v2 统一模型（2026-09-05 重设计）：state.current 是唯一事实源——
// 换壁纸自动取色、AI 生成、预设起步都是往 current 里写令牌的「生成方式」，
// 高级色板微调与材质滑杆编辑的也是 current，没有互斥的模式开关。
// 检查栏放当前主题卡 / 对比度校验结果 / 主题列表；数据岛放壁纸条与材质。
//
// 背景 URL 的三种来源与解析：
//   data:…        原样用（浏览器调试 / IPC 回退）
//   builtin:x     ui/wallpapers/x.jpg（随前端静态资源分发，相对路径）
//   本地文件路径   优先 asset protocol（convertFileSrc，零拷贝过 IPC），
//                 画布取色失败（跨域污染）或 convert 不可用时回退 IPC data URL

(function () {
  const T = window.NetPeekTheme;
  const $ = (id) => document.getElementById(id);

  const SWATCH_IDS = ['cBg', 'cPanel', 'cText', 'cMuted', 'cDown', 'cUp', 'cOk', 'cWarn', 'cError', 'cBorder'];
  const SWATCH_TO_TOKEN = {
    cBg: 'bg', cPanel: 'panel', cText: 'text', cMuted: 'muted', cDown: 'down',
    cUp: 'up', cOk: 'ok', cWarn: 'warn', cError: 'error', cBorder: 'border',
  };
  const CONTRAST_KEYS = ['text', 'muted', 'down', 'up', 'ok', 'warn', 'error'];
  const SOURCE_LABEL = { standard: '取色', ai: 'AI', custom: '定制' };
  const WALLPAPER_PREFIX = 'builtin:';

  const els = {
    bgStatus: $('bgStatus'),
    bgPick: $('bgPick'),
    bgClear: $('bgClear'),
    bgFile: $('bgFile'),
    stdOpacity: $('stdOpacity'),
    stdScrim: $('stdScrim'),
    stdBlur: $('stdBlur'),
    opValue: $('opValue'),
    scrimValue: $('scrimValue'),
    blurValue: $('blurValue'),
    materialNote: $('materialNote'),
    followSystem: $('followSystem'),
    followSystemWrap: $('followSystemWrap'),
    advToggle: $('advToggle'),
    aiEndpoint: $('aiEndpoint'),
    aiApiKey: $('aiApiKey'),
    aiModel: $('aiModel'),
    aiConsent: $('aiConsent'),
    aiGenerate: $('aiGenerate'),
    aiStatus: $('aiStatus'),
    presets: Array.from(document.querySelectorAll('[data-preset]')),
    wallThumbs: Array.from(document.querySelectorAll('.wall-thumb[data-wall]')),
    curThemeChip: $('curThemeChip'),
    curThemeName: $('curThemeName'),
    curThemeMeta: $('curThemeMeta'),
    contrastBadge: $('contrastBadge'),
    themeName: $('themeName'),
    themeSave: $('themeSave'),
    themeList: $('themeList'),
    themeReset: $('themeReset'),
    stageHint: $('stageHint'),
  };
  SWATCH_IDS.forEach((id) => { els[id] = $(id); });

  let state = null;
  let storage = null;
  let bgDataUrl = '';    // 当前背景的解析结果（data: / asset: / 相对路径），CSS 与画布共用
  let stdImage = null;   // ≤512px 的 ImageData，取色与 AI 缩略图共用
  let thumbDataUrl = ''; // AI 请求用的 JPEG 缩略图，随背景失效

  // ---------- 背景解析 ----------

  async function resolveBgUrl(value) {
    if (!value) return '';
    if (value.startsWith('data:')) return value;
    if (value.startsWith(WALLPAPER_PREFIX)) {
      return 'wallpapers/' + value.slice(WALLPAPER_PREFIX.length) + '.jpg';
    }
    const tauri = window.__TAURI__;
    if (tauri && tauri.core && tauri.core.convertFileSrc) {
      try {
        return tauri.core.convertFileSrc(value);
      } catch { /* convert 失败走 IPC 回退 */ }
    }
    try { return await storage.readBackground(value); } catch { return ''; }
  }

  function loadImageData(src) {
    return new Promise((resolve) => {
      const img = new Image();
      // asset 域与页面不同源，必须带 CORS 头才不会污染画布（Tauri asset protocol 带 ACAM:*）
      if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const max = 512; // 缩到 ≤512px：取色够用，也是发给 AI 的尺寸上限（隐私承诺）
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, w, h);
          resolve(ctx.getImageData(0, 0, w, h));
        } catch {
          resolve(null); // 画布被污染 → 调用方回退 IPC data URL
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function loadStdImage() {
    const url = await resolveBgUrl(state.current.background);
    bgDataUrl = url;
    stdImage = url ? await loadImageData(url) : null;
    thumbDataUrl = '';
    if (!stdImage && url && state.current.background && !state.current.background.startsWith(WALLPAPER_PREFIX)) {
      try {
        const dataUrl = await storage.readBackground(state.current.background);
        if (dataUrl) {
          bgDataUrl = dataUrl;
          stdImage = await loadImageData(dataUrl);
        }
      } catch { /* 取色与 AI 在本轮不可用，材质不受影响 */ }
    }
  }

  // ---------- 应用当前主题（唯一出口） ----------

  function syncTuningLabels() {
    els.opValue.textContent = parseFloat(els.stdOpacity.value).toFixed(2);
    els.scrimValue.textContent = parseFloat(els.stdScrim.value).toFixed(2);
    // 不透明度和压暗是比例，模糊半径是长度，得带单位才知道量级
    els.blurValue.textContent = `${els.stdBlur.value} px`;
  }

  // 校验把多少个颜色动了手（用户可见的质量信号，见检查栏「对比度」）
  function countCorrected(before, after) {
    let n = 0;
    for (const k of CONTRAST_KEYS) {
      if (String(before[k] || '').toLowerCase() !== String(after[k] || '').toLowerCase()) n++;
    }
    return n;
  }

  function fillSwatches(tokens) {
    for (const id of SWATCH_IDS) {
      const v = tokens[SWATCH_TO_TOKEN[id]];
      if (/^#[0-9a-f]{6}$/i.test(v || '')) els[id].value = v;
    }
  }

  function activeThemeName() {
    const th = state.themes[state.active];
    if (!th) return '';
    const saved = JSON.stringify([th.tokens, th.panelOpacity, th.blur, th.scrim, th.background]);
    const cur = JSON.stringify([state.current.tokens, state.current.panelOpacity, state.current.blur, state.current.scrim, state.current.background]);
    return saved === cur ? state.active : '';
  }

  // 小窗是另一个 webview，CSS 变量不跨窗口继承，把令牌广播过去（背景剥掉，data URL 太大；
  // 拖滑杆会每帧触发，节流 120ms）。
  let broadcastTimer = 0;
  function broadcast(cur) {
    if (!window.__TAURI__) return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      window.__TAURI__.event.emit('theme-changed', {
        source: cur.source, tokens: cur.tokens,
        panelOpacity: cur.panelOpacity, blur: cur.blur, scrim: cur.scrim,
      }).catch(() => {});
    }, 120);
  }

  function syncStageHint() {
    els.stageHint.hidden = !!state.current.background || !!state.bgHintDismissed;
  }

  async function applyCurrent() {
    const cur = state.current;
    const tokens = T.validateTokens(cur.tokens);
    const corrected = countCorrected(cur.tokens, tokens);
    cur.tokens = tokens; // 校正结果写回事实源，保存主题时带出去的就是校正后的值

    const bg = await resolveBgUrl(cur.background);
    bgDataUrl = bg;
    T.applyTheme({ source: cur.source, tokens, background: bg, panelOpacity: cur.panelOpacity, blur: cur.blur, scrim: cur.scrim });
    broadcast(cur);
    fillSwatches(tokens);

    // 检查栏「当前主题」卡
    const name = activeThemeName();
    els.curThemeName.textContent = name || '未保存的定制';
    els.curThemeMeta.textContent =
      `${SOURCE_LABEL[cur.source] || '定制'} · 岛屿 ${Number(cur.panelOpacity).toFixed(2)} · 模糊 ${Math.round(cur.blur)}px · 压暗 ${Number(cur.scrim).toFixed(2)}`;
    els.curThemeChip.style.background = `linear-gradient(135deg, ${tokens.down} 50%, ${tokens.up} 50%)`;
    els.contrastBadge.textContent = corrected ? `${corrected} 项已校正` : '✓ 全部达标';
    els.contrastBadge.className = 'sec-aside ' + (corrected ? 'is-warn' : 'is-ok');

    // 材质滑杆只在有背景图时有意义（无背景时岛屿不透明、没有 scrim 可言）
    const hasBg = !!cur.background;
    for (const s of [els.stdOpacity, els.stdScrim, els.stdBlur]) s.disabled = !hasBg;
    els.materialNote.hidden = hasBg;
    els.followSystemWrap.hidden = hasBg;

    // 壁纸条选中态与状态行
    for (const b of els.wallThumbs) b.classList.toggle('is-active', b.dataset.wall === cur.background);
    els.bgStatus.textContent = hasBg
      ? (cur.background.startsWith(WALLPAPER_PREFIX) ? '内置壁纸' : '自定义图片')
      : '未设置背景（使用面板底色）';
    els.bgStatus.className = 'note truncate';

    syncAiGate();
    syncStageHint();
  }

  // ---------- 生成方式 1：从背景取色（换壁纸自动触发） ----------

  function systemPrefersDark() {
    return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // 无背景时的兜底令牌：跟随系统开关决定深 / 浅
  function fallbackPreset() {
    const dark = !state.followSystem || systemPrefersDark();
    return T.tokensFromPreset(dark ? 'dark' : 'light');
  }

  async function regenerateFromImage() {
    const base = stdImage ? T.tokensFromImage(stdImage) : fallbackPreset();
    state.current.tokens = T.validateTokens(base.tokens);
    state.current.source = 'standard';
    await applyCurrent();
  }

  async function setWallpaper(value) {
    state.current.background = value;
    await loadStdImage();
    await regenerateFromImage();
    persist();
  }

  // ---------- 生成方式 2：AI 自适应 ----------

  function aiThumbDataUrl() {
    if (!stdImage) return '';
    if (!thumbDataUrl) {
      const canvas = document.createElement('canvas');
      canvas.width = stdImage.width;
      canvas.height = stdImage.height;
      canvas.getContext('2d').putImageData(stdImage, 0, 0);
      thumbDataUrl = canvas.toDataURL('image/jpeg', 0.85);
    }
    return thumbDataUrl;
  }

  function syncAiGate() {
    // 未勾选授权或没有背景图时「生成并应用」是 disabled 态，不是点了报错
    els.aiGenerate.disabled = !els.aiConsent.checked || !stdImage;
  }

  async function runAi() {
    els.aiStatus.textContent = 'AI 生成中…';
    els.aiStatus.className = 'note';
    // 同图复用：像素哈希命中缓存就直接应用，不发请求
    const hash = T.hashImageData(stdImage);
    const cached = state.ai.cache[hash];
    if (cached) {
      await applyAiResult(cached);
      state.ai.lastImageHash = hash;
      els.aiStatus.textContent = '同一张图已生成过，直接复用上次结果';
      els.aiStatus.className = 'note is-ok';
      return;
    }
    try {
      const res = await T.aiGenerate({
        endpoint: els.aiEndpoint.value.trim(),
        apiKey: els.aiApiKey.value.trim(),
        model: els.aiModel.value.trim(),
      }, aiThumbDataUrl());
      await applyAiResult(res);
      // 缓存应用后的结果；上限 5 份，超出淘汰最早的
      state.ai.lastImageHash = hash;
      state.ai.cache[hash] = {
        tokens: { ...state.current.tokens },
        panelOpacity: state.current.panelOpacity,
        blur: state.current.blur,
      };
      const keys = Object.keys(state.ai.cache);
      while (keys.length > 5) delete state.ai.cache[keys.shift()];
      els.aiStatus.textContent = '已应用，可在右侧命名保存到主题列表';
      els.aiStatus.className = 'note is-ok';
    } catch (err) {
      els.aiStatus.textContent = `AI 失败（${err.message}），已回退离线取色`;
      els.aiStatus.className = 'note is-error';
      await regenerateFromImage();
    }
  }

  async function applyAiResult(res) {
    state.current.tokens = T.validateTokens(res.tokens);
    state.current.source = 'ai';
    state.current.panelOpacity = T.clamp(res.panelOpacity, 0.82, 1);
    state.current.blur = T.clamp(res.blur, 0, 40);
    els.stdOpacity.value = state.current.panelOpacity;
    els.stdBlur.value = Math.round(state.current.blur);
    syncTuningLabels();
    await applyCurrent();
  }

  // ---------- 高级微调（语义色） ----------

  function syncAdvanced() {
    els.advToggle.checked = !!state.advanced;
    for (const id of SWATCH_IDS) {
      const locked = id === 'cDown' || id === 'cUp';
      els[id].disabled = !state.advanced || locked;
      els[id].closest('.swatch').style.opacity = !state.advanced ? '0.4' : (locked ? '0.6' : '');
    }
  }

  // ---------- 主题列表 ----------

  const TAGS = { ai: 'AI', standard: '取色', custom: '定制' };

  function renderThemeList() {
    const frag = document.createDocumentFragment();
    for (const name of Object.keys(state.themes || {})) {
      const th = state.themes[name];
      const item = document.createElement('div');
      item.className = 'theme-item' + (state.active === name ? ' is-active' : '');
      item.innerHTML = `
        <span class="name">${escapeHtml(name)}</span>
        <span class="tag">${TAGS[th.source] || '定制'}</span>
        <span class="row-actions">
          <button type="button" class="icon-btn" data-act="use" title="应用">✓</button>
          <button type="button" class="icon-btn" data-act="rename" title="重命名">✎</button>
          <button type="button" class="icon-btn" data-act="delete" title="删除">🗑</button>
        </span>`;
      item.querySelector('[data-act="use"]').addEventListener('click', () => useTheme(name));
      item.querySelector('[data-act="rename"]').addEventListener('click', () => renameTheme(name, item.querySelector('.name')));
      item.querySelector('[data-act="delete"]').addEventListener('click', () => deleteTheme(name));
      frag.appendChild(item);
    }
    els.themeList.replaceChildren(frag);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function useTheme(name) {
    const th = state.themes[name];
    if (!th) return;
    state.active = name;
    state.current = {
      source: th.source || 'custom',
      tokens: { ...T.tokensFromPreset('dark').tokens, ...(th.tokens || {}) },
      background: th.background || '',
      panelOpacity: T.clamp(th.panelOpacity ?? 0.88, 0.82, 1),
      blur: T.clamp(th.blur ?? 24, 0, 40),
      scrim: T.clamp(th.scrim ?? 0.30, 0.2, 0.6),
    };
    els.stdOpacity.value = state.current.panelOpacity;
    els.stdBlur.value = Math.round(state.current.blur);
    els.stdScrim.value = state.current.scrim;
    syncTuningLabels();
    await loadStdImage();
    await applyCurrent();
    renderThemeList();
    persist();
  }

  // 内联重命名：点 ✎ 后名字原位变输入框，Enter/失焦提交，Esc 取消。
  // 不用 window.prompt —— Tauri 的 webview 对原生脚本对话框支持不可靠。
  function renameTheme(name, nameEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = name;
    input.className = 'rename-input';
    input.setAttribute('aria-label', '重命名主题');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && next && next !== name) {
        state.themes[next] = { ...state.themes[name], name: next };
        if (state.active === name) state.active = next;
        delete state.themes[name];
        persist();
      }
      renderThemeList();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true);
      else if (e.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
  }

  function deleteTheme(name) {
    if (name === 'default') {
      els.bgStatus.textContent = '默认主题不能删除';
      els.bgStatus.className = 'note is-warn';
      return;
    }
    delete state.themes[name];
    if (state.active === name) {
      // 删的是当前主题：立刻回落到 default 并应用，不能让界面停在被删配色上
      state.active = 'default';
      useTheme('default');
    }
    renderThemeList();
    persist();
  }

  // ---------- 持久化（节流 300ms） ----------

  function persist() {
    if (!storage) return Promise.resolve();
    clearTimeout(persist._t);
    return new Promise((resolve) => {
      persist._t = setTimeout(() => { storage.save(state).then(resolve, resolve); }, 300);
    });
  }

  // ---------- 事件绑定 ----------

  els.bgPick.addEventListener('click', () => els.bgFile.click());

  for (const b of els.wallThumbs) {
    b.addEventListener('click', () => setWallpaper(b.dataset.wall));
  }

  function readFileAsDataURL(file) {
    return new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(file);
    });
  }

  els.bgFile.addEventListener('change', async () => {
    const file = els.bgFile.files[0];
    if (!file) return;
    try {
      const dataUrl = await readFileAsDataURL(file);
      // 落盘到应用数据目录（SHA-256 前缀命名去重），主题里只存路径
      const path = await storage.saveBackground(dataUrl);
      await setWallpaper(path);
    } catch (err) {
      els.bgStatus.textContent = `背景加载失败：${err.message}`;
      els.bgStatus.className = 'note is-error';
    }
  });

  els.bgClear.addEventListener('click', () => {
    // 用户明确选择「无背景」就是做了决定：关掉留白区的邀请提示，不再反复问
    state.bgHintDismissed = true;
    return setWallpaper('');
  });

  for (const input of [els.stdOpacity, els.stdScrim, els.stdBlur]) {
    input.addEventListener('input', () => {
      syncTuningLabels();
      // 滑杆只动材质，令牌不重生成——任何来源（取色/AI/手调）的配色都不会被冲掉
      state.current.panelOpacity = parseFloat(els.stdOpacity.value);
      state.current.blur = parseInt(els.stdBlur.value, 10);
      state.current.scrim = parseFloat(els.stdScrim.value);
      applyCurrent();
      persist();
    });
  }

  els.followSystem.addEventListener('change', () => {
    state.followSystem = els.followSystem.checked;
    if (!state.current.background) regenerateFromImage();
    persist();
  });

  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    (mq.addEventListener || mq.addListener).call(mq, 'change', () => {
      if (!state.current.background && state.followSystem) regenerateFromImage();
    });
  }

  els.advToggle.addEventListener('change', () => {
    state.advanced = els.advToggle.checked;
    syncAdvanced();
    persist();
  });

  SWATCH_IDS.forEach((id) => {
    els[id].addEventListener('input', () => {
      state.current.tokens[SWATCH_TO_TOKEN[id]] = els[id].value;
      state.current.source = 'custom'; // 手调过就是定制，纯记录标签
      applyCurrent();
      persist();
    });
  });

  els.presets.forEach((b) => {
    b.addEventListener('click', () => {
      state.current.tokens = { ...T.tokensFromPreset(b.dataset.preset).tokens };
      state.current.source = 'custom';
      applyCurrent();
      persist();
    });
  });

  els.aiConsent.addEventListener('change', () => {
    state.ai.consented = els.aiConsent.checked;
    syncAiGate();
    persist();
  });

  els.aiGenerate.addEventListener('click', () => {
    state.ai.provider = {
      endpoint: els.aiEndpoint.value.trim(),
      apiKey: els.aiApiKey.value.trim(),
      model: els.aiModel.value.trim(),
    };
    runAi().then(persist);
  });

  els.themeSave.addEventListener('click', () => {
    const name = els.themeName.value.trim();
    if (!name) {
      els.bgStatus.textContent = '请先给主题起个名字';
      els.bgStatus.className = 'note is-warn';
      return;
    }
    state.themes[name] = {
      name,
      source: state.current.source,
      tokens: { ...state.current.tokens },
      background: state.current.background,
      panelOpacity: state.current.panelOpacity,
      blur: state.current.blur,
      scrim: state.current.scrim,
    };
    state.active = name;
    els.themeName.value = '';
    renderThemeList();
    persist();
  });

  els.themeReset.addEventListener('click', async () => {
    const def = T.tokensFromPreset('dark');
    state.current = {
      source: 'standard', tokens: { ...def.tokens }, background: '',
      panelOpacity: 0.88, blur: 24, scrim: 0.30,
    };
    state.active = 'default';
    state.themes = { default: { ...def, name: '默认深色', source: 'custom' } };
    state.advanced = false;
    stdImage = null;
    thumbDataUrl = '';
    bgDataUrl = '';
    els.stdOpacity.value = 0.88;
    els.stdBlur.value = 24;
    els.stdScrim.value = 0.30;
    syncAdvanced();
    syncTuningLabels();
    await applyCurrent();
    renderThemeList();
    await persist();
  });

  // ---------- 启动 ----------

  window.NetPeekThemeUI = {
    // 留白区提示的「挑一张」直接借这条路径（跳到外观屏后由 main.js 调用）
    pickBackground() { els.bgFile.click(); },

    async init() {
      const boot = await T.initTheme();
      state = boot.state;
      storage = boot.storage;

      els.aiEndpoint.value = state.ai.provider.endpoint || '';
      els.aiApiKey.value = state.ai.provider.apiKey || '';
      els.aiModel.value = state.ai.provider.model || '';
      els.aiConsent.checked = !!state.ai.consented;
      els.stdOpacity.value = T.clamp(state.current.panelOpacity ?? 0.88, 0.82, 1);
      els.stdBlur.value = Math.round(T.clamp(state.current.blur ?? 24, 0, 40));
      els.stdScrim.value = T.clamp(state.current.scrim ?? 0.30, 0.2, 0.6);
      els.followSystem.checked = !!state.followSystem;
      syncTuningLabels();
      syncAdvanced();

      if (boot.fresh) {
        // 首启默认启用一张内置壁纸：浮岛构图首屏即完整，留白区不再是死黑
        state.current.background = 'builtin:wall-1';
        await loadStdImage();
        await regenerateFromImage();
        await persist();
      } else {
        await loadStdImage();
        await applyCurrent();
      }
      renderThemeList();
      syncAiGate();
    },
  };
})();
