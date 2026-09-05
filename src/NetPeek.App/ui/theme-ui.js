// 外观屏交互层（§2.7）：这一屏是「屏」，不是覆盖层 —— 上一版把被调的界面压暗 45%
// 再在上面调颜色，等于在失真的画面上取色。现在留白区和其余三岛都还在画面里，
// 改不透明度或语义色时它们当场变，不需要造一张假的预览卡片。
//
// 状态结构（camelCase，与 Rust 持久化的 JSON 一致）：
// {
//   mode: 'standard' | 'ai' | 'custom',
//   themes: { name: theme }, active: 'name',
//   standard: { panelOpacity, blur, scrim },
//   ai: { provider: { endpoint, apiKey, model }, consented },
//   custom: 未保存的定制中令牌, pendingBackground: 已落盘的背景路径
// }

(function () {
  const T = window.NetPeekTheme;
  const $ = (id) => document.getElementById(id);

  const SWATCH_IDS = ['cBg', 'cPanel', 'cText', 'cMuted', 'cDown', 'cUp', 'cOk', 'cWarn', 'cError', 'cBorder'];
  const SWATCH_TO_TOKEN = {
    cBg: 'bg', cPanel: 'panel', cText: 'text', cMuted: 'muted', cDown: 'down',
    cUp: 'up', cOk: 'ok', cWarn: 'warn', cError: 'error', cBorder: 'border',
  };

  const els = {
    modes: Array.from(document.querySelectorAll('input[name="tmode"]')),
    modeNote: document.getElementById('modeNote'),
    bgThumb: $('bgThumb'),
    bgPick: $('bgPick'),
    bgClear: $('bgClear'),
    bgFile: $('bgFile'),
    bgStatus: $('bgStatus'),
    opacity: $('stdOpacity'),
    scrim: $('stdScrim'),
    blur: $('stdBlur'),
    opValue: $('opValue'),
    scrimValue: $('scrimValue'),
    blurValue: $('blurValue'),
    aiSection: $('aiSection'),
    aiEndpoint: $('aiEndpoint'),
    aiApiKey: $('aiApiKey'),
    aiModel: $('aiModel'),
    aiConsent: $('aiConsent'),
    aiGenerate: $('aiGenerate'),
    aiStatus: $('aiStatus'),
    presets: Array.from(document.querySelectorAll('[data-preset]')),
    themeName: $('themeName'),
    themeSave: $('themeSave'),
    themeList: $('themeList'),
    themeReset: $('themeReset'),
  };
  SWATCH_IDS.forEach((id) => { els[id] = $(id); });

  let state = null;
  let storage = null;
  let bgDataUrl = '';   // 当前背景的 data URL（已解析，直接给 CSS / AI 请求用）
  let stdImage = null;  // 标准模式当前图片的 ImageData，无背景时 null

  // ---------- 应用主题（含背景解析） ----------

  function tuning() {
    return {
      panelOpacity: parseFloat(els.opacity.value),
      blur: parseInt(els.blur.value, 10),
      scrim: parseFloat(els.scrim.value),
    };
  }

  function syncTuningLabels() {
    els.opValue.textContent = parseFloat(els.opacity.value).toFixed(2);
    els.scrimValue.textContent = parseFloat(els.scrim.value).toFixed(2);
    // 不透明度和压暗是比例，模糊半径是长度，得带单位才知道量级
    els.blurValue.textContent = `${els.blur.value} px`;
  }

  async function applyWithBg(theme) {
    let bg = theme.background || '';
    if (bg && !bg.startsWith('data:')) {
      try { bg = await storage.readBackground(bg); } catch { bg = ''; }
    }
    bgDataUrl = bg;
    T.applyTheme({ ...theme, background: bg });
    els.bgStatus.textContent = bg ? '已设置背景图' : '未设置背景（使用面板底色）';
    els.bgStatus.className = 'note truncate';
  }

  // ---------- 标准模式：从背景图取色 ----------

  async function loadImageData(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const max = 512; // 缩到 ≤512px 保证取色速度
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        resolve(ctx.getImageData(0, 0, w, h));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function runStandard() {
    const theme = stdImage ? T.tokensFromImage(stdImage) : T.tokensFromPreset('dark');
    theme.source = 'standard';
    Object.assign(theme, tuning());
    theme.background = bgDataUrl;
    theme.tokens = T.validateTokens(theme.tokens);
    fillSwatches(theme.tokens);
    await applyWithBg(theme);
  }

  // ---------- 定制化模式 ----------

  function swatchTokens() {
    const tokens = {};
    for (const id of SWATCH_IDS) tokens[SWATCH_TO_TOKEN[id]] = els[id].value;
    return tokens;
  }

  function fillSwatches(tokens) {
    for (const id of SWATCH_IDS) {
      const v = tokens[SWATCH_TO_TOKEN[id]];
      if (/^#[0-9a-f]{6}$/i.test(v || '')) els[id].value = v;
    }
  }

  async function runCustom() {
    const theme = { source: 'custom', background: bgDataUrl, ...tuning() };
    theme.tokens = T.validateTokens(swatchTokens());
    fillSwatches(theme.tokens);
    await applyWithBg(theme);
  }

  // ---------- AI 模式 ----------

  function syncAiGate() {
    // 未勾选授权时「生成并应用」是 disabled 态，不是点了报错（§2.7）
    els.aiGenerate.disabled = !els.aiConsent.checked || !bgDataUrl;
  }

  async function runAi() {
    els.aiStatus.textContent = 'AI 生成中…';
    els.aiStatus.className = 'note';
    try {
      const res = await T.aiGenerate({
        endpoint: els.aiEndpoint.value.trim(),
        apiKey: els.aiApiKey.value.trim(),
        model: els.aiModel.value.trim(),
      }, bgDataUrl);
      const theme = {
        source: 'ai',
        background: bgDataUrl,
        tokens: T.validateTokens(res.tokens),
        panelOpacity: T.clamp(res.panelOpacity, 0.82, 1),
        blur: T.clamp(res.blur, 0, 40),
        scrim: tuning().scrim,
      };
      els.opacity.value = theme.panelOpacity;
      els.blur.value = Math.round(theme.blur);
      syncTuningLabels();
      fillSwatches(theme.tokens);
      await applyWithBg(theme);
      state.aiApplied = true;
      els.aiStatus.textContent = '已应用，可在右侧命名保存到主题列表';
      els.aiStatus.className = 'note is-ok';
    } catch (err) {
      els.aiStatus.textContent = `AI 失败（${err.message}），已回退标准离线取色`;
      els.aiStatus.className = 'note is-error';
      await runStandard();
    }
  }

  // ---------- 模式切换 ----------

  // 语义色只在定制化模式可编辑；其余模式它们展示的是取色/AI 推出来的结果。
  function setSwatchesEditable(on) {
    for (const id of SWATCH_IDS) {
      const locked = id === 'cDown' || id === 'cUp';
      els[id].disabled = !on || locked;
      els[id].closest('.swatch').style.opacity = on ? '' : '0.4';
    }
    els.presets.forEach((b) => { b.disabled = !on; });
  }

  // 分段控件只放得下三个词，模式之间的差别写在下面这行说明里
  const MODE_NOTES = {
    standard: '从背景图提主色，自动生成强调色与文字明暗。完全离线、即时生效。',
    ai: '把背景缩略图交给多模态模型生成整套配色，可命名保存复用；失败自动回退标准取色。',
    custom: '内置预设起步，语义色逐项手调。下载与上传两色语义锁定，不可改。',
  };

  async function setMode(mode, opts = {}) {
    state.mode = mode;
    els.modes.forEach((r) => { r.checked = r.value === mode; });
    if (els.modeNote) els.modeNote.textContent = MODE_NOTES[mode] || '';
    els.aiSection.hidden = mode !== 'ai';
    els.aiSection.style.display = mode === 'ai' ? 'flex' : 'none';
    setSwatchesEditable(mode === 'custom');
    if (opts.silent) return;
    if (mode === 'custom') await runCustom();
    else await runStandard(); // AI 模式在生成前先用标准取色占位预览
    persist();
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
      item.querySelector('[data-act="rename"]').addEventListener('click', () => renameTheme(name));
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
    state.pendingBackground = th.background || '';
    els.opacity.value = T.clamp(th.panelOpacity ?? 0.88, 0.82, 1);
    els.blur.value = Math.round(T.clamp(th.blur ?? 24, 0, 40));
    els.scrim.value = T.clamp(th.scrim ?? 0.30, 0.2, 0.6);
    syncTuningLabels();
    if (th.tokens) fillSwatches(th.tokens);
    await applyWithBg(th);
    if (th.background) stdImage = await loadImageData(bgDataUrl);
    await setMode(th.source === 'ai' ? 'ai' : th.source === 'standard' ? 'standard' : 'custom', { silent: true });
    renderThemeList();
    persist();
  }

  function renameTheme(name) {
    const next = prompt('新名称：', name);
    const trimmed = (next || '').trim();
    if (!trimmed || trimmed === name) return;
    state.themes[trimmed] = { ...state.themes[name], name: trimmed };
    if (state.active === name) state.active = trimmed;
    delete state.themes[name];
    renderThemeList();
    persist();
  }

  function deleteTheme(name) {
    if (name === 'default') {
      els.bgStatus.textContent = '默认主题不能删除';
      els.bgStatus.className = 'note is-warn';
      return;
    }
    delete state.themes[name];
    if (state.active === name) state.active = 'default';
    renderThemeList();
    persist();
  }

  // 当前生效主题（用于保存到列表）
  function currentTheme() {
    const base = { ...tuning(), background: state.pendingBackground || bgDataUrl || '' };
    if (state.mode === 'standard') {
      const th = stdImage ? T.tokensFromImage(stdImage) : T.tokensFromPreset('dark');
      return { ...th, ...base, source: 'standard', tokens: T.validateTokens(th.tokens) };
    }
    if (state.mode === 'ai') {
      return { ...base, source: 'ai', tokens: T.validateTokens(swatchTokens()) };
    }
    return { ...base, source: 'custom', tokens: T.validateTokens(swatchTokens()) };
  }

  async function persist() {
    if (!storage) return;
    state.standard = tuning();
    try { await storage.save(state); } catch { /* 持久化失败不阻塞预览 */ }
  }

  // ---------- 事件绑定 ----------

  els.modes.forEach((r) => {
    r.addEventListener('change', () => { if (r.checked) setMode(r.value); });
  });

  els.bgPick.addEventListener('click', () => els.bgFile.click());
  els.bgFile.addEventListener('change', async () => {
    const file = els.bgFile.files[0];
    if (!file) return;
    const dataUrl = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(file);
    });
    try {
      // 落盘到应用数据目录，避免配置 JSON 无限膨胀
      state.pendingBackground = await storage.saveBackground(dataUrl);
      bgDataUrl = dataUrl;
      stdImage = await loadImageData(dataUrl);
      els.bgStatus.textContent = `已选择 ${file.name}`;
      els.bgStatus.className = 'note truncate';
      syncAiGate();
      if (state.mode === 'custom') await runCustom();
      else await runStandard();
      persist();
    } catch (err) {
      els.bgStatus.textContent = `背景加载失败：${err.message}`;
      els.bgStatus.className = 'note is-error';
    }
  });

  els.bgClear.addEventListener('click', async () => {
    state.pendingBackground = '';
    bgDataUrl = '';
    stdImage = null;
    syncAiGate();
    if (state.mode === 'custom') await runCustom();
    else await runStandard();
    persist();
  });

  for (const input of [els.opacity, els.scrim, els.blur]) {
    input.addEventListener('input', () => {
      syncTuningLabels();
      if (state.mode === 'custom') runCustom();
      else runStandard();
      persist();
    });
  }

  els.presets.forEach((b) => {
    b.addEventListener('click', () => {
      fillSwatches(T.tokensFromPreset(b.dataset.preset).tokens);
      runCustom();
      persist();
    });
  });

  SWATCH_IDS.forEach((id) => {
    els[id].addEventListener('input', () => { runCustom(); persist(); });
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
    state.themes[name] = { ...currentTheme(), name };
    state.active = name;
    els.themeName.value = '';
    renderThemeList();
    persist();
  });

  els.themeReset.addEventListener('click', async () => {
    const def = T.tokensFromPreset('dark');
    state.mode = 'standard';
    state.themes = { default: { ...def, name: '默认深色', source: 'custom' } };
    state.active = 'default';
    state.pendingBackground = '';
    state.aiApplied = false;
    stdImage = null;
    bgDataUrl = '';
    els.opacity.value = 0.88;
    els.blur.value = 24;
    els.scrim.value = 0.30;
    syncTuningLabels();
    fillSwatches(def.tokens);
    await setMode('standard');
    renderThemeList();
    await persist();
  });

  // ---------- 启动 ----------

  window.NetPeekThemeUI = {
    // 留白区的「选择背景图」按钮直接借这条路径，不重复实现一遍取图
    pickBackground() { els.bgFile.click(); },

    async init() {
      const boot = await T.initTheme();
      state = boot.state;
      storage = boot.storage;

      els.aiEndpoint.value = state.ai.provider.endpoint || '';
      els.aiApiKey.value = state.ai.provider.apiKey || '';
      els.aiModel.value = state.ai.provider.model || '';
      els.aiConsent.checked = !!state.ai.consented;
      els.opacity.value = T.clamp(state.standard.panelOpacity ?? 0.88, 0.82, 1);
      els.blur.value = Math.round(T.clamp(state.standard.blur ?? 24, 0, 40));
      els.scrim.value = T.clamp(state.standard.scrim ?? 0.30, 0.2, 0.6);
      syncTuningLabels();

      const active = boot.fresh ? null : (state.themes[state.active] || Object.values(state.themes)[0]);
      if (active) {
        await useTheme(active.name && state.themes[active.name] ? active.name : state.active);
      } else {
        await setMode('standard');
        renderThemeList();
      }
      syncAiGate();
    },
  };
})();

