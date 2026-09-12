// 外观（皮肤）交互层。皮肤 = 整套 17 键 token 的预设包，结构与布局不变。
//
// 界面分三块（index.html 设置屏 · 外观分区）：
//   1. skinCards：四张内置皮肤卡（朴素 / 浅色 / 琥珀 / 跟随背景图），点卡即切；
//   2. imageSkinBlock：「跟随背景图」专属 —— 选图、取色、三滑块（不透明/模糊/压暗）、AI 取色；
//   3. customSkinBlock：自定义编辑器 —— 在当前生效颜色上改单键、当场预览、命名另存。
//
// 状态结构（theme.js defaultState，与 Rust 持久化的 JSON 一致）：
// {
//   skin: 'plain'|'light'|'amber'|'image'|自定义名,
//   backgroundImage, panelOpacity, bgBlur, scrim,
//   imageDraft: { tokens, source }, custom: { tokens } | null,
//   themes: { name: { name, tokens } }, ai: { provider, consented }
// }

(function () {
  const T = window.NetPeekTheme;
  const $ = (id) => document.getElementById(id);

  const SWATCH_IDS = ['cBg', 'cPanel', 'cText', 'cMuted', 'cAccent', 'cDown', 'cUp', 'cOk', 'cWarn', 'cError', 'cBorder'];
  const SWATCH_TO_TOKEN = {
    cBg: 'bg', cPanel: 'panel', cText: 'text', cMuted: 'text2', cAccent: 'accent',
    cDown: 'down', cUp: 'up', cOk: 'ok', cWarn: 'warn', cError: 'error', cBorder: 'line',
  };

  const els = {
    skinCards: Array.from(document.querySelectorAll('#skinCards .skin-card')),
    imageSkinBlock: $('imageSkinBlock'),
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
  let bgDataUrl = '';   // 当前背景的 data URL（已解析，直接给 CSS / 取色 / AI 请求用）
  let stdImage = null;  // 当前背景图的 ImageData，无背景时 null

  // ---------- 应用当前皮肤 ----------

  function currentTokens() {
    return T.resolveSkin(state).tokens;
  }

  // 编辑器草稿的颜色（没有草稿就等于当前生效颜色）
  function draftTokens() {
    return (state.custom && state.custom.tokens) || currentTokens();
  }

  function cloneTokens(t) {
    return JSON.parse(JSON.stringify(t));
  }

  // 把当前皮肤（含 image 背景解析）铺到界面上。
  async function applyCurrent() {
    const skin = T.resolveSkin(state);
    let bg = skin.background || '';
    if (bg && !bg.startsWith('data:')) {
      try { bg = await storage.readBackground(bg); } catch { bg = ''; }
    }
    bgDataUrl = bg;
    T.applyTokens(skin.tokens);
    T.applyBackdrop({
      background: bg,
      panelOpacity: skin.panelOpacity,
      bgBlur: skin.bgBlur,
      scrim: skin.scrim,
    });
    broadcastTokens(skin.tokens);
    if (state.skin === 'image') {
      els.bgStatus.textContent = bg ? '已设置背景图' : '未设置背景（使用面板底色）';
      els.bgStatus.className = 'note truncate';
    }
  }

  // 仅背景三滑块变化：颜色没变，不用广播令牌，重铺 backdrop 就够
  function applyBackdropOnly() {
    T.applyBackdrop({
      background: bgDataUrl,
      panelOpacity: state.panelOpacity,
      bgBlur: state.bgBlur,
      scrim: state.scrim,
    });
  }

  // 小窗是另一个 webview，documentElement 上的 CSS 变量不跨窗口继承，得把令牌广播过去
  // 它才跟着改。背景图剥掉：小窗不做 backdrop，data URL 底图有几 MB，没必要在事件里搬。
  // 节流是因为拖滑块 / 拖取色器每帧都会走一次应用。
  let broadcastTimer = 0;
  function broadcastTokens(tokens) {
    if (!window.__TAURI__) return;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      window.__TAURI__.event.emit('theme-changed', { tokens, background: '' }).catch(() => {});
    }, 120);
  }

  // ---------- 皮肤卡 ----------

  function renderSkinCards() {
    els.skinCards.forEach((card) => {
      const on = state.skin === card.dataset.skin;
      card.classList.toggle('is-on', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    els.imageSkinBlock.hidden = state.skin !== 'image';
  }

  async function selectSkin(id) {
    state.skin = id;
    state.active = id;
    renderSkinCards();
    if (id === 'image') await ensureImageDraft(); // 有图无草稿（旧配置迁移）→ 自动补取色
    await applyCurrent();
    fillSwatches(currentTokens());
    renderThemeList();
    persist();
  }

  // image 皮肤有背景但没有取色草稿 → 拿背景图自动跑一次本地取色。
  async function ensureImageDraft() {
    if (state.skin !== 'image' || state.imageDraft) return;
    if (!state.backgroundImage) return;
    let bg = state.backgroundImage;
    if (!bg.startsWith('data:')) {
      try { bg = await storage.readBackground(bg); } catch { return; }
    }
    const img = await loadImageData(bg);
    if (!img) return;
    bgDataUrl = bg;
    stdImage = img;
    state.imageDraft = { tokens: T.tokensFromImage(img), source: 'standard' };
  }

  // ---------- 背景图（image 皮肤） ----------

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

  function updateBgThumb() {
    if (bgDataUrl) {
      els.bgThumb.hidden = false;
      els.bgThumb.style.backgroundImage = `url("${bgDataUrl}")`;
    } else {
      els.bgThumb.hidden = true;
      els.bgThumb.style.backgroundImage = '';
    }
  }

  async function runImageColor() {
    const tokens = stdImage ? T.tokensFromImage(stdImage) : null;
    if (!tokens) return;
    state.imageDraft = { tokens, source: 'standard' };
    await applyCurrent();
    fillSwatches(tokens);
  }

  // ---------- AI 取色 ----------

  function syncAiGate() {
    // 未勾选授权 / 无背景图时「生成并应用」是 disabled 态，不是点了报错
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
      const tokens = T.validateSkin(T.convertLegacyTokens(res.tokens));
      state.imageDraft = { tokens, source: 'ai' };
      // AI 给的面板不透明度 / 模糊半径同步回滑块，所见即所存
      state.panelOpacity = T.clamp(res.panelOpacity, 0.82, 1);
      state.bgBlur = Math.round(T.clamp(res.blur, 0, 40));
      syncTuningLabels();
      els.opacity.value = state.panelOpacity;
      els.blur.value = state.bgBlur;
      await applyCurrent();
      fillSwatches(tokens);
      els.aiStatus.textContent = '已应用，可在下方编辑并另存为自己的皮肤';
      els.aiStatus.className = 'note is-ok';
    } catch (err) {
      els.aiStatus.textContent = `AI 失败（${err.message}），已回退本地取色`;
      els.aiStatus.className = 'note is-error';
      await runImageColor();
    }
  }

  // ---------- 自定义编辑器 ----------

  function fillSwatches(tokens) {
    for (const id of SWATCH_IDS) {
      const v = tokens[SWATCH_TO_TOKEN[id]];
      if (/^#[0-9a-f]{6}$/i.test(v || '')) els[id].value = v;
    }
  }

  function ensureCustomDraft() {
    if (!state.custom) state.custom = { tokens: cloneTokens(currentTokens()) };
    return state.custom.tokens;
  }

  // 草稿改动当场生效（预览态）；state.skin 不动，切走皮肤卡时草稿留在 state.custom 不丢
  async function applyDraft() {
    const tokens = draftTokens();
    T.applyTokens(tokens);
    T.applyBackdrop({ background: '', panelOpacity: 1, bgBlur: 0, scrim: 0 });
    broadcastTokens(tokens);
  }

  // ---------- 已另存的皮肤列表 ----------

  const { icon } = window.NetPeekCommon;
  const escapeHtml = window.NetPeekCommon.escapeHtml;

  function renderThemeList() {
    const frag = document.createDocumentFragment();
    for (const name of Object.keys(state.themes || {})) {
      const item = document.createElement('div');
      item.className = 'theme-item' + (state.skin === name ? ' is-active' : '');
      item.innerHTML = `
        <span class="name">${escapeHtml(name)}</span>
        <span class="tag">自定义</span>
        <span class="row-actions">
          <button type="button" class="icon-btn" data-act="use" title="应用" aria-label="应用皮肤">${icon('check')}</button>
          <button type="button" class="icon-btn" data-act="rename" title="重命名" aria-label="重命名皮肤">${icon('pencil')}</button>
          <button type="button" class="icon-btn" data-act="delete" title="删除" aria-label="删除皮肤">${icon('trash')}</button>
        </span>`;
      item.querySelector('[data-act="use"]').addEventListener('click', () => selectSkin(name));
      item.querySelector('[data-act="rename"]').addEventListener('click', () => renameSkin(name));
      item.querySelector('[data-act="delete"]').addEventListener('click', () => deleteSkin(name));
      frag.appendChild(item);
    }
    els.themeList.replaceChildren(frag);
  }

  function renameSkin(name) {
    const next = prompt('新名称：', name);
    const trimmed = (next || '').trim();
    if (!trimmed || trimmed === name) return;
    state.themes[trimmed] = { ...state.themes[name], name: trimmed };
    if (state.skin === name) { state.skin = trimmed; state.active = trimmed; }
    delete state.themes[name];
    renderThemeList();
    renderSkinCards();
    persist();
  }

  function deleteSkin(name) {
    delete state.themes[name];
    if (state.skin === name) selectSkin('plain');
    else { renderThemeList(); persist(); }
  }

  // ---------- 滑块 ----------

  function syncTuningLabels() {
    els.opValue.textContent = parseFloat(els.opacity.value).toFixed(2);
    els.scrimValue.textContent = parseFloat(els.scrim.value).toFixed(2);
    // 不透明度和压暗是比例，模糊半径是长度，得带单位才知道量级
    els.blurValue.textContent = `${els.blur.value} px`;
  }

  function pullSliders() {
    state.panelOpacity = T.clamp(els.opacity.value, 0.82, 1);
    state.bgBlur = Math.round(T.clamp(els.blur.value, 0, 40));
    state.scrim = T.clamp(els.scrim.value, 0.2, 0.6);
  }

  function pushSliders() {
    els.opacity.value = T.clamp(state.panelOpacity ?? 0.92, 0.82, 1);
    els.blur.value = Math.round(T.clamp(state.bgBlur ?? 0, 0, 40));
    els.scrim.value = T.clamp(state.scrim ?? 0.30, 0.2, 0.6);
    syncTuningLabels();
  }

  // ---------- 持久化 ----------

  async function persist() {
    if (!storage) return;
    try { await storage.save(state); } catch { /* 持久化失败不阻塞预览 */ }
  }

  // ---------- 事件绑定 ----------

  els.skinCards.forEach((card) => {
    card.addEventListener('click', () => selectSkin(card.dataset.skin));
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
      state.backgroundImage = await storage.saveBackground(dataUrl);
      bgDataUrl = dataUrl;
      stdImage = await loadImageData(dataUrl);
      updateBgThumb();
      els.bgStatus.textContent = `已选择 ${file.name}`;
      els.bgStatus.className = 'note truncate';
      syncAiGate();
      await runImageColor();
      persist();
    } catch (err) {
      els.bgStatus.textContent = `背景加载失败：${err.message}`;
      els.bgStatus.className = 'note is-error';
    }
  });

  els.bgClear.addEventListener('click', async () => {
    state.backgroundImage = '';
    state.imageDraft = null;
    bgDataUrl = '';
    stdImage = null;
    updateBgThumb();
    els.bgStatus.textContent = '未设置背景（使用面板底色）';
    els.bgStatus.className = 'note truncate';
    syncAiGate();
    await applyCurrent();
    fillSwatches(currentTokens());
    persist();
  });

  for (const input of [els.opacity, els.scrim, els.blur]) {
    input.addEventListener('input', () => {
      syncTuningLabels();
      pullSliders();
      applyBackdropOnly();
      persist();
    });
  }

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

  // 预设按钮：把内置皮肤整套倒进编辑器草稿，再逐键微调
  els.presets.forEach((b) => {
    b.addEventListener('click', () => {
      const preset = T.SKINS[b.dataset.preset];
      if (!preset) return;
      state.custom = { tokens: cloneTokens(preset.tokens) };
      fillSwatches(state.custom.tokens);
      applyDraft();
      persist();
    });
  });

  SWATCH_IDS.forEach((id) => {
    const locked = id === 'cDown' || id === 'cUp'; // 语义锁定：下载永远暖橙、上传永远钢蓝
    els[id].disabled = locked;
    els[id].addEventListener('input', () => {
      const tokens = ensureCustomDraft();
      tokens[SWATCH_TO_TOKEN[id]] = els[id].value;
      applyDraft();
      persist();
    });
  });

  els.themeSave.addEventListener('click', async () => {
    const name = els.themeName.value.trim();
    if (!name) {
      els.bgStatus.textContent = '请先给皮肤起个名字';
      els.bgStatus.className = 'note is-warn';
      return;
    }
    // 落库前校验一遍对比度；预览保持用户原值，应用另存皮肤时所见即所存
    const tokens = T.validateSkin(cloneTokens(draftTokens()));
    state.themes[name] = { name, tokens };
    els.themeName.value = '';
    await selectSkin(name);
  });

  els.themeReset.addEventListener('click', async () => {
    // 回到出厂皮肤；已另存的皮肤与背景图配置保留
    state.custom = null;
    await selectSkin('plain');
  });

  // ---------- 启动 ----------

  window.NetPeekThemeUI = {
    async init() {
      const boot = await T.initTheme();
      state = boot.state;
      storage = boot.storage;

      els.aiEndpoint.value = state.ai.provider.endpoint || '';
      els.aiApiKey.value = state.ai.provider.apiKey || '';
      els.aiModel.value = state.ai.provider.model || '';
      els.aiConsent.checked = !!state.ai.consented;
      pushSliders();

      if (state.skin === 'image') await ensureImageDraft();
      await applyCurrent();
      fillSwatches(currentTokens());
      renderSkinCards();
      renderThemeList();
      updateBgThumb();
      syncAiGate();
    },
  };
})();
