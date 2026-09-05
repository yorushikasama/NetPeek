// NetPeek 小窗（屏 2，§2.9）：能量球 ⇄ 迷你窗 双形态交互。
// - 数据：监听主进程广播的 snapshot 事件（app.emit 会广播到所有窗口）。
// - 形态：能量球 108×108（球 92，四周 8px 给外发光）→ 点击展开迷你窗 320×300
//   （set_mini_shape 在 Rust 侧保持中心、夹在屏幕内），再点「—」收起。
// - 主题：小窗是独立 webview，主界面设在 documentElement 上的 CSS 变量不会继承过来。
//   启动时自己读一遍主题配置，之后跟随主界面广播的 theme-changed 事件。
// - 「退出」不在这里，在托盘右键菜单：它和「主界面」并排等宽时误点一下就把采集停了。

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    orb: $('orb'),
    arcDown: $('orbArcDown'),
    arcUp: $('orbArcUp'),
    orbDownV: $('orbDownV'),
    orbDownU: $('orbDownU'),
    orbUpV: $('orbUpV'),
    orbUpU: $('orbUpU'),
    panel: $('panel'),
    dot: $('panelDot'),
    ptDownV: $('ptDownV'),
    ptDownU: $('ptDownU'),
    ptUpV: $('ptUpV'),
    ptUpU: $('ptUpU'),
    list: $('panelList'),
    btnCollapse: $('btnCollapse'),
    btnClose: $('btnClose'),
    btnPause: $('btnPause'),
    btnMain: $('btnMain'),
  };

  const DRAG_THRESHOLD = 5; // 像素；超过才算拖动，否则视为点击
  const PEAK_WINDOW = 60; // 帧（快照 1/s）；环形规的分母取近 60 秒峰值
  const TOP_N = 5;

  let shape = 'orb'; // 'orb' | 'panel'
  let paused = false;
  let lastSnap = null; // 隐藏到托盘期间停更，恢复可见时用它补画一帧

  const tauri = window.__TAURI__;
  const listen = tauri ? tauri.event.listen : () => Promise.resolve(() => {});
  const invoke = tauri ? tauri.core.invoke : () => Promise.resolve(null);

  // ---------- 格式化 ----------

  const UNITS = [[1e9, 'GB/s'], [1e6, 'MB/s'], [1e3, 'KB/s']];

  /// 完整精度，拆成数值与单位两段（单位要用小一号字排，不能混在一个字号里）
  function splitRate(bps) {
    for (const [scale, unit] of UNITS) {
      if (bps >= scale) {
        const n = bps / scale;
        return { v: n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2), u: unit };
      }
    }
    return { v: String(Math.round(bps)), u: 'B/s' };
  }

  /// 球上的数值最多 3 个字身：92 的球扣掉两圈环，最上面那行只有约 66px 可写，
  /// 20px 等宽一个字身 12px，「数值 3 身 + 10px 单位」正好 62px。10 以下留一位小数。
  function fmtOrb(bps) {
    for (const [scale, unit] of UNITS) {
      if (bps >= scale) {
        const n = bps / scale;
        return { v: n >= 10 ? String(Math.round(n)) : n.toFixed(1), u: unit };
      }
    }
    return { v: String(Math.min(999, Math.round(bps))), u: 'B/s' };
  }

  function fmtFull(bps) {
    const { v, u } = splitRate(bps);
    return `${v} ${u}`;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // 图标取不到时的首字母占位。跳过开头的非字母数字：未归因流量那类以半角括号
  // 开头的名字直接切首字符，会在徽标里画一个孤零零的括号。小窗只加载 theme.js，
  // 拿不到主界面那份实现，所以这里自己带一份。
  function initialOf(name) {
    const s = String(name || '').replace(/^[^\p{L}\p{N}]+/u, '');
    return s ? s.slice(0, 1).toUpperCase() : '·';
  }

  // ---------- 环形规 ----------

  // 近 60 帧的速率，用来算峰值。当前帧先纳入再取峰值，所以比例恒 ≤ 1。
  const samples = [];

  function ratioOf(cur, key) {
    let peak = 0;
    for (const s of samples) if (s[key] > peak) peak = s[key];
    return peak > 0 ? cur / peak : 0;
  }

  const DASH = 4;
  const GAP = 3;

  // 暂停时把弧线打成虚线。SVG 的 stroke-dasharray 是沿整条路径循环取的，
  // 只写「实线 空格」两段会绕回来把剩下的圆周也画满，所以要把弧内的实虚交替
  // 和弧外那一整段空白拼成一个总长恰好等于周长的数组。
  function dashPattern(len, circ) {
    if (len < DASH * 2) return `${len} ${circ - len}`;
    const n = Math.max(1, Math.floor((len + GAP) / (DASH + GAP)));
    const used = n * DASH + (n - 1) * GAP;
    const parts = [];
    for (let i = 0; i < n - 1; i++) parts.push(DASH, GAP);
    parts.push(DASH, Math.max(0, circ - used));
    return parts.join(' ');
  }

  function setArc(el, ratio, dashed) {
    const circ = 2 * Math.PI * Number(el.getAttribute('r'));
    const len = Math.max(0, Math.min(1, ratio)) * circ;
    el.style.strokeDasharray = dashed ? dashPattern(len, circ) : `${len} ${circ - len}`;
  }

  // ---------- 形态切换 ----------

  // 展开/收起：窗口尺寸与位置由 Rust 侧 set_mini_shape 调整（保持中心、夹屏幕）。
  async function setShape(next) {
    if (next === shape) return;
    shape = next;
    try {
      await invoke('set_mini_shape', { shape: next });
    } catch { /* 非 Tauri 环境忽略 */ }
    els.orb.hidden = next !== 'orb';
    els.panel.hidden = next !== 'panel';
  }

  // ---------- 渲染 ----------

  // 按应用聚合（同主界面 topApps 逻辑的轻量版）
  function topApps(snap, n) {
    const map = new Map();
    for (const p of snap.Processes || []) {
      const name = (p.Name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let agg = map.get(key);
      if (!agg) {
        agg = { Name: name, IconBase64: '', DownBytes: 0, UpBytes: 0 };
        map.set(key, agg);
      }
      agg.DownBytes += p.DownloadBytes || 0;
      agg.UpBytes += p.UploadBytes || 0;
      if (!agg.IconBase64 && p.IconBase64) agg.IconBase64 = p.IconBase64;
    }
    const apps = Array.from(map.values());
    apps.sort((a, b) => (b.DownBytes + b.UpBytes) - (a.DownBytes + a.UpBytes));
    return apps.slice(0, n);
  }

  function setNum(vEl, uEl, parts) {
    vEl.textContent = parts.v;
    uEl.textContent = parts.u;
  }

  // 最后一帧的速率与环比例。暂停后不再更新，画面停在这一帧（§2.8）。
  let last = { down: 0, up: 0, rd: 0, ru: 0 };

  function paintNumbers() {
    setNum(els.orbDownV, els.orbDownU, fmtOrb(last.down));
    setNum(els.orbUpV, els.orbUpU, fmtOrb(last.up));
    setNum(els.ptDownV, els.ptDownU, splitRate(last.down));
    setNum(els.ptUpV, els.ptUpU, splitRate(last.up));
  }

  function paintList(snap) {
    const apps = topApps(snap, TOP_N);
    if (!apps.length) {
      els.list.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'panel-empty',
        textContent: '当前没有进程在收发数据',
      }));
      return;
    }
    const peak = apps.reduce((m, a) => Math.max(m, a.DownBytes), 0);
    const frag = document.createDocumentFragment();
    for (const a of apps) {
      const row = document.createElement('div');
      row.className = 'pitem';
      // 占比不占列宽：整行背景一条从左起的极淡琥珀渐变，和主界面进程表同一条（§2.5）
      const share = peak > 0 ? Math.min(100, Math.round((a.DownBytes / peak) * 100)) : 0;
      row.style.backgroundImage = share > 0
        ? `linear-gradient(90deg, rgba(240,145,63,0.09), rgba(240,145,63,0) ${share}%)`
        : 'none';
      const d = splitRate(a.DownBytes);
      const u = splitRate(a.UpBytes);
      row.innerHTML = `
        ${a.IconBase64
          ? `<img src="${a.IconBase64}" alt="" />`
          : `<span class="pico">${esc(initialOf(a.Name))}</span>`}
        <span class="pname" title="${esc(a.Name)}">${esc(a.Name)}</span>
        <span class="prate is-down">↓${d.v} ${d.u}</span>
        <span class="prate is-up">↑${u.v} ${u.u}</span>`;
      frag.appendChild(row);
    }
    els.list.replaceChildren(frag);
  }

  // 状态点：颜色是状态本身，完整文案挂 title / aria-label（40px 的头放不下一句话）。
  // 措辞和顶栏胶囊、设置屏共用一套（监控中 / 已暂停 / 异常）。
  function paintStatus(snap) {
    const lost = snap.EventsLost || 0;
    const text = paused ? '已暂停'
      : snap.Status !== 'ok' ? '服务异常 · 需管理员权限'
      : lost > 0 ? `监控中 · ETW 丢事件 ${lost} 条`
      : '监控中';
    const cls = snap.Status !== 'ok' && !paused ? 'is-error'
      : paused || lost > 0 ? 'is-warn'
      : 'is-ok';
    els.dot.className = `panel-dot ${cls}`;
    els.dot.title = text;
    els.dot.setAttribute('aria-label', text);
    els.orb.title = paused
      ? 'NetPeek · 已暂停'
      : `NetPeek · ↓ ${fmtFull(last.down)} · ↑ ${fmtFull(last.up)}`;
    els.btnPause.textContent = paused ? '恢复' : '暂停';
    els.btnPause.disabled = false;
  }

  function render(snap) {
    lastSnap = snap;
    // 隐藏到托盘时跳过重绘（samples 仍照常更新），恢复可见时由 repaintMini 补画。
    if (document.hidden || winHidden) return;
    paused = snap.Status === 'paused';
    // 暂停时采集服务停了累计，速率会掉到 0；照着画会让球上瞬间变成 0 ——
    // 那读起来像「断网了」而不是「我按了暂停」。所以画面停在最后一帧。
    if (!paused) {
      const down = snap.TotalDownloadBytes || 0;
      const up = snap.TotalUploadBytes || 0;
      samples.push({ d: down, u: up });
      if (samples.length > PEAK_WINDOW) samples.shift();
      last = { down, up, rd: ratioOf(down, 'd'), ru: ratioOf(up, 'u') };
      paintNumbers();
      paintList(snap);
    }
    els.orb.classList.toggle('is-paused', paused);
    setArc(els.arcDown, last.rd, paused);
    setArc(els.arcUp, last.ru, paused);
    paintStatus(snap);
  }

  // ---------- 主题 ----------

  // 小窗只要令牌，不要背景图：透明窗口后面没有网页内容，backdrop-filter 无从取样。
  function applyTokens(theme) {
    const T = window.NetPeekTheme;
    if (!T || !theme || !theme.tokens) return;
    try {
      T.applyTheme({ ...theme, background: '' }, { silent: true });
    } catch { /* 令牌不合法就留着 mini.css 的兜底值 */ }
  }

  async function initTokens() {
    const T = window.NetPeekTheme;
    if (!T) return;
    try {
      const boot = await T.initTheme();
      const { state } = boot;
      // v2 模型：current 才是真正生效的令牌；旧配置迁移失败时退回激活主题
      applyTokens(state.current || state.themes[state.active] || Object.values(state.themes)[0]);
    } catch { /* 读不到配置就用兜底值 */ }
  }

  // ---------- 事件 ----------

  // 自定义拖拽：按下后位移超过阈值才进入系统拖动，否则算点击（能量球点开 / 面板收起）。
  // 必须自己判断按键是否还按着：startDragging() 之后 WebView 收不到 mouseup，
  // 只靠 dragging 标记会让「上次点击后的普通 hover」也触发拖动。
  function bindDrag(el) {
    let sx = 0, sy = 0, pressed = false, dragging = false;
    el.addEventListener('mousedown', (e) => {
      // 头部整段是拖动区，但按在里面的按钮上不该拖窗
      if (e.button !== 0 || e.target.closest('button')) return;
      sx = e.screenX; sy = e.screenY; pressed = true; dragging = false;
    });
    el.addEventListener('mousemove', async (e) => {
      if (!pressed || dragging) return;
      // 按键已松开（mouseup 丢在窗口外）时复位，避免空手拖窗
      if ((e.buttons & 1) === 0) { pressed = false; return; }
      if (Math.hypot(e.screenX - sx, e.screenY - sy) > DRAG_THRESHOLD) {
        dragging = true;
        pressed = false;
        try { await tauri.window.getCurrentWindow().startDragging(); } catch { /* ignore */ }
      }
    });
    el.addEventListener('mouseup', () => { pressed = false; });
    el.addEventListener('mouseleave', () => { pressed = false; });
  }

  bindDrag(els.orb);
  bindDrag(els.panel.querySelector('.panel-head'));

  els.orb.addEventListener('click', () => setShape('panel'));
  els.btnCollapse.addEventListener('click', () => setShape('orb'));

  els.btnClose.addEventListener('click', async () => {
    try { await invoke('toggle_mini'); } catch { /* ignore */ }
  });

  // 暂停/恢复：只发命令，按钮文字等下一帧快照回来才翻 ——
  // 免得管道没送到却先显示成已暂停。
  els.btnPause.addEventListener('click', async () => {
    els.btnPause.disabled = true;
    try {
      await invoke('send_control_command', { command: paused ? 'resume' : 'pause' });
    } catch {
      els.btnPause.disabled = false;
    }
  });

  els.btnMain.addEventListener('click', async () => {
    try { await invoke('show_main_window'); } catch { /* ignore */ }
  });

  // ---------- 启动 ----------

  setArc(els.arcDown, 0, false);
  setArc(els.arcUp, 0, false);
  initTokens();

  listen('snapshot', (e) => render(e.payload));
  // 隐藏到托盘时跳过重绘（§4.1）：document.hidden 在 WebView2 隐藏宿主窗口时不保证触发，
  // 所以 Rust 侧 show/hide 时广播 win-visibility 作为权威信号（初始隐藏，与配置一致）。
  let winHidden = true;
  function repaintMini() {
    if (!document.hidden && !winHidden && lastSnap) render(lastSnap);
  }
  document.addEventListener('visibilitychange', repaintMini);
  listen('win-visibility', (e) => {
    if (e.payload.label !== 'mini') return;
    winHidden = !e.payload.visible;
    repaintMini();
  });
  // 主界面换主题时广播过来，小窗跟着改（§2.9「小窗跟随主题令牌」）
  listen('theme-changed', (e) => applyTokens(e.payload));
  listen('pipe-status', (e) => {
    if (e.payload === 'connected') return;
    els.dot.className = 'panel-dot is-error';
    els.dot.title = '未连接采集服务';
    els.dot.setAttribute('aria-label', '未连接采集服务');
    els.orb.title = 'NetPeek · 未连接采集服务';
    els.orb.classList.remove('is-paused');
    els.btnPause.disabled = true;
    setNum(els.orbDownV, els.orbDownU, { v: '--', u: '' });
    setNum(els.orbUpV, els.orbUpU, { v: '--', u: '' });
    setNum(els.ptDownV, els.ptDownU, { v: '--', u: '' });
    setNum(els.ptUpV, els.ptUpU, { v: '--', u: '' });
    setArc(els.arcDown, 0, false);
    setArc(els.arcUp, 0, false);
    samples.length = 0;
    last = { down: 0, up: 0, rd: 0, ru: 0 };
  });
})();
