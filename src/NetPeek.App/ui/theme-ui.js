// 三模式主题面板的 UI 交互层（依赖 theme.js 引擎）。
// 状态结构（camelCase，与 Rust 持久化的 JSON 一致）：
// {
//   mode: 'standard' | 'ai' | 'custom',
//   themes: { name: theme },
//   active: 'name',
//   standard: { panelOpacity, blur },
//   ai: { provider: { endpoint, apiKey, model }, consented },
//   custom: tokens(未保存的定制中状态),
//   pendingBackground: '' | 已落盘的背景路径
// }

(function () {
  const T = window.NetPeekTheme;
  const $ = (id) => document.getElementById(id);

  const els = {
    overlay: $('themeOverlay'),
    btn: $('themeBtn'),
    close: $('themeClose'),
    modes: Array.from(document.querySelectorAll('input[name="tmode"]')),
    bgSection: $('bgSection'),
    bgPick: $('bgPick'),
    bgClear: $('bgClear'),
    bgFile: $('bgFile'),
    bgStatus: $('bgStatus'),
    stdSection: $('stdSection'),
    stdOpacity: $('stdOpacity'),
    stdBlur: $('stdBlur'),
    aiSection: $('aiSection'),
    aiEndpoint: $('aiEndpoint'),
    aiApiKey: $('aiApiKey'),
    aiModel: $('aiModel'),
    aiConsent: $('aiConsent'),
    aiGenerate: $('aiGenerate'),
    aiStatus: $('aiStatus'),
    customSection: $('customSection'),
    presets: Array.from(document.querySelectorAll('.preset[data-preset]')),
    cBg: $('cBg'), cPanel: $('cPanel'), cBorder: $('cBorder'),
    cText: $('cText'), cMuted: $('cMuted'),
    cDown: $('cDown'), cUp: $('cUp'),
    cOk: $('cOk'), cWarn: $('cWarn'), cError: $('cError'),
    themeName: $('themeName'),
    themeSave: $('themeSave'),
    themeList: $('themeList'),
    themeReset: $('themeReset'),
  };

  let state = null;
  let storage = null;
  // 当前背景的 data URL（已解析，直接用于 CSS / AI 请求）
  let bgDataUrl = '';
  // 标准模式当前图片（ImageData），无背景时为 null
  let stdImage = null;

  // ---------- 应用主题（含背景解析） ----------

  async function applyWithBg(theme) {
    let bg = theme.background || '';
    if (bg && !bg.startsWith('data:')) {
      try { bg = await storage.readBackground(bg); } catch { bg = ''; }
    }
    bgDataUrl = bg;
    T.applyTheme({ ...theme, background: bg });
    els.bgStatus.textContent = bg ? '已设置背景图' : '未设置背景（使用面板底色）';
  }

  // ---------- 标准模式：取色 ----------

  async function loadImageData(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // 缩到 ≤512px 保证取色速度
        const max = 512;
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

  // 标准模式：从当前背景（或默认深色）生成并应用
  async function runStandard() {
    const tokensTheme = stdImage
      ? T.tokensFromImage(stdImage)
      : T.tokensFromPreset('dark');
    tokensTheme.panelOpacity = parseFloat(els.stdOpacity.value);
    tokensTheme.blur = parseInt(els.stdBlur.value, 10);
    tokensTheme.background = bgDataUrl;
    tokensTheme.tokens = T.validateTokens(tokensTheme.tokens);
    await applyWithBg(tokensTheme);
  }

  // ---------- 定制化模式 ----------

  function customFromInputs() {
    return {
      source: 'custom',
      background: bgDataUrl,
      tokens: {
        bg: els.cBg.value, panel: els.cPanel.value, border: els.cBorder.value,
        text: els.cText.value, muted: els.cMuted.value,
        down: els.cDown.value, up: els.cUp.value,
        ok: els.cOk.value, warn: els.cWarn.value, error: els.cError.value,
      },
      panelOpacity: 1,
      blur: 0,
    };
  }

  function fillColorInputs(tokens) {
    els.cBg.value = tokens.bg;
    els.cPanel.value = tokens.panel;
    els.cBorder.value = tokens.border;
    els.cText.value = tokens.text;
    els.cMuted.value = tokens.muted;
    els.cDown.value = tokens.down;
    els.cUp.value = tokens.up;
    els.cOk.value = tokens.ok;
    els.cWarn.value = tokens.warn;
    els.cError.value = tokens.error;
  }

  async function runCustom() {
    const theme = customFromInputs();
    theme.tokens = T.validateTokens(theme.tokens);
    fillColorInputs(theme.tokens);
    await applyWithBg(theme);
  }

  // ---------- AI 模式 ----------

  async function runAi() {
    els.aiStatus.textContent = '';
    els.aiStatus.className = 'tnote';
    if (!els.aiConsent.checked) {
      els.aiStatus.textContent = '请先勾选「缩略图上传」授权';
      els.aiStatus.className = 'tnote err';
      return;
    }
    if (!bgDataUrl) {
      els.aiStatus.textContent = '请先选择一张背景图';
      els.aiStatus.className = 'tnote err';
      return;
    }
    const provider = {
      endpoint: els.aiEndpoint.value.trim(),
      apiKey: els.aiApiKey.value.trim(),
      model: els.aiModel.value.trim(),
    };
    els.aiStatus.textContent = 'AI 生成中…';
    try {
      const res = await T.aiGenerate(provider, bgDataUrl);
      const theme = {
        source: 'ai',
        background: bgDataUrl,
        tokens: T.validateTokens(res.tokens),
        panelOpacity: res.panelOpacity,
        blur: res.blur,
      };
      await applyWithBg(theme);
      els.aiStatus.textContent = '已应用（可命名保存到主题列表）';
      els.aiStatus.className = 'tnote ok';
    } catch (err) {
      // 失败自动回退标准模式
      els.aiStatus.textContent = `AI 失败（${err.message}），已回退标准离线取色`;
      els.aiStatus.className = 'tnote err';
      await runStandard();
    }
  }

  // ---------- 模式切换 ----------

  function setMode(mode) {
    state.mode = mode;
    els.modes.forEach((r) => { r.checked = r.value === mode; });
    const showAi = mode === 'ai';
    els.aiSection.hidden = !showAi;
    els.customSection.hidden = mode !== 'custom';
    els.stdSection.hidden = mode === 'custom';
    // 背景区三种模式都可用（定制化模式也可附带背景？按设计模式 3 不依赖背景 → 隐藏）
    els.bgSection.hidden = mode === 'custom';
    if (mode === 'standard') runStandard();
    if (mode === 'custom') runCustom();
    if (mode === 'ai') {
      // AI 未生成前先用标准取色占位预览
      if (!state.aiApplied) runStandard();
    }
    persist();
  }

  // ---------- 主题列表 ----------

  function renderThemeList() {
    const frag = document.createDocumentFragment();
    const names = Object.keys(state.themes || {});
    for (const name of names) {
      const th = state.themes[name];
      const item = document.createElement('div');
      item.className = 'titem' + (state.active === name ? ' active' : '');
      const tag = th.source === 'ai' ? 'AI' : (th.source === 'standard' ? '取色' : '定制');
      item.innerHTML = `
        <span class="tname">${name}</span>
        <span class="tag">${tag}</span>
        <button class="tact" data-act="use" title="应用">✓</button>
        <button class="tact" data-act="rename" title="重命名">✎</button>
        <button class="tact" data-act="delete" title="删除">🗑</button>`;
      item.querySelector('[data-act="use"]').addEventListener('click', async () => {
        state.active = name;
        await applyWithBg(th);
        // 同步滑杆与取色器状态
        els.stdOpacity.value = th.panelOpacity ?? 0.92;
        els.stdBlur.value = th.blur ?? 12;
        if (th.tokens) fillColorInputs(th.tokens);
        setModeUIFromTheme(th);
        renderThemeList();
        persist();
      });
      item.querySelector('[data-act="rename"]').addEventListener('click', () => {
        const nn = prompt('新名称：', name);
        if (nn && nn.trim() && nn.trim() !== name) {
          state.themes[nn.trim()] = { ...state.themes[name], name: nn.trim() };
          if (state.active === name) state.active = nn.trim();
          delete state.themes[name];
          renderThemeList();
          persist();
        }
      });
      item.querySelector('[data-act="delete"]').addEventListener('click', () => {
        if (!confirm(`删除主题「${name}」？`)) return;
        delete state.themes[name];
        if (state.active === name) state.active = 'default';
        renderThemeList();
        persist();
      });
      frag.appendChild(item);
    }
    els.themeList.replaceChildren(frag);
  }

  function setModeUIFromTheme(th) {
    if (th.source === 'standard') {
      setMode('standard');
    } else if (th.source === 'ai') {
      setMode('ai');
      state.aiApplied = true;
      els.aiStatus.textContent = '已应用 AI 主题（可重新生成）';
      els.aiStatus.className = 'tnote ok';
    } else {
      setMode('custom');
    }
  }

  async function persist() {
    if (!storage) return;
    try { await storage.save(state); } catch { /* 持久化失败不阻塞预览 */ }
  }

  // ---------- 事件绑定 ----------

  els.btn.addEventListener('click', () => { els.overlay.hidden = false; });
  els.close.addEventListener('click', () => { els.overlay.hidden = true; });
  els.overlay.addEventListener('click', (e) => {
    if (e.target === els.overlay) els.overlay.hidden = true;
  });

  els.modes.forEach((r) => {
    r.addEventListener('change', () => {
      if (r.checked) setMode(r.value);
    });
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
      const path = await storage.saveBackground(dataUrl);
      state.pendingBackground = path;
      bgDataUrl = dataUrl;
      stdImage = await loadImageData(dataUrl);
      els.bgStatus.textContent = `已选择 ${file.name}`;
      if (state.mode === 'standard') await runStandard();
      if (state.mode === 'ai') await runStandard(); // 占位预览
      persist();
    } catch (err) {
      els.bgStatus.textContent = `背景加载失败：${err.message}`;
      els.bgStatus.className = 'tnote err';
    }
  });

  els.bgClear.addEventListener('click', async () => {
    state.pendingBackground = '';
    bgDataUrl = '';
    stdImage = null;
    els.bgStatus.textContent = '未设置背景（使用面板底色）';
    els.bgStatus.className = 'tnote';
    await runStandard();
    persist();
  });

  els.stdOpacity.addEventListener('input', () => { state.standard.panelOpacity = parseFloat(els.stdOpacity.value); runStandard(); persist(); });
  els.stdBlur.addEventListener('input', () => { state.standard.blur = parseInt(els.stdBlur.value, 10); runStandard(); persist(); });

  els.presets.forEach((b) => {
    b.addEventListener('click', () => {
      const preset = T.tokensFromPreset(b.dataset.preset);
      fillColorInputs(preset.tokens);
      runCustom();
      persist();
    });
  });

  ['cBg', 'cPanel', 'cBorder', 'cText', 'cMuted', 'cDown', 'cUp', 'cOk', 'cWarn', 'cError'].forEach((id) => {
    els[id].addEventListener('input', () => { runCustom(); persist(); });
  });

  els.aiGenerate.addEventListener('click', () => {
    state.ai.provider = {
      endpoint: els.aiEndpoint.value.trim(),
      apiKey: els.aiApiKey.value.trim(),
      model: els.aiModel.value.trim(),
    };
    state.ai.consented = els.aiConsent.checked;
    runAi();
    persist();
  });

  els.themeSave.addEventListener('click', async () => {
    const name = els.themeName.value.trim();
    if (!name) { alert('请输入主题名称'); return; }
    const current = state.mode === 'ai' && state.aiApplied
      ? await currentAiTheme()
      : await currentTheme();
    if (!current) { alert('当前没有可保存的主题，请先生成/调整'); return; }
    state.themes[name] = { ...current, name };
    state.active = name;
    els.themeName.value = '';
    renderThemeList();
    persist();
  });

  // 当前生效主题（用于保存）
  async function currentTheme() {
    if (state.mode === 'standard') {
      const th = stdImage ? T.tokensFromImage(stdImage) : T.tokensFromPreset('dark');
      th.tokens = T.validateTokens(th.tokens);
      th.panelOpacity = parseFloat(els.stdOpacity.value);
      th.blur = parseInt(els.stdBlur.value, 10);
      th.background = state.pendingBackground || bgDataUrl;
      return th;
    }
    if (state.mode === 'custom') {
      const th = customFromInputs();
      th.tokens = T.validateTokens(th.tokens);
      th.background = state.pendingBackground || '';
      return th;
    }
    return null; // ai 由 currentAiTheme 处理
  }

  async function currentAiTheme() {
    const th = T.cloneTheme(state.themes[state.active]);
    if (th && th.source === 'ai') return th;
    // 最近一次 AI 结果没有存为列表项时，从当前生效令牌构造
    const tokens = {};
    ['bg', 'panel', 'border', 'text', 'muted', 'down', 'up', 'ok', 'warn', 'error'].forEach((k) => {
      tokens[k] = getComputedStyle(document.documentElement).getPropertyValue(`--${k}`).trim() || undefined;
    });
    return {
      source: 'ai',
      tokens: T.validateTokens(tokens),
      panelOpacity: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--panel-opacity')) || 0.92,
      blur: parseInt(getComputedStyle(document.documentElement).getPropertyValue('--blur'), 10) || 12,
      background: state.pendingBackground || '',
    };
  }

  els.themeReset.addEventListener('click', async () => {
    const def = T.tokensFromPreset('dark');
    state.mode = 'standard';
    state.themes = { default: { ...def, name: '默认深色', source: 'custom' } };
    state.active = 'default';
    state.pendingBackground = '';
    stdImage = null;
    bgDataUrl = '';
    els.stdOpacity.value = 0.92;
    els.stdBlur.value = 12;
    fillColorInputs(def.tokens);
    setMode('standard');
    renderThemeList();
    await persist();
  });

  // ---------- 启动 ----------

  window.NetPeekThemeUI = {
    async init() {
      const boot = await T.initTheme();
      state = boot.state;
      storage = boot.storage;

      // 回填 UI 控件
      els.aiEndpoint.value = state.ai.provider.endpoint || '';
      els.aiApiKey.value = state.ai.provider.apiKey || '';
      els.aiModel.value = state.ai.provider.model || '';
      els.aiConsent.checked = !!state.ai.consented;
      if (state.standard) {
        els.stdOpacity.value = state.standard.panelOpacity ?? 0.92;
        els.stdBlur.value = state.standard.blur ?? 12;
      }

      // 首次运行（无保存配置）：默认标准离线取色模式，无背景时用内置深色兜底。
      if (boot.fresh) {
        els.modes.forEach((r) => { r.checked = r.value === 'standard'; });
        els.customSection.hidden = true;
        els.bgSection.hidden = false;
        stdImage = null;
        bgDataUrl = '';
        await runStandard();
        renderThemeList();
        return;
      }

      // 应用当前激活主题（含背景图解析）
      const active = state.themes[state.active] || Object.values(state.themes)[0];
      if (active) {
        state.pendingBackground = active.background || '';
        if (active.tokens) fillColorInputs(active.tokens);
        await applyWithBg(active);
        setModeUIFromTheme(active);
        if (active.background) {
          stdImage = await loadImageData(bgDataUrl);
        }
      } else {
        setMode('standard');
      }
      renderThemeList();
    },
  };
})();
