// NetPeek 小窗（屏 2，§2.9）：能量球 ⇄ 迷你窗 双形态交互。
// - 数据：监听主进程广播的 snapshot 事件（app.emit 会广播到所有窗口）。
// - 形态：能量球 112×112（球体 92×92 正圆，四周 10px 给投影）→ 点击展开迷你窗
//   320×300（set_mini_shape 在 Rust 侧按最近边贴靠、夹在屏幕内），再点收起钮回到球。
// - 主题：小窗是独立 webview，主界面设在 documentElement 上的 CSS 变量不会继承过来。
//   启动时自己读一遍主题配置（含背景图），之后跟随主界面广播的 theme-changed 事件。
// - 「退出」不在这里，在托盘右键菜单：它和「主界面」并排等宽时误点一下就把采集停了。

(function () {
  const $ = (id) => window.NetPeekCommon.byId(id, 'mini');

  const els = {
    orb: $('orb'),
    orbDot: $('orbDot'),
    orbLevel: $('orbLevel'),
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
  const TOP_N = 5;

  // 能量填充的分母：固定档位，取第一个「容得下当前速率」的档。
  //
  // 原来的分母是「近 60 秒峰值」，那是个浮动值：填充走到 80% 时读不出是 8 MB/s
  // 还是 80 KB/s，而且下载一停峰值就跟着塌下去，同样的速率过一会儿水位反而更高
  // —— 一个会自己改刻度的量尺，量出来的数没有意义。
  // 固定档位的分母是常识里的带宽量级（1 MB/s ≈ 百兆宽带的零头，12.5 MB/s ≈
  // 百兆满速，125 MB/s ≈ 千兆满速），跨档时填充会跳一下，但任一时刻的填充
  // 都对应一个说得出口的绝对量。
  const TIERS = [128e3, 1e6, 12.5e6, 125e6, 1.25e9];

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

  /// 球上的数值最多 4 个字身。预算不是靠拉长形状挣来的，是靠**纵排**：两行读数
  /// 各自独占一条弦，下载行在球心一带有 84px 可用宽，15px 字号下「12.34 MB/s」
  /// 约 76px，排得下 4 身 + 单位。所以这里和迷你窗的完整精度口径一致 ——
  /// 10 以下两位小数、100 以下一位、1000 以上退整数。
  /// 旧的 3 身预算会把 12.34 MB/s 显示成 12，展开后却是 12.34，同一个值两个读法。
  function fmtOrb(bps) {
    for (const [scale, unit] of UNITS) {
      if (bps >= scale) {
        const n = bps / scale;
        return { v: n >= 100 ? String(Math.round(n)) : n.toFixed(n >= 10 ? 1 : 2), u: unit };
      }
    }
    return { v: String(Math.min(9999, Math.round(bps))), u: 'B/s' };
  }

  function fmtFull(bps) {
    const { v, u } = splitRate(bps);
    return `${v} ${u}`;
  }

  // 转义统一走 common.js（U4 收敛），小窗也先加载那一份。
  const esc = window.NetPeekCommon.escapeHtml;
  const ic = window.NetPeekCommon.icon;

  // 首字母占位也走 common.js：小窗原来自己带了一份，与主界面那份逐字相同 ——
  // 「未归因名字以半角括号开头」这个特例只该在一处维护。
  const initialOf = (name) => window.NetPeekCommon.initialOf(name, 1);

  // 图标缓存：采集端改按路径增量下发（IconUpdates），小窗是独立 webview，
  // 得自己收一份缓存；解析逻辑与主界面 iconOf 相同（含旧协议内联回退）。
  const iconCache = new Map();

  function iconOf(p) {
    if (p.IconBase64) return p.IconBase64;
    return p.Path ? (iconCache.get(p.Path) || '') : '';
  }

  // ---------- 能量填充 ----------

  /// 当前速率占所在档位的比例（0–1）。档位表 TIERS 是升序的绝对量，
  /// 取第一个容得下 bps 的档当分母；超过最末档（1.25 GB/s，万兆满速）就满格。
  /// 分档不带回差：水位在档位边界上下抖动时会来回跳一次，但 TIERS 的相邻档
  /// 相差 8–10 倍，真正贴在边界上持续抖动的速率极少见，为它加一层滞回反而会让
  /// 「同一个速率对应同一个水位」这条性质失效（水位取决于之前从哪个方向来）。
  function levelOf(bps) {
    if (!(bps > 0)) return 0;
    const tier = TIERS.find((t) => bps <= t);
    return tier ? bps / tier : 1;
  }

  /// 水位写进 CSS 变量（--level，mini.css 的 .orb-level i 取它当**高度**）。
  /// 写在液柱本体上而不是整个球上：变量只有一个消费者，挂在它自己身上时
  /// 「谁写谁读」一眼可见，不用去翻继承链。
  /// 取整到 1% 是为了少触发重排：速率每秒一帧、球腔净高 90px，
  /// 1% 已经细于一个像素。
  function setLevel(ratio) {
    const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
    els.orbLevel.style.setProperty('--level', `${pct}%`);
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

  // 最后一帧的速率与水位。暂停后不再更新，画面停在这一帧（§2.8）。
  let last = { down: 0, up: 0, level: 0 };

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
      // 占比不占列宽：整行背景一条从左起的极淡渐变，和主界面进程表同一条（§2.5）。
      // 渐变写在 mini.css 的 .pitem 里，这里只写百分比 —— 颜色要跟着主题的下载色走。
      const share = peak > 0 ? Math.min(100, Math.round((a.DownBytes / peak) * 100)) : 0;
      row.style.setProperty('--share', `${share}%`);
      const d = splitRate(a.DownBytes);
      const u = splitRate(a.UpBytes);
      row.innerHTML = `
        ${a.IconBase64
          ? `<img src="${a.IconBase64}" alt="" />`
          : `<span class="pico">${esc(initialOf(a.Name))}</span>`}
        <span class="pname" title="${esc(a.Name)}">${esc(a.Name)}</span>
        <span class="prate is-down">${ic('arrow-down')}${d.v} ${d.u}</span>
        <span class="prate is-up">${ic('arrow-up')}${u.v} ${u.u}</span>`;
      frag.appendChild(row);
    }
    els.list.replaceChildren(frag);
    // 放不下的行会被列表底边拦腰截断 —— 静止看像渲染事故。溢出时给底部一层
    // 渐隐遮罩，把「还有更多」变成一个可读的视觉信号。
    els.list.classList.toggle('is-fade', els.list.scrollHeight > els.list.clientHeight + 2);
  }

  // 状态点：颜色是状态本身，完整文案挂 title / aria-label（40px 的头放不下一句话）。
  // 措辞和顶栏胶囊、设置屏共用一套（监控中 / 已暂停 / 异常）。
  function paintStatus(snap) {
    const lost = snap.EventsLost || 0;
    // starting 单独一支：ETW 会话在后台起（含残留会话清理，实测 0.3–2.4s），
    // 这几秒管道已在推帧但还没有事件。并到 error 那支就是每次启动的头几秒
    // 都亮红点、报「需管理员权限」，与事实相反。
    const starting = snap.Status === 'starting';
    const failed = !paused && !starting && snap.Status !== 'ok';
    const text = paused ? '已暂停'
      : starting ? '正在启动采集'
      : failed ? '服务异常 · 需管理员权限'
      : lost > 0 ? `监控中 · ETW 丢事件 ${lost} 条`
      : '监控中';
    const cls = failed ? 'is-error'
      : paused || starting || lost > 0 ? 'is-warn'
      : 'is-ok';
    els.dot.className = `panel-dot ${cls}`;
    els.dot.title = text;
    els.dot.setAttribute('aria-label', text);
    // 球上那颗核心同状态同色（.orb-dot 与 .panel-dot 是同一族）。球内三行已被
    // 状态核心与两个读数占满、没有文字位，所以文案只落在这颗核心的 aria-label
    // 与整个球的 title 上。
    els.orbDot.className = `orb-dot ${cls}`;
    els.orbDot.setAttribute('aria-label', text);
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
    lastSnap = snap;
    // 隐藏到托盘时跳过重绘，恢复可见时由 repaintMini 拿 lastSnap 补画一帧。
    if (document.hidden || winHidden) return;
    paused = snap.Status === 'paused';
    // 暂停时采集服务停了累计，速率会掉到 0；照着画会让球上瞬间变成 0 ——
    // 那读起来像「断网了」而不是「我按了暂停」。所以画面停在最后一帧。
    if (!paused) {
      const down = snap.TotalDownloadBytes || 0;
      const up = snap.TotalUploadBytes || 0;
      last = { down, up, level: levelOf(down) };
      paintNumbers();
      paintList(snap);
    }
    els.orb.classList.toggle('is-paused', paused);
    setLevel(last.level);
    paintStatus(snap);
  }

  // ---------- 主题 ----------

  // 小窗跟着主界面走**颜色和背景图两样**。背景图这条以前是剥掉的（旧注释说
  // 「透明窗口后面没有网页内容，backdrop-filter 无从取样」）—— 那句话只否掉了
  // backdrop-filter 这一种实现，不是否掉背景图本身：图铺在形态元素**内部**
  // （mini.css 的 .panel::before 与球 background 的最后一层）就有真实内容可压，
  // 根本不需要采样窗口背后的桌面。剥掉的实际后果是「跟随背景图」皮肤下主窗有壁纸、
  // 小窗是一块平底色，两个窗口不像一套主题。
  //
  // payload = { tokens, background, uiOpacity, backdrop }，由主界面 broadcastTokens
  // 发出，或 initTokens 自己按同一形状包好。background 是已解析的 data URL /
  // 内置壁纸相对路径 —— 小窗这边不认路径，解析（读盘转 data URL）永远在发送端做。
  function applyTokens(payload) {
    const T = window.NetPeekTheme;
    if (!T || !payload || !payload.tokens) return;
    try {
      // solo: true —— 小窗是**单层漆**（形态元素直接压在桌面上，body 透明），
      // 同一个不透明度漏进来的桌面是主窗两层结构的两倍，地板必须按单层口径算。
      // 漏掉这个参数是个哑失败：地板照样有，只是超支一倍，预览里看不出来。
      T.applyTokens(payload.tokens, { silent: true, solo: true });
      // 全局界面不透明度随同一次广播过来；缺省（旧主界面）不动本地值
      if (payload.uiOpacity != null) T.applyUiOpacity(payload.uiOpacity);
      applyBackdrop(payload);
    } catch { /* 令牌不合法就留着 mini.css 的兜底值 */ }
  }

  // 背景图与它那套参数。这批变量要和主窗 applyBackdrop 写进 CSS 的那批**逐项对齐**，
  // 少一项就是「同一张图在两个窗口里长得不一样」：
  //   --theme-bg-image / --bg-blur / --bg-brightness —— 底图本体与它的滤镜
  //   --lens-filter —— 透镜（auto-levels 的 contrast/brightness/saturate）。主窗把它挂在
  //     各表面的 backdrop-filter 上「只归一面板身后那块」；小窗的整个形态元素就是一块
  //     面板，图又是元素**内部**的一层，所以同一组参数当普通 filter 铺满整层，等价。
  //     这一项尤其不能省：漆层那套可读性契约（glassContract / 加固层的目标底色）
  //     算的就是「透镜之后的合成面」，不铺透镜，契约的前提直接不成立。
  //   --backdrop-dim / --backdrop-tint / --backdrop-veil / --backdrop-auto —— 图上那三层纱
  //     （方向化 tint、守卫补偿层、纱的方向色）。少了 veil 浅色皮肤会用黑纱压图、
  //     和主窗的白纱反着走；少了 autoDim 小窗整体比主窗亮一档。
  //   --panel-op —— 面板不透明度滑杆，has-bg 那条路上漆层的口径（见 mini.css 末尾）
  // 贴膜（wrap）模式由主窗下发 wrap: true：参数已换成贴膜口径（无纱无透镜、
  // 漆浓度=贴膜浓度），这里只负责挂 html.wrap-bg 让底图模糊跟滑杆走
  // （贴膜的膜是清晰的，不吃置底那条 16px 保底磨砂）。
  // 不走 T.applyBackdrop：那个函数要 document.body.classList（小窗的 body 没有漆，
  // 类得挂在 html 上，两层形态元素才同时吃到）、要 .backdrop 元素做交叉淡入、
  // 还会写一串小窗用不到的变量（--wrap-op 那一套）。
  function applyBackdrop(payload) {
    const root = document.documentElement;
    const b = payload.backdrop || {};
    const bg = payload.background || '';
    const has = !!bg;
    root.style.setProperty('--theme-bg-image', has ? `url("${bg}")` : 'none');
    root.classList.toggle('has-bg', has);
    root.classList.toggle('wrap-bg', has && !!b.wrap);
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    // 清图 / 贴膜回退时也要撤掉上一张图留下的硬钳地板。
    root.style.setProperty('--panel-op-floor', has ? String(num(b.panelOpFloor, 0)) : '0');
    if (!has) return;
    root.style.setProperty('--panel-op', String(num(b.panelOpacity, 1)));
    // 漆层地板由主窗按壁纸直方图算完后下发；常规未硬钳时值仍是 0。
    //
    // 这里曾经写的是 uiPaintFloor(tokens, true) —— 也就是 0.90，理由是「小窗没有
    // 透镜，面板身后那张图亮度未知，只能按最坏情况推」。那个理由随透镜下发一起
    // 作废了：图现在过同一组 --lens-filter 归一成一条窄亮度带，判据和主窗的
    // backdropGuard 是同一条（那边也是「有透镜 → 地板退回 MIN_PANEL_OP」）。
    // 留着 0.90 的后果就是用户报的那个：主窗面板滑杆拖到 0.45，小窗的漆仍按
    // 0.90 铺 —— 壁纸在小窗上几乎看不见，滑杆对小窗等于空调。
    root.style.setProperty('--bg-blur', `${Math.round(num(b.bgBlur, 0))}px`);
    root.style.setProperty('--bg-brightness', String(num(b.brightness, 1)));
    root.style.setProperty('--backdrop-dim', String(num(b.dim, 0)));
    root.style.setProperty('--backdrop-auto', String(num(b.autoDim, 0)));
    if (b.tint) root.style.setProperty('--backdrop-tint', b.tint);
    // veil 是 rgb() 的分量串（'255 255 255' / '0 0 0'），不是 hex —— CSS 里写的是
    // rgb(var(--backdrop-veil) / a)，塞 hex 进去整条声明会被丢弃（哑失败）。
    if (b.veil) root.style.setProperty('--backdrop-veil', b.veil);
    // 透镜在发送端已经拼成成品 filter 串（theme.lensFilter）：小窗只消费，
    // 重新推导要 tokens + 图直方图，那是主窗才有的输入。
    if (b.lens) root.style.setProperty('--lens-filter', b.lens);
  }

  // 启动时自己把背景图解析成 CSS 能吃的形式。三种来源分开处理，与主界面
  // theme-ui.js 的 resolveBgUrl 同一套判断（那边是权威实现，这里是小窗的最小副本
  // —— 小窗没有 storage 那层封装，直接 invoke 后端命令）：
  //   data: 开头  —— 刚选的图，本身就是 data URL，原样用；
  //   内置壁纸    —— 相对路径，webview 直接加载得到，不必读盘转码；
  //   其余        —— 用户选图落盘后的绝对路径，走 read_background_image 读回 data URL。
  // 不区分的话内置壁纸会被当文件路径去读、必然失败，表现是「主窗有壁纸小窗没有」。
  //
  // 只在启动这一次走这条路：之后主界面广播过来的 background 已经是解析好的。
  async function resolveBg(p, state) {
    const T = window.NetPeekTheme;
    if (!p) return '';
    // 贴膜模式照铺（退回置底那条路）：坐标系对不齐复刻不了「拼起来还是原图」，
    // 但不铺就是「主窗有壁纸、小窗一块素色」—— 用户报的正是这个。
    if (p.startsWith('data:')) return p;
    if (T && T.WALLPAPERS && T.WALLPAPERS.some((w) => w.src === p)) return p;
    try {
      return await invoke('read_background_image', { path: p }) || '';
    } catch {
      return ''; // 图读不到就退回无图那条路（漆层有自己的地板，字仍然可读）
    }
  }

  async function initTokens() {
    const T = window.NetPeekTheme;
    try {
      if (!T) return;
      const boot = await T.initTheme();
      const skin = T.resolveSkin(boot.state); // 内置 / image / 自定义皮肤统一从这走
      const bg = await resolveBg(skin.background || '', boot.state);
      const light = T.isLightSkin(skin.tokens);
      // 贴膜模式的首帧口径（与 theme-ui.js backdropPayload 的 wrap 分支逐项对齐）：
      // 漆浓度取贴膜浓度（clamp 到贴膜滑杆的值域）、无纱无补偿无透镜、地板 0
      // （主窗的贴膜地板在下一次广播带过来，通常它也是 0 —— 浓度地板在发送端
      // 已折进 effectiveWrapOpacity，小窗不必知道）。
      const wrap = boot.state.backdropStyle === 'wrap';
      const wrapOp = wrap ? T.clamp(boot.state.wrapOpacity ?? 0.62, 0.4, 0.9) : 0;
      // 字色也要和主窗同一份：有底图时面板是「漆 + 图」的合成面，出厂字阶在那上面
      // 不达标（text3 实测 Lc 20–23）。主窗 applyCurrent 上屏用的是加固表，广播下来
      // 的也是加固表 —— 启动这一帧自己解析时漏掉加固，就会出现「开机头一眼字偏灰，
      // 等主窗广播过来才变清楚」。判据与 theme-ui.js 的 glassHardenActive 同一条：有图即加固。
      applyTokens({
        tokens: bg ? T.glassHardenTokens(skin.tokens).tokens : skin.tokens,
        uiOpacity: boot.state.uiOpacity,
        background: bg,
        backdrop: {
          panelOpacity: wrap ? wrapOp : skin.panelOpacity,
          bgBlur: skin.bgBlur,
          brightness: boot.state.bgBrightness,
          dim: wrap ? 0 : T.effectiveScrim(skin.scrim ?? 0.3, light),
          tint: T.scrimTint(skin.tokens.bg, light),
          // 纱的方向色，与主窗 applyBackdrop 同一条规则（浅色皮肤铺白纱抬暗区、
          // 深色铺黑纱压亮区）。写成 rgb 分量串是因为 CSS 里是 rgb(var(--backdrop-veil) / a)。
          veil: light ? '255 255 255' : '0 0 0',
          // 守卫补偿按 0：它是主窗 backdropGuard 的输出，要图的直方图才算得出，
          // 小窗没有那份输入。透镜在位时主窗算出来的也是 0（见 theme.backdropGuard
          // 的透镜短路），所以这一帧按 0 铺与主窗一致；真有补偿时下一次广播带过来。
          autoDim: 0,
          // 启动首帧没有主窗的直方图守卫结果，先不硬钳；广播到达后覆盖。
          panelOpFloor: 0,
          wrap,
          // 透镜同理走回落：按图反解要直方图，这里用 lensOf(tokens)——与主窗在
          // 「图还没解码完」时走的是同一支，带的两端同源，只少一层按图拉张。
          // 主窗解码完成后广播的是 lensFromImage 的结果，会覆盖这一帧。
          // 贴膜口径发中性 saturate(1)（主窗贴膜的膜不带透镜）。
          lens: wrap ? 'saturate(1)' : T.lensFilter(T.lensOf(skin.tokens)),
        },
      });
    } catch { /* 读不到配置就用兜底值 */ }
    finally {
      // 首帧守卫（mini.css html:not(.theme-ready)）：无论成败都要放行渲染，
      // 失败时兜底色也比永远空白诚实
      document.documentElement.classList.add('theme-ready');
    }
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
  // 键盘入口：orb 是 role=button，Enter/Space 等价点击。没有它，小窗对键盘用户
  // 是一扇完全打不开的门（展开、暂停全都只能鼠标）。
  els.orb.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setShape('panel');
    }
  });
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

  // els 里的查找已经全部做完，这里把缺失的节点一次性报出来。小窗是独立 webview，
  // mini.html 少一个节点时，症状是「球上某个读数永远不动」——不报出来根本查不到。
  window.NetPeekCommon.reportMissingIds();

  // 先落位：越早设越好，窗口显示前定位完，用户看不到中间态
  placeDefault();

  setLevel(0);
  initTokens();

  // 图标增量必须在 render 之前入缓存：这一帧的行要靠它才画得出图标。
  // 缓存更新不受可见性影响 —— 隐藏期间照收，恢复时 repaintMini 补画的那帧才有图。
  listen('snapshot', (e) => {
    const snap = e.payload;
    if (snap.IconUpdates) for (const k of Object.keys(snap.IconUpdates)) iconCache.set(k, snap.IconUpdates[k]);
    render(snap);
  });
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
  // 托盘「打开迷你窗」之后：窗口刚显示，尺寸对齐一次（见 realignShape）
  listen('mini-shown', () => realignShape());
  listen('pipe-status', (e) => {
    if (e.payload === 'connected') return;
    els.dot.className = 'panel-dot is-error';
    els.dot.title = '未连接采集服务';
    els.dot.setAttribute('aria-label', '未连接采集服务');
    els.orbDot.className = 'orb-dot is-error';
    els.orbDot.setAttribute('aria-label', '未连接采集服务');
    els.orb.title = 'NetPeek · 未连接采集服务';
    els.orb.classList.remove('is-paused');
    els.btnPause.disabled = true;
    setNum(els.orbDownV, els.orbDownU, { v: '--', u: '' });
    setNum(els.orbUpV, els.orbUpU, { v: '--', u: '' });
    setNum(els.ptDownV, els.ptDownU, { v: '--', u: '' });
    setNum(els.ptUpV, els.ptUpU, { v: '--', u: '' });
    setLevel(0);
    last = { down: 0, up: 0, level: 0 };
  });
})();
