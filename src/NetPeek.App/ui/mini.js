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
    pauseLbl: $('pauseLbl'),
    btnMain: $('btnMain'),
  };

  const DRAG_THRESHOLD = 5; // 像素；超过才算拖动，否则视为点击
  const PEAK_WINDOW = 60; // 帧（快照 1/s）；环形规的分母取近 60 秒峰值
  const TOP_N = 5;

  let shape = 'orb'; // 'orb' | 'panel'
  let paused = false;

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

  // 转义统一走 common.js（U4 收敛），小窗也先加载那一份。
  const esc = window.NetPeekCommon.escapeHtml;

  // 图标取不到时的首字母占位。跳过开头的非字母数字：未归因流量那类以半角括号
  // 开头的名字直接切首字符，会在徽标里画一个孤零零的括号。小窗只加载 theme.js，
  // 拿不到主界面那份实现，所以这里自己带一份。
  function initialOf(name) {
    const s = String(name || '').replace(/^[^\p{L}\p{N}]+/u, '');
    return s ? s.slice(0, 1).toUpperCase() : '·';
  }

  // 图标缓存：采集端改按路径增量下发（IconUpdates），小窗是独立 webview，
  // 得自己收一份缓存；解析逻辑与主界面 iconOf 相同（含旧协议内联回退）。
  const iconCache = new Map();

  function iconOf(p) {
    if (p.IconBase64) return p.IconBase64;
    return p.Path ? (iconCache.get(p.Path) || '') : '';
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
  // 单独抽出来是因为它还有第二个调用点：托盘每次显示小窗后 Rust 会广播
  // mini-shown，那时形态没变、但窗口尺寸需要重新对齐（见 realignShape）。
  async function applyShapeSize() {
    try {
      await invoke('set_mini_shape', { shape });
    } catch { /* 非 Tauri 环境忽略 */ }
  }

  async function setShape(next) {
    if (next === shape) return;
    shape = next;
    await applyShapeSize();
    els.orb.hidden = next !== 'orb';
    els.panel.hidden = next !== 'panel';
    if (next === 'orb') Fx.wake();
  }

  // 首次显示时窗口尺寸会被系统的阴影 inset 撑大（实测逻辑宽 135 而非 108，
  // 要切一次形态才被纠正），于是球偏在一边。这里按当前形态重新对齐一次 ——
  // 不能走 setShape，它有 `next === shape` 短路，而「形态没变」正是要修的场景。
  const realignShape = () => applyShapeSize();

  // ---------- 初始落位 ----------

  // 默认停在屏幕工作区右下角。工作区只有 WebView 的 screen 对象给得出 ——
  // availLeft/availTop/availWidth/availHeight 天生是「排除任务栏后的可用区」，
  // 而 tauri 的 Monitor 只有整屏尺寸，Rust 侧又因 forbid(unsafe_code) 走不了 Win32。
  // 只在页面加载时调这一次：之后位置完全交给用户拖动，托盘开关不会把球拽回来。
  // 落位发生在窗口显示之前（配置里 visible: false），所以看不到「先闪中间再跳走」。
  async function placeDefault() {
    if (!tauri) return;
    const s = window.screen;
    const height = s.availHeight || s.height;
    const width = s.availWidth || s.width;
    if (!height || !width) return;
    try {
      await invoke('place_mini_default', {
        area: {
          x: s.availLeft || 0,
          y: s.availTop || 0,
          width,
          height,
        },
      });
    } catch { /* 拿不到就留在系统默认位置 */ }
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
      if (!agg.IconBase64) agg.IconBase64 = iconOf(p);
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

  // 能量强度（0..1）：环形规比例的加权和，下载为主、上传添彩。
  // 写进 .orb 的 --e，CSS 据此点亮核/晕/光叶；1Hz 的阶跃由 700ms 过渡抹平。
  // 暂停时不更新 —— 画面定格含光效（§2.8），读作「能量被按住」而不是归零。
  function paintEnergy() {
    const e = Math.max(0, Math.min(1, last.rd * 0.75 + last.ru * 0.35));
    els.orb.style.setProperty('--e', e.toFixed(3));
    Fx.energy(e);
  }

  // ---------- 能量球粒子层 ----------
  // 技法移植自 MIT 协议的 santscoder-labs/project-13-energy-ball（canvas 轨道粒子 +
  // shadowBlur 发光），按 92px 球重新参数化，并接入能量强度：粒子转速、亮度、
  // 光晕、游动幅度全部随 eSmooth 走。粒子双向旋转（正反各半），比单向公转
  // 更像等离子体。状态机与 §2.8 对齐：live 全速动，paused 定格画布，
  // offline 清空 —— CSS 那三层光效（halo/core/sheen）管「光」，这层管「火」。

  const Fx = (() => {
    const canvas = document.getElementById('orbFx');
    const ctx = canvas.getContext('2d');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const parts = [];
    for (let i = 0; i < 14; i++) {
      parts.push({
        a: Math.random() * Math.PI * 2,
        r: 27 + Math.random() * 12,                       // 游走在内外环之间的带里
        sp: (0.004 + Math.random() * 0.009) * (Math.random() < 0.5 ? -1 : 1),
        size: 0.9 + Math.random() * 1.4,
        glow: 4 + Math.random() * 6,
        ph: Math.random() * Math.PI * 2,
        wob: 0.5 + Math.random() * 1.2,
      });
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = 92 * dpr;
    canvas.height = 92 * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let state = 'offline';      // 'live' | 'paused' | 'offline'
    let eTarget = 0;
    let eSmooth = 0;            // 1Hz 目标值的逐帧插值，粒子运动不跟着数据一跳一跳
    let color = '#f0913f';

    // 主题令牌 --down 是纯色串（hex），canvas 的 shadowColor/fillStyle 直接吃
    function refreshColor() {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--down').trim();
      if (v) color = v;
    }

    function frame(tms) {
      raf = 0;
      // 面板展开时球是 hidden 的，画了也看不见：空转退出，收球时 set('live') 再踢一脚
      if (state !== 'live' || els.orb.hidden) return;
      eSmooth += (eTarget - eSmooth) * 0.06;
      ctx.clearRect(0, 0, 92, 92);
      const t = tms / 1000;
      const speedK = 0.35 + eSmooth * 2.4;
      for (const p of parts) {
        p.a += p.sp * speedK;
        const r = p.r + Math.sin(t * p.wob + p.ph) * (1.5 + eSmooth * 2);
        const x = 46 + Math.cos(p.a) * r;
        const y = 46 + Math.sin(p.a) * r;
        ctx.globalAlpha = 0.22 + eSmooth * 0.62;
        ctx.shadowBlur = p.glow * (0.6 + eSmooth * 1.4);
        ctx.shadowColor = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, p.size * (0.8 + eSmooth * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      if (!reduced) raf = requestAnimationFrame(frame); // reduce 时只画当前这一帧
    }

    function schedule() {
      if (!raf) raf = requestAnimationFrame(frame);
    }

    function set(next) {
      if (next === state) { if (next === 'live') schedule(); return; }
      state = next;
      if (next === 'offline') {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        eTarget = 0;
        eSmooth = 0;
        ctx.clearRect(0, 0, 92, 92);
      } else if (next === 'paused') {
        // 定格：不取消画布内容，只停循环 —— 光点冻在最后一帧
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else {
        schedule();
      }
    }

    function energy(v) { eTarget = Math.max(0, Math.min(1, v)); }

    // 从面板收回球时踢一脚循环（hidden 期间 frame 空转退出了，循环已断）
    function wake() { if (state === 'live' && !els.orb.hidden) schedule(); }

    return { set, energy, wake, refreshColor };
  })();

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
    // 暂停是双态控件：状态挂在 aria-pressed 上（CSS 据它切图标与配色），
    // 文案是按钮里那个 <span class="lbl">，不再整体改 textContent ——
    // 那会把按钮里的 SVG 图标一起清掉。
    els.btnPause.setAttribute('aria-pressed', paused ? 'true' : 'false');
    els.pauseLbl.textContent = paused ? '恢复' : '暂停';
    els.btnPause.title = paused ? '恢复监控' : '暂停监控';
    els.btnPause.disabled = false;
  }

  function render(snap) {
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
    els.orb.classList.remove('is-offline');
    if (!paused) paintEnergy();
    Fx.set(paused ? 'paused' : 'live');
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
    Fx.refreshColor(); // 粒子颜色取的是 --down 的计算值，换主题后要重读
  }

  async function initTokens() {
    const T = window.NetPeekTheme;
    if (!T) return;
    try {
      const boot = await T.initTheme();
      const { state } = boot;
      applyTokens(state.themes[state.active] || Object.values(state.themes)[0]);
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
    } catch (err) {
      // 命令没送到就恢复按钮；错误必须露出来，否则「点了没反应」无从排查
      console.error('发送暂停命令失败：', err);
      els.btnPause.disabled = false;
    }
  });

  els.btnMain.addEventListener('click', async () => {
    try { await invoke('show_main_window'); } catch { /* ignore */ }
  });

  // ---------- 启动 ----------

  // 先落位：越早设越好，窗口显示前定位完，用户看不到中间态
  placeDefault();

  setArc(els.arcDown, 0, false);
  setArc(els.arcUp, 0, false);
  // 首帧快照到达前按断连处理：不亮光效，等数据来了再「通电」
  els.orb.classList.add('is-offline');
  Fx.refreshColor();
  Fx.set('offline');
  initTokens();

  listen('snapshot', (e) => {
    const snap = e.payload;
    if (snap.IconUpdates) for (const k of Object.keys(snap.IconUpdates)) iconCache.set(k, snap.IconUpdates[k]);
    render(snap);
  });
  // 主界面换主题时广播过来，小窗跟着改（§2.9「小窗跟随主题令牌」）
  listen('theme-changed', (e) => applyTokens(e.payload));
  // 托盘「打开迷你窗」之后：窗口刚显示，尺寸对齐一次（见 realignShape）
  listen('mini-shown', () => realignShape());
  listen('pipe-status', (e) => {
    if (e.payload === 'connected') return;
    els.dot.className = 'panel-dot is-error';
    els.dot.title = '未连接采集服务';
    els.dot.setAttribute('aria-label', '未连接采集服务');
    els.orb.title = 'NetPeek · 未连接采集服务';
    els.orb.classList.remove('is-paused');
    els.orb.classList.add('is-offline'); // 断连 = 没有能量：光叶/呼吸全停（mini.css）
    els.orb.style.setProperty('--e', '0');
    Fx.set('offline');
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
