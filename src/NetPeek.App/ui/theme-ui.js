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
  const $ = (id) => window.NetPeekCommon.byId(id, 'theme-ui');

  const SWATCH_IDS = ['cBg', 'cPanel', 'cText', 'cMuted', 'cAccent', 'cDown', 'cUp', 'cOk', 'cWarn', 'cError', 'cBorder'];
  const SWATCH_TO_TOKEN = {
    cBg: 'bg', cPanel: 'panel', cText: 'text', cMuted: 'text2', cAccent: 'accent',
    cDown: 'down', cUp: 'up', cOk: 'ok', cWarn: 'warn', cError: 'error', cBorder: 'line',
  };
  // 守卫回执里的 token 键 → 取色器上那一格的名字。报「text2」没人知道是哪一格。
  const GUARD_LABELS = {
    text: '主文字', text2: '次要字', accent: '强调', accentInk: '强调底上的字',
    down: '下载', up: '上传', ok: '监控中', warn: '警告', error: '异常',
  };

  const els = {
    skinCards: Array.from(document.querySelectorAll('#skinCards .skin-card')),
    imageSkinBlock: $('imageSkinBlock'),
    customSkinBlock: $('customSkinBlock'),
    followSystem: $('followSystem'),
    followSystemWrap: $('followSystemWrap'),
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
    bgBrightness: $('bgBrightness'),
    bgBrightnessValue: $('bgBrightnessValue'),
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
    guardNote: $('guardNote'),
    wallGrid: $('wallGrid'),
    opFloorNote: $('opFloorNote'),
    uiOpacity: $('uiOpacity'),
    uiOpacityValue: $('uiOpacityValue'),
    themeEmpty: $('themeEmpty'),
    themeHint: $('themeHint'),
    palRow: $('palRow'),
    imageModeSeg: $('imageModeSeg'),
    backdropStyleSeg: $('backdropStyleSeg'),
    opRow: $('opRow'),
    blurRow: $('blurRow'),
    scrimRow: $('scrimRow'),
    wrapOpRow: $('wrapOpRow'),
    scrimLabel: $('scrimLabel'),
    opHint: $('opHint'),
    wrapOpacity: $('wrapOpacity'),
    wrapOpValue: $('wrapOpValue'),
  };
  SWATCH_IDS.forEach((id) => { els[id] = $(id); });

  let state = null;
  let storage = null;
  let bgDataUrl = '';   // 当前背景的 data URL（已解析，直接给 CSS / 取色 / AI 请求用）
  let stdImage = null;  // 当前背景图的 ImageData，无背景时 null
  let stdImgEl = null;  // 同一张图的元素引用（ColorThief 从可绘制元素取样）

  // ---------- 应用当前皮肤 ----------

  function currentTokens() {
    return T.resolveSkin(state).tokens;
  }

  // 编辑器草稿的颜色（没有草稿就等于当前生效颜色）。
  // 草稿在 state 里存的是 { core, overrides } 而不是一张展开好的 17 键表 ——
  // 见 theme.js 里 CORE_KEYS 那段：往展开表里单改一个键，8 个派生键会永远停在
  // 上一套底色上，把窗口底改成浅色后顶栏还是黑的。
  function draftTokens() {
    return T.composeDraft(state.custom) || currentTokens();
  }

  function cloneTokens(t) {
    return JSON.parse(JSON.stringify(t));
  }

  // 把当前皮肤（含 image 背景解析）铺到界面上。
  // 背景来源有三种写法，得分开处理：data URL（刚选的图）、内置壁纸的相对路径
  // （webview 直接就能加载），以及用户选图落盘后的绝对路径（要走 Rust 读回 data URL）。
  // 不区分的话，内置壁纸会被当成文件路径去读，必然失败 —— 表现是「点了壁纸没反应」。
  function isBuiltinWallpaper(p) {
    return T.WALLPAPERS.some((w) => w.src === p);
  }

  async function resolveBgUrl(p) {
    if (!p) return '';
    if (p.startsWith('data:') || isBuiltinWallpaper(p)) return p;
    try { return await storage.readBackground(p); } catch { return ''; }
  }

  // 纱是「压暗」还是「提亮」由皮肤方向决定：滑杆文案跟着换 —— 不然浅色皮肤上
  // 一个写着「压暗」的滑杆在往图上铺亮纱，说明和效果打架。
  function syncDirectionLabels(lightSkin) {
    if (els.scrimLabel) {
      els.scrimLabel.innerHTML = lightSkin
        ? '<b>背景亮纱</b><small>为底图叠加一层亮纱以统一观感</small>'
        : '<b>背景压暗</b><small>为底图叠加一层暗纱以提升文字对比度</small>';
      els.scrim.setAttribute('aria-label', lightSkin ? '背景亮纱' : '背景压暗');
    }
    if (els.opHint) {
      els.opHint.textContent = lightSkin
        ? '面板对底图的遮盖程度；面板背后会自动归一为浅色柔色以保持文字对比度'
        : '面板对底图的遮盖程度；面板背后会自动归一为暗色柔色以保持文字对比度';
    }
  }

  // 玻璃加固是否生效：**有底图就生效，置底 / 贴膜通吃**。
  // 没有底图时面板是实底（置底是 --bg、贴膜是纯 panel），出厂皮肤手写的字阶
  // （88/48/23）就是设计意图本身，把它推到合成面档位等于凭空改掉三套出厂皮肤。
  // 贴膜 + 底图：膜的等效合成走 wrapFloor 那条独立判据（浓度地板保证 text2 达标），
  // 但弱字阶与语义色不在那条判据里 —— 2026-09-15 实测贴膜地板面上 text3 只有
  // Lc 20–23、error 40–42。加固层对着「置底最不利面」校出来的字色在贴膜地板面上
  // 同样达标（贴膜地板面永远比置底最不利面更接近面板色，见回归里那条逐面扫描），
  // 所以贴膜直接复用同一份加固，不用为它另开一档目标。
  function glassHardenActive(bg) {
    return !!bg;
  }

  async function applyCurrent() {
    const skin = T.resolveSkin(state);
    const bg = await resolveBgUrl(skin.background || '');
    bgDataUrl = bg;
    const lightSkin = T.isLightSkin(skin.tokens);
    syncDirectionLabels(lightSkin);
    // 上屏用加固后的表，其余一切（透镜反解、守卫、色板、广播）仍用原始表。
    // 这样安排的依据：加固只动 text2/text3/语义色，而带的反解只看 text + panel/
    // panel-2 —— 两边的输入不相交，所以「加固不会反过来移动带」，也就不存在
    // 迭代收敛问题（回归里有一条幂等断言钉住这个性质）。
    const harden = glassHardenActive(bg)
      ? T.glassHardenTokens(skin.tokens)
      : { tokens: skin.tokens, adjusted: [] };
    T.applyTokens(harden.tokens);
    T.applyBackdrop({
      background: bg,
      panelOpacity: skin.panelOpacity,
      bgBlur: skin.bgBlur,
      brightness: state.bgBrightness,
      scrim: skin.scrim,
      tint: skin.tokens.bg,
      autoDim,
      style: state.backdropStyle,
      wrapOpacity: effectiveWrapOpacity(),
      lightSkin,
      lens: refreshLens(),
      tokens: skin.tokens,
    });
    // 小窗拿**加固后**的表。这条以前是反的（注释写着「小窗是透明窗 + 实底面板，
    // 没有合成面可言」），在小窗不铺底图的年代成立；现在小窗跟着铺同一张壁纸，
    // 它的面板同样是「漆 + 图」的合成面，再送原始表过去就是把主窗刚修好的
    // 弱字阶问题（text3 在合成面上只有 Lc 20–23）原样搬到小窗上。
    broadcastTokens(harden.tokens);
    if (state.skin === 'image') {
      els.bgStatus.textContent = bg ? '已设置背景图' : '未设置背景（使用面板底色）';
      els.bgStatus.className = 'note truncate';
    }
  }

  // 贴膜浓度守卫的地板（syncBackdropGuard 按底图亮度算出）——用户选的浓度低于
  // 它时,实际铺膜取地板值,滑杆保持用户的选择、提示条解释差值
  let wrapFloorVal = 0;
  function effectiveWrapOpacity() {
    if (state.backdropStyle !== 'wrap' || !stdImage) return state.wrapOpacity;
    return Math.max(Number(state.wrapOpacity) || 0.62, wrapFloorVal);
  }

  // 仅背景滑块变化：颜色没变，但小窗现在跟着铺同一张底图，那几个滑杆
  // （面板不透明度 / 模糊 / 压暗 / 亮度）全都是它的输入 —— 所以这条路也要广播。
  // 不广播的后果不是「慢一点」，而是「主窗拖完滑杆、小窗停在上一档参数」，
  // 两个窗口的同一张壁纸长得不一样。
  // autoDim / 贴膜地板都是可读性守卫的输出，跟着滑杆一起重铺。
  //
  // 加固后的字色也要跟着重写一次：它的目标底色是**带的最不利端上的合成面**，
  // 而带只由皮肤（text + panel/panel-2）决定 —— 三根滑杆都不动它。所以这里
  // 严格来说是幂等的重写（glassHardenTokens 内部有缓存，命中即返回）。
  // 留着它是为了「切换置底/贴膜」这条路径：模式一变，加固该不该生效就变了。
  function applyBackdropOnly() {
    const t = T.resolveSkin(state).tokens;
    const harden = glassHardenActive(bgDataUrl) ? T.glassHardenTokens(t).tokens : t;
    T.applyTokens(harden, { silent: true });
    T.applyBackdrop({
      background: bgDataUrl,
      panelOpacity: state.panelOpacity,
      bgBlur: state.bgBlur,
      brightness: state.bgBrightness,
      scrim: state.scrim,
      tint: T.resolveSkin(state).tokens.bg,
      autoDim,
      style: state.backdropStyle,
      wrapOpacity: effectiveWrapOpacity(),
      lightSkin: T.isLightSkin(T.resolveSkin(state).tokens),
      lens: refreshLens(),
      tokens: T.resolveSkin(state).tokens,
    });
    broadcastTokens(harden);
  }

  // 小窗是另一个 webview，documentElement 上的 CSS 变量不跨窗口继承，得把令牌
  // **和背景图**广播过去它才跟着改。
  //
  // 背景图以前在这里被剥成空串，理由是「小窗不做 backdrop，data URL 底图有几 MB，
  // 没必要在事件里搬」。前半句已经不成立（小窗把图铺在形态元素内部，见 mini.css）；
  // 后半句的量级也被 normalizeBackground 改小了：落盘前统一压成 ≤2560px 的 JPEG
  // q0.85，常见壁纸在 300–800 KB 一档，而这条事件只在换肤 / 换图 / 拖滑杆时发，
  // 节流 120ms —— 代价换来的是「两个窗口看起来是一套主题」。
  // 路径解析（读盘转 data URL）永远在这一侧做：小窗没有 storage，也不该有。
  //
  // 节流是因为拖滑块 / 拖取色器每帧都会走一次应用。最后一次广播不能悬在定时器里：
  // 拖到一半隐藏 / 关闭主窗，小窗会永远停在上一帧颜色 —— pagehide 时 flush。
  let broadcastTimer = 0;
  let pendingBroadcast = null;
  // 小窗要的 backdrop 参数。两种显示方式都发图：
  //   置底 —— 壁纸铺窗底、表面磨砂，参数就是三滑杆 + 守卫输出；
  //   贴膜 —— 壁纸按窗口坐标对齐贴在各表面上，小窗是另一个窗口对不齐坐标系，
  //     复刻不了「拼起来还是原图」，但**不贴图**的后果更糟（2026-09-19 用户报的
  //     「主窗有壁纸、小窗一块素色」正是这条）：小窗退回置底铺法（图铺在形态元素
  //     内部），漆浓度取贴膜浓度（effectiveWrapOpacity，含地板），参数对齐贴膜
  //     口径 —— 无纱（dim 0）、无自动补偿（auto 0）、无透镜（贴膜的膜不带透镜，
  //     saturate(1) 是 filter 列表里的合法无操作，不能发 'none' —— blur(0px) none
  //     是非法声明，整条 filter 会被丢弃，图完全不糊、亮度补偿也失效）。
  //     wrap: true 让小窗把底图模糊跟滑杆走（贴膜的膜是清晰的），
  //     置底模式则保底 16px（mini.css 的 --mini-blur，与主窗表面磨砂同档）。
  function backdropPayload() {
    const skin = T.resolveSkin(state);
    // 当前皮肤是否真的带图，以 resolveSkin 的出口为准，不看 bgDataUrl ——
    // 那个变量是「最后一次解析出来的图」，从「跟随背景图」切进自定义编辑器时
    // （applyDraft 那条路，主窗自己也是按无图铺的）它还留着上一张图的内容，
    // 照着它发就会出现「主窗已经撤图、小窗还铺着」的分叉。
    if (!skin.background) return { background: '', backdrop: null };
    const wrap = state.backdropStyle === 'wrap';
    const tokens = skin.tokens;
    const lightSkin = T.isLightSkin(tokens);
    // 透镜与主窗同一次反解：refreshLens() 的输入是图自己的灰范围 + 方向化纱浓度
    // + 亮度滑杆，三样都和主窗此刻用的是同一批值。反解不出来（图没解码完 / 图太平）
    // 时回落 lensOf(tokens)，与主窗 applyBackdrop 里那条回落同源。
    const lens = refreshLens() || T.lensOf(tokens);
    return {
      background: bgDataUrl || '',
      backdrop: {
        panelOpacity: wrap ? effectiveWrapOpacity() : state.panelOpacity,
        bgBlur: state.bgBlur,
        brightness: state.bgBrightness,
        dim: wrap ? 0 : T.effectiveScrim(state.scrim ?? 0.3, lightSkin),
        tint: T.scrimTint(tokens.bg, lightSkin),
        // 纱的方向色与主窗 --backdrop-veil 同一口径（CSS 里是 rgb(var(--veil) / a)，
        // 所以发的是 '255 255 255' / '0 0 0' 这种分量串，不是 hex）。
        veil: lightSkin ? '255 255 255' : '0 0 0',
        autoDim: wrap ? 0 : autoDim,
        // 贴膜的浓度地板已经折进 effectiveWrapOpacity()，floor 发 0 免得重复钳；
        // 置底的 panelOpFloor 与主窗同源。
        panelOpFloor: wrap ? 0 : panelOpFloor,
        wrap,
        // 透镜按 lensFilter 拼成成品 filter 串在发送端做完：小窗只消费，不需要
        // 也不该重新推导（推导要 tokens + 图直方图，那是主窗才有的输入）。
        lens: wrap ? 'saturate(1)' : T.lensFilter(lens),
      },
    };
  }
  function flushBroadcast() {
    clearTimeout(broadcastTimer);
    broadcastTimer = 0;
    if (!pendingBroadcast) return;
    const tokens = pendingBroadcast;
    pendingBroadcast = null;
    window.__TAURI__.event.emit('theme-changed', {
      tokens,
      uiOpacity: state.uiOpacity ?? 1,
      ...backdropPayload(),
    }).catch(() => {});
  }
  function broadcastTokens(tokens) {
    if (!window.__TAURI__) return;
    pendingBroadcast = tokens;
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(flushBroadcast, 120);
  }

  // ---------- 皮肤卡 ----------

  function renderSkinCards() {
    els.skinCards.forEach((card) => {
      const on = state.skin === card.dataset.skin;
      card.classList.toggle('is-on', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    els.imageSkinBlock.hidden = state.skin !== 'image';
    els.imageSkinBlock.classList.toggle('is-on', state.skin === 'image');
    // 编辑自定义草稿 / 选中另存皮肤时，四张内置卡没有一张亮着 —— 「我在哪」
    // 丢了。把「编辑中」的亮框挪到自定义块上，另存的哪张在列表里有选中态。
    const editingCustom = state.skin === 'custom' || !!(state.themes && state.themes[state.skin]);
    els.customSkinBlock.classList.toggle('is-on', editingCustom);
  }

  async function selectSkin(id) {
    state.skin = id;
    renderSkinCards();
    if (id === 'image') {
      await ensureImageDraft(); // 有图无草稿（旧配置迁移）→ 自动补取色
      // 换图换肤都会变漆层下限（--panel-op-floor），切走/切回都要刷新，
      // 否则上一张图的旧下限会一直钉住面板不透明度
      syncBackdropGuard();
    }
    await applyCurrent();
    fillSwatches(currentTokens());
    renderPalette();
    renderImageMode();
    renderBackdropStyle();
    renderThemeList();
    schedulePersist();
  }

  // image 皮肤有背景但没有取色草稿 → 拿背景图自动跑一次本地取色。
  // 草稿在也要把图像数据补进内存：syncBackdropGuard 要靠 stdImage 算下限，而它只
  // 活在内存里，重启后是空的 —— 不补的话守卫静默失明，亮图上把滑块拖到底
  // 就是看不见的字（实测最差对比度 1.0x）。
  async function ensureImageDraft() {
    if (state.skin !== 'image' || !state.backgroundImage) return;
    if (!stdImage) {
      const bg = await resolveBgUrl(state.backgroundImage);
      if (!bg) return;
      const img = await loadImageData(bg);
      if (!img) return;
      bgDataUrl = bg;
      stdImage = img;
    }
    if (!state.imageDraft) {
      state.imageDraft = {
        tokens: T.tokensFromImage(stdImage, stdImgEl, state.imageMode),
        source: 'standard',
        rev: T.DERIVE_REV,
        palette: T.extractImagePalette(stdImage, stdImgEl),
      };
    } else if (!Array.isArray(state.imageDraft.palette) || !state.imageDraft.palette.length) {
      // 旧版草稿没有色板（强调色点选是后加的）：图像已在内存里就顺手补一份
      state.imageDraft.palette = T.extractImagePalette(stdImage, stdImgEl);
    }
  }

  // ---------- 背景图（image 皮肤） ----------

  // 落盘前把图规整成 ≤2560px 的 JPEG：4K/8K 原图动辄 5–15MB，原样落盘 +
  // 每次启动整份 base64 过 IPC 回读，启动与内存都吃亏。背景图的两个用途
  // （铺底、取色）都用不到超过 2560 的细节；取色那边自己还会缩到 512。
  // 副作用说清楚：GIF 动图取首帧、SVG 栅格化、透明 PNG 按 JPEG 规则落到黑底。
  // 解码失败原样交回，让保存端去报错（错误信息在 bgStatus 呈现）。
  function normalizeBackground(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const MAX = 2560;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

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
        // 顺带留一句已加载的元素引用：ColorThief 从可绘制元素取样，
        // ImageData 喂不进它的 canvas 路径。取色失败时 tokensFromImage
        // 自己会走平均色回落，这里不需要为它做额外兜底。
        stdImgEl = img;
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
    if (!stdImage) return;
    const palette = T.extractImagePalette(stdImage, stdImgEl);
    const tokens = T.tokensFromImage(stdImage, stdImgEl, state.imageMode);
    state.imageDraft = { tokens, source: 'standard', rev: T.DERIVE_REV, palette };
    renderPalette();
    await applyCurrent();
    fillSwatches(tokens);
  }

  // ---------- 强调色色板与深浅偏好 ----------

  // 色板：取色管线给出的候选（占比序）。选中态 = 该候选经守卫提亮后与当前
  // accent 一致；点任何一颗都把交互强调切到它，其余键照常重派生。
  function renderPalette() {
    if (!els.palRow) return;
    const pal = (state.imageDraft && state.imageDraft.palette) || [];
    els.palRow.hidden = !pal.length;
    els.palRow.replaceChildren();
    if (!pal.length) return;
    const frag = document.createDocumentFragment();
    const tokens = T.resolveSkin(state).tokens;
    for (const c of pal) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pal-dot';
      b.style.background = c.hex;
      const chosen = T.ensureContrast(c.hex, tokens.panel).toLowerCase()
        === String(tokens.accent || '').toLowerCase();
      b.classList.toggle('is-on', chosen);
      b.title = `${c.hex} · 占比 ${Math.round((c.weight || 0) * 100)}%`;
      b.setAttribute('aria-label', `强调色候选 ${c.hex}`);
      b.setAttribute('aria-pressed', chosen ? 'true' : 'false');
      b.addEventListener('click', () => pickAccent(c.hex));
      frag.appendChild(b);
    }
    els.palRow.replaceChildren(frag);
  }

  async function pickAccent(hex) {
    if (!state.imageDraft || !/^#[0-9a-f]{6}$/i.test(hex || '')) return;
    const tokens = T.resolveSkin(state).tokens;
    const accent = T.ensureContrast(hex, tokens.panel);
    if (accent.toLowerCase() === String(tokens.accent || '').toLowerCase()) return;
    // accent 是核心键：塞回 core 重新派生，派生键（selBar / accentInk）跟着走。
    // 走 tightRamp —— 这是背景图皮肤，字阶必须用收紧后的混比重算，否则换个
    // 强调色会把之前收紧的字阶退回默认档（同一个草稿两套混比，颜色自相矛盾）。
    state.imageDraft.tokens = T.validateSkin(
      T.expandTokens({ ...T.coreOf(tokens), accent }, { tightRamp: true }));
    renderPalette();
    await applyCurrent();
    fillSwatches(state.imageDraft.tokens);
    schedulePersist();
  }

  function renderImageMode() {
    if (!els.imageModeSeg) return;
    els.imageModeSeg.querySelectorAll('button[data-mode]').forEach((b) => {
      const on = (state.imageMode || 'auto') === b.dataset.mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---------- 背景图上的可读性 ----------

  // 底图「成片亮区/暗区」的亮度（块均值的分位）。深色皮肤取 p90、浅色皮肤取
  // p10 —— 深色怕成片亮区（亮字没地方落）、浅色怕成片暗区（暗字没地方落），
  // 口径互为镜像；旧实现取全部块的最大值，壁纸上一颗亮星就把最坏亮度顶满，
  // 可读性守卫跟着把面板钉到接近不透明（2026-09-13 用户实测 floor 0.96）。
  // p90/p10 代表「成片」的亮/暗区；零星极值交给自动纱兜底。
  // 底图统计：一趟 16×16 块均值扫描，两个口径同时产出。
  //   lum  —— 每块的线性亮度均值（chroma 的 relative luminance）→ 守卫的成片亮/暗区
  //   chan —— 每块的等效灰通道均值（lumToChannel(luminance)）→ 自适应透镜要的「图自己的灰范围」
  // 必须来自同一次扫描：它们描述同一张图的同一批块，分两趟扫不仅白扫一遍，两个分位数
  // 还会因为采样口径不同而互相漂。
  // 缓存挂 WeakMap（键是 ImageData 对象）：拖滑杆每帧都会问一次，一张 2 MP 的图重扫是浪费；
  // 换图时 stdImage 是新对象，缓存自然失效，不用手工清。
  const statCache = new WeakMap();
  function imageStats(img) {
    if (!img) return null;
    const hit = statCache.get(img);
    if (hit) return hit;
    const { data, width, height } = img;
    const bw = Math.max(1, Math.floor(width / 16));
    const bh = Math.max(1, Math.floor(height / 16));
    const lum = [];
    const chan = [];
    for (let by = 0; by < height; by += bh) {
      for (let bx = 0; bx < width; bx += bw) {
        let sum = 0;
        let csum = 0;
        let n = 0;
        for (let y = by; y < Math.min(by + bh, height); y += 2) {
          for (let x = bx; x < Math.min(bx + bw, width); x += 2) {
            const i = (y * width + x) * 4;
            const l = T.luminance({ r: data[i], g: data[i + 1], b: data[i + 2] });
            sum += l;
            csum += T.lumToChannel(l);
            n++;
          }
        }
        if (n) {
          lum.push(sum / n);
          chan.push(csum / n / 255);
        }
      }
    }
    lum.sort((a, b) => a - b);
    chan.sort((a, b) => a - b);
    const stat = { lum, chan };
    statCache.set(img, stat);
    return stat;
  }

  // 分位：p 是 0..1 的比例，越界钳到端点；空序列给 0。
  function pct(arr, p) {
    if (!arr || !arr.length) return 0;
    return arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
  }

  function backdropLuminance(img, light = false) {
    const s = imageStats(img);
    if (!s) return 0;
    return light ? pct(s.lum, 0.1) : pct(s.lum, 0.9);
  }

  // 自适应透镜要的输入：图**自己**的等效灰通道范围（p2–p98）。一张只占一小段灰的
  // 壁纸（近黑星空那种）靠这两个数才能被拉张开；固定透镜只会把它原样压成一块平色。
  function imageRange(img) {
    const s = imageStats(img);
    if (!s) return null;
    return { lo: pct(s.chan, 0.02), hi: pct(s.chan, 0.98) };
  }

  // 当前生效的自适应透镜。图还没解码完 / 图太平 / 参数退化时是 null，
  // theme.applyBackdrop 会回落到 theme.lensOf(tokens)（同一组带端、只是少一层
  // 按图拉张）。
  // 依赖三样：图自己的灰范围、方向化纱浓度、背景亮度滑杆（CSS 里亮度作用在纱之下、
  // 透镜之上，所以必须算进反解里）。
  let activeLens = null;
  function refreshLens() {
    const tokens = T.resolveSkin(state).tokens;
    const lightSkin = T.isLightSkin(tokens);
    const r = imageRange(stdImage);
    activeLens = r
      ? T.lensFromImage(
        r.lo,
        r.hi,
        tokens,
        T.effectiveScrim(state.scrim ?? 0.3, lightSkin),
        state.bgBrightness ?? 1,
      )
      : null;
    return activeLens;
  }

  // 可读性守卫：p90 亮区 + 用户滑杆（不透明度 / 压暗）→ 自动压暗补偿。
  // 面板不透明度滑杆已放开到 0.70，亮图不再硬钳滑杆，而是先补自动压暗
  // （--backdrop-auto，垫在 tint 纱之下的纯黑层）让用户选的值原地达标；
  // 自动压暗到顶（0.6）还不够读才退回硬钳 floor。滑杆因此全程「拖了就有感」：
  // 拖低不透明度 → 面板真的更透 + 图稍微更暗（补偿），文字始终达标。
  // 贴膜模式走同一条守卫的简化分支：膜的等效合成 = 面板色按浓度调和（无黑纱），
  // 深度越高越可读，所以守卫只算「浓度地板」（wrapFloorVal），用户浓度低于
  // 地板时实际铺膜取地板（effectiveWrapOpacity）。
  let autoDim = 0; // 守卫算出的补偿值，随 applyBackdrop 铺到 CSS（置底模式）
  // 硬钳地板（--panel-op-floor）：守卫连自动补偿顶格都读不清时才非零。小窗也要，
  // 而它算不出来（要图的直方图），所以和 autoDim 一样由这一侧算完往下发。
  // 小窗以前自己写死 0.90，主窗滑杆拖到 0.45 它照 0.90 铺 —— 壁纸在小窗上几乎
  // 看不见；后来改成写死 0，又在「守卫真的钳住了」那档反过来比主窗透一截。
  let panelOpFloor = 0;

  function syncBackdropGuard() {
    if (!els.opFloorNote) return;
    const wrap = state.backdropStyle === 'wrap';
    const tokens = T.resolveSkin(state).tokens;
    const lightSkin = T.isLightSkin(tokens);
    const panelOp = T.clamp(state.panelOpacity ?? 0.45, T.MIN_PANEL_OP, 1);
    // 滑杆下限恒定 = MIN_PANEL_OP：透镜接手了底图偏明偏暗那一档（把面板身后的背景
    // 按这张图自己的直方图拉张开成一条柔色玻璃带），地板不再需要去抬 min。
    // （旧版这里会用地板抬高 min，见下面那段注释。）
    els.opacity.min = String(T.MIN_PANEL_OP);
    let guard = { autoDim: 0, floor: T.MIN_PANEL_OP };
    wrapFloorVal = 0;
    // 守卫看「调亮之后的实际底图」:亮度 ×1.3 的暗图,等效亮度按 1.3 倍算
    // （线性近似,偏保守）;>1 的部分钳到 1。分位口径随皮肤方向（浅色取 p10）。
    const lum = stdImage
      ? Math.min(1, backdropLuminance(stdImage, lightSkin) * T.clamp(state.bgBrightness ?? 1, 0.5, 1.5))
      : 0;
    if (stdImage && wrap) {
      // 贴膜：等效合成 = mix(图, panel, 浓度)。守护档位宽一档（主文字 4.5、
      // 次要 3.2），地板下限取滑杆下限 0.40 —— 档位依据见 theme.wrapFloor 注释
      wrapFloorVal = T.wrapFloor(tokens, lum, 0.4);
    } else if (stdImage) {
      // 纱浓度走方向化有效值（与 CSS --backdrop-dim 同一口径），守卫判定和实际渲染才一致
      guard = T.backdropGuard(
        tokens, lum, T.effectiveScrim(state.scrim ?? 0.3, lightSkin), panelOp, refreshLens());
    }
    autoDim = wrap ? 0 : guard.autoDim;
    // 地板只铺在 --panel-op-floor（--paint-op 取 max(滑杆, floor)），**不动滑杆**。
    // 2026-09-15 之前这里会把 els.opacity.min 抬到 floor、并把 value 与 state 一起
    // 吸附过去 —— 用户的滑杆被系统拿走：往下拉到尽头就是 0.93，底图一点透不出来。
    // 现在置底 + 底图的路径上守卫整体退休（theme.backdropGuard 遇透镜直接返回
    // MIN_PANEL_OP）：带的两端由透镜在**设计不透明度**上反解，用户拖到更低时合成面
    // 确实更暗 —— 那是他要的透明度，不是需要补偿的缺陷。这条分支只剩贴膜 / 无图
    // 两条路径兜底，提示条基本不会再出现。
    const clamped = !wrap && stdImage && guard.floor > panelOp + 1e-9;
    panelOpFloor = clamped ? guard.floor : 0;
    document.documentElement.style.setProperty('--panel-op-floor', String(panelOpFloor));
    applyBackdropOnly();
    if (wrap) {
      // 贴膜不钳滑杆：用户的选择保留在滑杆上，实际铺膜取地板，差值由提示条解释
      const user = T.clamp(state.wrapOpacity ?? 0.62, 0.4, 0.9);
      if (wrapFloorVal > user + 1e-9) {
        els.opFloorNote.hidden = false;
        els.opFloorNote.textContent = `底图偏亮，贴膜浓度已自动加深至 ${wrapFloorVal.toFixed(2)} 以保证文字对比度（滑杆数值保留你的设置）。`;
        els.opFloorNote.className = 'note';
      } else {
        els.opFloorNote.hidden = true;
      }
      return;
    }
    // 这里原先还有一段「把 min 抬到地板、并把 value / state 一起吸附过去」的代码，
    // 随透镜上线一并删除：它是「系统拿走滑杆」的元凶，而地板现在不必靠牺牲用户的
    // 选择来换可读性。
    // 提示条两档：自动纱（常规，中性语气）与不透明度地板（垫底，警告）
    if (!stdImage) {
      els.opFloorNote.hidden = true;
    } else if (clamped) {
      els.opFloorNote.hidden = false;
      // 措辞对应「明度带」判据 + 处置方式：漆层按地板铺、滑杆保留用户的选择，
      // 差值说清楚；再给一条真能让底图更显的操作（模糊），而不是让人去动滑杆。
      els.opFloorNote.textContent = lightSkin
        ? `底图整体过暗，当前不透明度下面板会与背景混为一片中调灰而削弱文字对比度，漆层已按 ${guard.floor.toFixed(2)} 铺（滑杆数值保留你的设置）。`
        : `底图整体过亮，当前不透明度下面板会失去深色表面的明度分层，漆层已按 ${guard.floor.toFixed(2)} 铺（滑杆数值保留你的设置）。`;
      els.opFloorNote.className = 'note is-warn';
    } else if (guard.autoDim > 0.005) {
      els.opFloorNote.hidden = false;
      els.opFloorNote.textContent = lightSkin
        ? `底图局部过暗，已自动补偿 ${guard.autoDim.toFixed(2)} 亮纱以保证文字对比度；提高「面板不透明度」可相应减少补偿。`
        : `底图局部过亮，已自动补偿 ${guard.autoDim.toFixed(2)} 压暗以保证文字对比度；提高「面板不透明度」可相应减少补偿。`;
      els.opFloorNote.className = 'note';
    } else {
      els.opFloorNote.hidden = true;
    }
  }

  // ---------- 显示方式（置底 / 贴膜） ----------

  function renderBackdropStyle() {
    if (!els.backdropStyleSeg) return;
    const wrap = state.backdropStyle === 'wrap';
    els.backdropStyleSeg.querySelectorAll('button[data-style]').forEach((b) => {
      const on = (state.backdropStyle || 'underlay') === b.dataset.style;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    // 两套滑杆各归各的模式：置底 = 不透明度/模糊/压暗；贴膜 = 浓度
    els.opRow.hidden = wrap;
    els.blurRow.hidden = wrap;
    els.scrimRow.hidden = wrap;
    els.wrapOpRow.hidden = !wrap;
  }

  // ---------- 内置壁纸 ----------

  // 三张图此前躺在 ui/wallpapers/ 里没有任何代码引用，而「跟随背景图」皮肤却要求
  // 用户自己去找一张图 —— 开箱即用的那一步是缺的。
  function renderWallpapers() {
    if (!els.wallGrid) return;
    const frag = document.createDocumentFragment();
    for (const w of T.WALLPAPERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wall-card' + (state.backgroundImage === w.src ? ' is-on' : '');
      b.style.backgroundImage = `url("${w.src}")`;
      b.title = w.name;
      b.setAttribute('aria-label', `使用内置壁纸「${w.name}」`);
      b.setAttribute('aria-pressed', state.backgroundImage === w.src ? 'true' : 'false');
      b.innerHTML = `<span class="wall-name">${escapeHtml(w.name)}</span>`;
      b.addEventListener('click', () => useWallpaper(w));
      frag.appendChild(b);
    }
    els.wallGrid.replaceChildren(frag);
  }

  // 内置壁纸走相对路径直接交给 CSS，不落盘、不转 data URL：它本来就在安装目录里，
  // 复制一份到 app data 只是白占空间。取色仍要 ImageData，所以照样 load 一次。
  async function useWallpaper(w) {
    state.backgroundImage = w.src;
    bgDataUrl = w.src;
    stdImage = await loadImageData(w.src);
    updateBgThumb();
    els.bgStatus.textContent = `已使用内置壁纸「${w.name}」`;
    els.bgStatus.className = 'note truncate';
    syncAiGate();
    await runImageColor();
    syncBackdropGuard();
    renderWallpapers();
    schedulePersist();
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
      // 新格式（9 核心键）直接进派生管线；旧格式（10 键带 border/muted）走迁移归一。
      // tightRamp：AI 给的也是背景图皮肤的表面色，字阶同样要按收紧混比派生，
      // 否则「标准取色」与「AI 取色」两条路会给出两套字阶深度。
      const raw = res.tokens;
      const tokens = raw.accent && !raw.border
        ? T.validateSkin(T.expandTokens(raw, { tightRamp: true }))
        : T.validateSkin(T.convertLegacyTokens(raw));
      state.imageDraft = { tokens, source: 'ai', rev: T.DERIVE_REV };
      // AI 给的面板不透明度 / 模糊半径同步回滑块，所见即所存
      state.panelOpacity = T.clamp(res.panelOpacity, T.MIN_PANEL_OP, 1);
      state.bgBlur = Math.round(T.clamp(res.blur, 0, 60));
      syncTuningLabels();
      els.opacity.value = state.panelOpacity;
      els.blur.value = state.bgBlur;
      // AI 只管配色，不管底图亮度：它建议的不透明度可能低于这张图的可读下限，
      // 落位前过一遍守卫，不达标会被补偿/抬升并给出提示
      syncBackdropGuard();
      await applyCurrent();
      fillSwatches(tokens);
      els.aiStatus.textContent = '已应用；可在下方调整并另存为自定义皮肤';
      els.aiStatus.className = 'note is-ok';
    } catch (err) {
      els.aiStatus.textContent = `AI 生成失败（${err.message}），已回退本地取色`;
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

  // 首次改色时把当前生效皮肤拆成 { core, overrides } 作为草稿起点。
  function ensureCustomDraft() {
    if (!state.custom || !state.custom.core) {
      state.custom = T.draftFromTokens(draftTokens());
    }
    return state.custom;
  }

  // 改一个颜色：写进草稿 → 重新派生 → 过对比度守卫 → 上屏。
  //
  // 关键是 state.skin 要跟着切到 'custom'。原来草稿只躺在 state.custom 里、由这里
  // 直接 applyTokens 上屏，而 resolveSkin 不认这个来源 —— 于是改完重启就回到朴素
  // （值在磁盘上，没人读回来），小窗启动走 resolveSkin 也显示另一套颜色。
  function editDraftKey(tokenKey, hex) {
    // 从「跟随背景图」进编辑器：皮肤切到 custom 后背景图会随 applyDraft 撤下，
    // 但配置还在 —— 不说一声的话，用户眼里是「改个颜色把我的背景图弄没了」。
    const fromImage = state.skin === 'image' && state.backgroundImage;
    state.custom = T.setDraftKey(ensureCustomDraft(), tokenKey, hex);
    state.skin = 'custom';
    renderSkinCards();
    renderThemeList();
    applyDraft();
    if (fromImage && els.themeHint) {
      els.themeHint.textContent = '已进入自定义编辑：背景图随「跟随背景图」皮肤一并撤下，配置仍保留；切回该皮肤即可恢复。';
      els.themeHint.className = 'note';
    }
  }

  // 草稿上屏。守卫会把读不出来的颜色提亮，同时回报动了哪些键 —— 按守卫后的颜色
  // 渲染、并把修正说出来，是这里唯一诚实的做法：原来预览不校验（能选出对比度
  // 1.03 的主文字，字直接看不见），保存时又静默改写，两头对不上。
  function applyDraft() {
    const guard = T.guardTokens(draftTokens());
    T.applyTokens(guard.tokens);
    T.applyBackdrop({ background: '', panelOpacity: 1, bgBlur: 0, scrim: 0 });
    broadcastTokens(guard.tokens);
    fillSwatches(guard.tokens);
    reportGuard(guard.adjusted);
  }

  // 守卫回执 → 人话。说清「哪一项」「为什么」，不然用户只看到自己选的色被改了。
  function reportGuard(adjusted) {
    if (!els.guardNote) return;
    if (!adjusted || !adjusted.length) {
      els.guardNote.hidden = true;
      return;
    }
    const names = adjusted.map((k) => GUARD_LABELS[k] || k).join('、');
    els.guardNote.hidden = false;
    els.guardNote.textContent = `${names} 已自动调整至可读对比度（4.5:1）：原色在当前面板上无法满足可读性要求。`;
    els.guardNote.className = 'note is-warn';
  }

  // ---------- 已另存的皮肤列表 ----------

  const { icon } = window.NetPeekCommon;
  const escapeHtml = window.NetPeekCommon.escapeHtml;

  // 哪一行正处在改名 / 待删确认态。{ name, mode } 或 null。
  // 一次只允许一行展开：两行同时问「确认删除？」的话，点错的概率比不问还高。
  let rowMode = null;

  function setRowMode(next) {
    rowMode = next;
    renderThemeList();
  }

  function renderThemeList() {
    const frag = document.createDocumentFragment();
    for (const name of Object.keys(state.themes || {})) {
      const item = document.createElement('div');
      item.className = 'theme-item' + (state.skin === name ? ' is-active' : '');
      const mode = rowMode && rowMode.name === name ? rowMode.mode : '';

      if (mode === 'rename') {
        // 原地输入框取代 prompt()：prompt 是系统模态，把整个窗口锁住去问一个
        // 单行文本，而且在 Tauri 的 webview 里样式完全不受控，和这套界面不是一家的。
        item.innerHTML = `
          <input type="text" class="text-input" data-act="input" aria-label="皮肤新名称" />
          <span class="row-actions">
            <button type="button" class="btn" data-act="ok">改名</button>
            <button type="button" class="btn ghost" data-act="cancel">取消</button>
          </span>`;
        const input = item.querySelector('[data-act="input"]');
        input.value = name;
        const commit = () => renameSkin(name, input.value);
        item.querySelector('[data-act="ok"]').addEventListener('click', commit);
        item.querySelector('[data-act="cancel"]').addEventListener('click', () => setRowMode(null));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setRowMode(null);
        });
        frag.appendChild(item);
        // 展开就把光标放进去，不用再点一次
        queueMicrotask(() => { input.focus(); input.select(); });
        continue;
      }

      if (mode === 'delete') {
        // 删除是不可逆的用户数据丢失（一套手调的配色没有别处备份），
        // 所以和「清空历史」用同一套原地二次确认，而不是点一下就没了。
        item.innerHTML = `
          <span class="name">删除「${escapeHtml(name)}」？不可恢复</span>
          <span class="row-actions">
            <button type="button" class="btn is-danger" data-act="ok">确认删除</button>
            <button type="button" class="btn ghost" data-act="cancel">取消</button>
          </span>`;
        item.querySelector('[data-act="ok"]').addEventListener('click', () => deleteSkin(name));
        item.querySelector('[data-act="cancel"]').addEventListener('click', () => setRowMode(null));
        frag.appendChild(item);
        continue;
      }

      item.innerHTML = `
        <span class="name">${escapeHtml(name)}</span>
        <span class="tag">自定义</span>
        <span class="row-actions">
          <button type="button" class="icon-btn" data-act="use" title="应用" aria-label="应用皮肤">${icon('check')}</button>
          <button type="button" class="icon-btn" data-act="rename" title="重命名" aria-label="重命名皮肤">${icon('pencil')}</button>
          <button type="button" class="icon-btn is-danger" data-act="delete" title="删除" aria-label="删除皮肤">${icon('trash')}</button>
        </span>`;
      item.querySelector('[data-act="use"]').addEventListener('click', () => selectSkin(name));
      item.querySelector('[data-act="rename"]').addEventListener('click', () => setRowMode({ name, mode: 'rename' }));
      item.querySelector('[data-act="delete"]').addEventListener('click', () => setRowMode({ name, mode: 'delete' }));
      frag.appendChild(item);
    }
    els.themeList.replaceChildren(frag);
    els.themeEmpty.hidden = Object.keys(state.themes || {}).length > 0;
  }

  function renameSkin(name, next) {
    const trimmed = String(next || '').trim();
    if (!trimmed || trimmed === name) { setRowMode(null); return; }
    // 改成一个已存在的名字会静默覆盖掉那套皮肤 —— 同样是不可逆的数据丢失，
    // 只是更隐蔽（用户以为自己在改名，实际删了另一套）。这里直接拒绝并说明。
    if (state.themes[trimmed]) {
      els.themeHint.textContent = `已存在名为「${trimmed}」的皮肤，请使用其他名称`;
      els.themeHint.className = 'note is-warn';
      return;
    }
    state.themes[trimmed] = { ...state.themes[name], name: trimmed };
    if (state.skin === name) { state.skin = trimmed; }
    delete state.themes[name];
    els.themeHint.textContent = '';
    setRowMode(null);
    renderSkinCards();
    schedulePersist();
  }

  function deleteSkin(name) {
    delete state.themes[name];
    rowMode = null;
    if (state.skin === name) selectSkin('plain');
    else { renderThemeList(); schedulePersist(); }
  }

  // ---------- 滑块 ----------

  function syncTuningLabels() {
    els.opValue.textContent = parseFloat(els.opacity.value).toFixed(2);
    els.scrimValue.textContent = parseFloat(els.scrim.value).toFixed(2);
    // 不透明度和压暗是比例，模糊半径是长度，得带单位才知道量级
    els.blurValue.textContent = `${els.blur.value} px`;
    // 贴膜浓度标签显示「实际铺膜的浓度」——守卫自动加深后与滑杆值可能不同
    if (els.wrapOpValue) {
      els.wrapOpValue.textContent = effectiveWrapOpacity().toFixed(2);
    }
    if (els.bgBrightnessValue) {
      els.bgBrightnessValue.textContent = `×${Number(els.bgBrightness.value).toFixed(2)}`;
    }
  }

  function pullSliders() {
    state.panelOpacity = T.clamp(els.opacity.value, T.MIN_PANEL_OP, 1);
    state.bgBlur = Math.round(T.clamp(els.blur.value, 0, 60));
    state.scrim = T.clamp(els.scrim.value, 0.2, 0.6);
  }

  function pushSliders() {
    els.opacity.value = T.clamp(state.panelOpacity ?? 0.45, T.MIN_PANEL_OP, 1);
    els.blur.value = Math.round(T.clamp(state.bgBlur ?? 0, 0, 60));
    els.scrim.value = T.clamp(state.scrim ?? 0.30, 0.2, 0.6);
    if (els.wrapOpacity) els.wrapOpacity.value = T.clamp(state.wrapOpacity ?? 0.62, 0.4, 0.9);
    if (els.bgBrightness) els.bgBrightness.value = T.clamp(state.bgBrightness ?? 1, 0.5, 1.5);
    // 全局不透明度：滑杆回位 + 启动即应用（applyCurrent 之外这条独立通道，
    // 因为它和皮肤无关，任何皮肤下都要生效）
    els.uiOpacity.value = T.clamp(state.uiOpacity ?? 1, 0.5, 1);
    els.uiOpacityValue.textContent = `${Math.round((state.uiOpacity ?? 1) * 100)}%`;
    T.applyUiOpacity(state.uiOpacity ?? 1);
    syncTuningLabels();
  }

  // ---------- 持久化 ----------

  // 拖材质滑杆、拖取色器都是每帧一个 input 事件，直写会让每个中间值都整份
  // JSON.stringify + IPC 落盘。HEAD 时代是节流 300ms，一轮重写时丢了 —— 用
  // common.debounce 恢复；页面隐藏 / pagehide 时 flush，关窗前最后一次改动
  // 不悬在定时器里（hide 到托盘必经 visibilitychange，flush 一定跑得到）。
  async function persist() {
    if (!storage) return;
    try {
      await storage.save(state);
    } catch (err) {
      // 静默吞掉的代价是「用户改动无声丢失」：磁盘满 / 配置文件被锁时至少要在
      // 控制台留下一条可查的痕迹。
      console.warn('[NetPeek] 主题配置保存失败：', err);
    }
  }

  const debouncedPersist = (window.NetPeekCommon && window.NetPeekCommon.debounce)
    ? window.NetPeekCommon.debounce(persist, 300)
    : persist;

  function schedulePersist() {
    if (typeof debouncedPersist.schedule === 'function') debouncedPersist.schedule();
    else debouncedPersist();
  }

  if (window.addEventListener) {
    window.addEventListener('pagehide', () => {
      if (typeof debouncedPersist.flush === 'function') debouncedPersist.flush();
      flushBroadcast();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && typeof debouncedPersist.flush === 'function') debouncedPersist.flush();
      if (document.hidden) flushBroadcast();
    });
  }

  // ---------- 事件绑定 ----------

  els.skinCards.forEach((card) => {
    card.addEventListener('click', () => selectSkin(card.dataset.skin));
  });

  els.bgPick.addEventListener('click', () => els.bgFile.click());

  // 选图落地管线：规范化 → 落盘 → 重取色 → 刷新守卫与选中态。
  async function useBackgroundImage(dataUrl, okText) {
    try {
      // 旧版「面板不透明度地板」会把滑杆钳在 0.92–1.00（透镜上线前地板最高能算到
      // 0.97），那个时代留下的近实心值会让新选的图完全看不见（用户实测：图已应用
      // 却以为没生效）。选新图时检测到这段历史值就回到默认 0.45 —— 透镜接手后
      // 0.45 就「底图看得见 + 字读得清」，不必再用近实心面板换可读性。
      // 阈值留在 0.9：0.7–0.9 可能是用户自己挑的档，不该被这里悄悄改掉
      // （那一档的归位交给 migrateState 的一次性 opRev 规则）。
      if ((state.panelOpacity ?? 0) >= 0.9) {
        state.panelOpacity = 0.45;
        els.opacity.value = '0.45';
      }
      const normalized = await normalizeBackground(dataUrl);
      // 落盘到应用数据目录，避免配置 JSON 无限膨胀
      state.backgroundImage = await storage.saveBackground(normalized);
      bgDataUrl = normalized;
      stdImage = await loadImageData(normalized);
      updateBgThumb();
      els.bgStatus.textContent = okText;
      els.bgStatus.className = 'note truncate';
      syncAiGate();
      await runImageColor();
      syncBackdropGuard();
      renderWallpapers();   // 换成自选图后，内置壁纸的选中态要撤掉
      schedulePersist();
      return true;
    } catch (err) {
      els.bgStatus.textContent = `背景加载失败：${err.message}`;
      els.bgStatus.className = 'note is-error';
      return false;
    }
  }

  els.bgFile.addEventListener('change', async () => {
    const file = els.bgFile.files[0];
    if (!file) return;
    const dataUrl = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(file);
    });
    await useBackgroundImage(dataUrl, `已选择 ${file.name}`);
  });

  els.bgClear.addEventListener('click', async () => {
    state.backgroundImage = '';
    state.imageDraft = null;
    bgDataUrl = '';
    stdImage = null;
    stdImgEl = null;
    updateBgThumb();
    els.bgStatus.textContent = '未设置背景（使用面板底色）';
    els.bgStatus.className = 'note truncate';
    syncAiGate();
    await applyCurrent();
    fillSwatches(currentTokens());
    syncBackdropGuard();
    renderWallpapers();
    schedulePersist();
  });

  // 全局界面不透明度：拖动即实时预览（CSS 变量直挂），小窗走广播节流
  els.uiOpacity.addEventListener('input', () => {
    const v = parseFloat(els.uiOpacity.value);
    state.uiOpacity = v;
    els.uiOpacityValue.textContent = `${Math.round(v * 100)}%`;
    T.applyUiOpacity(v);
    broadcastTokens(currentTokens());
    schedulePersist();
  });

  for (const input of [els.opacity, els.scrim, els.blur]) {
    input.addEventListener('input', () => {
      syncTuningLabels();
      pullSliders();
      applyBackdropOnly();
      // 压暗与不透明度都是守卫的输入：拖哪个都要重算补偿。常规情况下守卫只动
      // --backdrop-auto、不碰滑块；只有「自动压暗顶格仍读不清」的硬钳兜底才会
      // 把滑块拽回 floor —— 那是它存在的意义，不是干扰。
      if (input === els.scrim || input === els.opacity) syncBackdropGuard();
      schedulePersist();
    });
  }

  els.aiConsent.addEventListener('change', () => {
    state.ai.consented = els.aiConsent.checked;
    syncAiGate();
    schedulePersist();
  });

  // ---------- 跟随系统深浅色 ----------
  // 存储里的 skin 是用户意图（plain / light），resolveSkin 出口按系统深浅映射；
  // 系统中途翻转时在这里重新应用，小窗跟着 theme-changed 广播走。
  els.followSystem.addEventListener('change', () => {
    state.followSystem = els.followSystem.checked;
    renderSkinCards();
    applyCurrent().then(schedulePersist, schedulePersist);
  });

  // image 皮肤的深浅偏好：钉死方向或交还给壁纸亮度，改完整条取色管线重跑
  if (els.imageModeSeg) {
    els.imageModeSeg.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b || !state || state.imageMode === b.dataset.mode) return;
      state.imageMode = b.dataset.mode;
      renderImageMode();
      if (stdImage) {
        await runImageColor();
        syncBackdropGuard();
      }
      schedulePersist();
    });
  }

  // 显示方式（置底 / 贴膜）：切换行可见性与 body.wrap-mode,守卫换分支重算
  if (els.backdropStyleSeg) {
    els.backdropStyleSeg.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-style]');
      if (!b || !state || state.backdropStyle === b.dataset.style) return;
      state.backdropStyle = b.dataset.style;
      renderBackdropStyle();
      await applyCurrent();
      syncBackdropGuard();
      syncTuningLabels();
      schedulePersist();
    });
  }

  // 贴膜浓度：拖动即预览;守卫地板只在换图 / 换模式时重算（它不随浓度变）
  els.wrapOpacity.addEventListener('input', () => {
    state.wrapOpacity = T.clamp(els.wrapOpacity.value, 0.4, 0.9);
    syncTuningLabels();
    applyBackdropOnly();
    schedulePersist();
  });

  // 背景亮度：置底走底图滤镜、贴膜走白/黑补偿层;亮度改变实际底图亮度,
  // 守卫地板跟着重算（提亮亮图 → 地板抬,压暗亮图 → 地板降）
  els.bgBrightness.addEventListener('input', () => {
    state.bgBrightness = T.clamp(els.bgBrightness.value, 0.5, 1.5);
    syncTuningLabels();
    syncBackdropGuard();
    schedulePersist();
  });

  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemFlip = () => {
      if (state && state.followSystem && (state.skin === 'plain' || state.skin === 'light')) {
        applyCurrent();
      }
    };
    (mq.addEventListener || mq.addListener).call(mq, 'change', onSystemFlip);
  }

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
      // 拆成 { core, overrides } 而不是直接塞展开表：内置皮肤是手写的精确值，
      // 与派生结果有出入的键会被记成 override，所以倒进来外观分毫不变；
      // 之后改「窗口底」时，那些本来就该跟着算的键（顶栏、边线、次要字）才会动。
      state.custom = T.draftFromTokens(cloneTokens(preset.tokens));
      state.skin = 'custom';
      renderSkinCards();
      renderThemeList();
      applyDraft();
      schedulePersist();
    });
  });

  SWATCH_IDS.forEach((id) => {
    const locked = id === 'cDown' || id === 'cUp'; // 语义锁定：下载永远暖橙、上传永远钢蓝
    els[id].disabled = locked;
    els[id].addEventListener('input', () => {
      // 走 editDraftKey：核心键进 core（触发重新派生），派生键进 overrides（钉住）。
      // 原来是直接往一张展开表里写一个键，于是派生键永远停在上一套底色上。
      editDraftKey(SWATCH_TO_TOKEN[id], els[id].value);
      schedulePersist();
    });
  });

  els.themeSave.addEventListener('click', async () => {
    const name = els.themeName.value.trim();
    if (!name) {
      els.bgStatus.textContent = '请输入皮肤名称';
      els.bgStatus.className = 'note is-warn';
      return;
    }
    // 同名会覆盖掉一份用户手调出来的配色，而且无法撤销 —— 先问一声。
    if (state.themes[name] && !window.confirm(`已存在名为「${name}」的皮肤，是否覆盖？`)) return;
    // 存的就是预览时那张表：预览已经过守卫，这里再走一次同一个函数，
    // 所见即所存。原来预览不校验、保存才静默改写，两者对不上。
    const tokens = T.guardTokens(cloneTokens(draftTokens())).tokens;
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
      els.followSystem.checked = !!state.followSystem;
      pushSliders();

      if (state.skin === 'image') await ensureImageDraft();
      await applyCurrent();
      fillSwatches(currentTokens());
      renderSkinCards();
      renderThemeList();
      renderWallpapers();
      renderPalette();
      renderImageMode();
      renderBackdropStyle();
      updateBgThumb();
      syncAiGate();
      // 下限要在 ensureImageDraft 之后：它才刚把 stdImage 填上，没有它算不出亮度
      syncBackdropGuard();
    },
  };
})();
