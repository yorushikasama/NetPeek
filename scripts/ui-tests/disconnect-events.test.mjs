// 断线事件回归：解析真实 HTML，原样加载完整脚本，不抽取或替换业务函数。
// 快照、管道状态、显隐及控件事件均经过脚本实际注册的处理器；只替代宿主边界。
// 运行：node scripts/ui-tests/disconnect-events.test.mjs
import { loadScripts, readUi, eq, ok, section, report } from './_harness.mjs';
import { DomEvent, EventTarget, makeEventDocument } from './_event-dom.mjs';

const NOW = new Date('2026-10-02T12:00:00').getTime();
const ICON = 'data:image/png;base64,aGlkZGVu';

// 可控时钟与独立 WebView 夹具。只推进指定时段，不能清空主窗的循环刷新队列。
function makeClock() {
  let now = NOW, nextId = 0;
  const jobs = new Map();
  const schedule = (fn, delay, args, interval = 0) => {
    const id = ++nextId;
    jobs.set(id, { id, fn, args, due: now + Math.max(0, Number(delay) || 0), interval });
    return id;
  };
  return {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    setTimeout: (fn, delay, ...args) => schedule(fn, delay, args),
    clearTimeout: (id) => jobs.delete(id),
    setInterval: (fn, delay, ...args) => schedule(fn, delay, args, Math.max(1, Number(delay) || 0)),
    clearInterval: (id) => jobs.delete(id),
    async advance(ms) {
      const end = now + ms;
      let count = 0;
      while (true) {
        const job = [...jobs.values()].filter((j) => j.due <= end)
          .sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!job) break;
        if (++count > 1000) throw new Error('可控时钟遇到未收敛的定时器');
        now = job.due;
        if (job.interval) job.due += job.interval;
        else jobs.delete(job.id);
        await job.fn(...job.args);
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function fixture(kind) {
  const document = makeEventDocument(readUi(kind === 'main' ? 'index.html' : 'mini.html'));
  const events = Object.assign(new EventTarget(), { ownerDocument: document });
  const listeners = new Map(), resized = new Set(), stored = new Map();
  const calls = [], drawings = [], unexpected = [], trace = [];
  const clock = makeClock();
  let maximized = false;
  const win = {
    async isMaximized() { return maximized; },
    async onResized(fn) { resized.add(fn); return () => resized.delete(fn); },
    async toggleMaximize() {
      maximized = !maximized;
      for (const fn of resized) await fn();
    },
    async minimize() {}, async hide() {}, async startResizeDragging() {}, async startDragging() {},
  };
  const answers = {
    frontend_ready: undefined,
    load_settings: JSON.stringify({ autostart: false, rateUnit: 'auto', retentionDays: 30 }),
    save_settings: undefined, get_autostart: false,
    history_stats: JSON.stringify({ rows: 3, bytes: 2048 }),
    history_daily: '[]', history_range: '[]', history_range_days: '[]', history_process_totals: '[]',
    data_dir_path: 'C:\\NetPeek', collector_log_path: 'C:\\NetPeek\\collector.log',
    country_db_info: JSON.stringify({ mode: 'builtin' }),
    set_mini_shape: undefined, place_mini_default: undefined,
    toggle_mini: undefined, show_main_window: undefined, send_control_command: undefined,
  };
  const scripts = kind === 'main'
    ? ['common.js', 'flags.js', 'services.js', 'settings-ui.js', 'history-ui.js', 'main.js']
    : ['common.js', 'mini.js'];
  const ctx = loadScripts(scripts, {
    document, Date: clock.Date, Event: DomEvent, CustomEvent: DomEvent,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    requestAnimationFrame: (fn) => clock.setTimeout(() => fn(clock.Date.now()), 0),
    cancelAnimationFrame: clock.clearTimeout,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    screen: { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1040 },
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
    },
    NetPeekCharts: {
      line: (canvas, options) => { drawings.push({ canvas: canvas.id, options }); },
      bars: (canvas, options) => { drawings.push({ canvas: canvas.id, options }); return { indexAt: () => -1 }; },
      axisRate: (value) => String(value), axisBytes: (value) => String(value), cssVar: (name) => name,
    },
    __TAURI__: {
      core: { async invoke(command, args = {}) {
        calls.push({ command, args });
        trace.push(`invoke:${command}`);
        if (!Object.hasOwn(answers, command)) { unexpected.push(command); throw new Error(command); }
        return answers[command];
      } },
      event: { async listen(name, fn) {
        trace.push(`listen:${name}`);
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(fn);
        return () => listeners.get(name).delete(fn);
      } },
      window: { getCurrentWindow: () => win },
    },
  });
  const t = {
    ctx, document, clock, calls, drawings, unexpected,
    el: (id) => document.getElementById(id),
    chart: () => drawings.filter((d) => d.canvas === 'bandwidthChart').at(-1)?.options,
    controls: () => calls.filter((c) => c.command === 'send_control_command'),
    async emit(name, payload) {
      const handlers = [...(listeners.get(name) || [])];
      ok(handlers.length > 0, `${kind} 已真实注册 ${name} 监听`);
      for (const handler of handlers) await handler({ event: name, payload: structuredClone(payload) });
      await settle(t);
    },
  };
  await settle(t);
  eq(ctx.NetPeekCommon._missingIds.length, 0, `${kind} 真实 HTML 包含完整脚本需要的节点`);
  if (kind === 'main') {
    eq(trace.slice(0, 3).join(','), 'listen:snapshot,listen:pipe-status,invoke:frontend_ready', '先注册数据和断线监听，再通知宿主就绪');
    ok(t.el('setRateUnit').listeners.has('change'), '真实设置模块完成初始化并注册单位 change');
    eq(resized.size, 1, '真实窗口装饰流程已注册宿主尺寸监听');
    eq(t.chart()?.axesOnly, true, '启动首绘没有伪造实时数据');
  }
  return t;
}

async function settle(t) {
  await new Promise((resolve) => setImmediate(resolve));
  await t.clock.advance(0);
  eq(t.document.errors.map(String).join(';'), '', '异步 DOM 事件无未捕获错误');
  eq(t.unexpected.join(','), '', '没有未声明的 IPC 调用');
}

// 快照、真实控件事件与状态断言。
function snapshot(n, status = 'ok', extra = {}) {
  const down = status === 'paused' ? 0 : n * 1e6;
  const up = status === 'paused' ? 0 : n * 2e6;
  return {
    Status: status, TimestampUnixMs: NOW + n * 1000, SessionStartedUnixMs: NOW - 60_000,
    TotalDownloadBytes: down, TotalUploadBytes: up, EventsLost: 0,
    Processes: [
      { Pid: 42, Name: 'browser.exe', Path: 'C:\\Apps\\browser.exe', StartTimeUnixMs: NOW - 30_000,
        DownloadBytes: down * 0.75, UploadBytes: up * 0.25, DownloadTotal: n * 10e6, UploadTotal: n * 5e6 },
      { Pid: 77, Name: 'agent.exe', Path: 'C:\\Apps\\agent.exe', StartTimeUnixMs: NOW - 20_000,
        DownloadBytes: down * 0.25, UploadBytes: up * 0.75, DownloadTotal: n * 5e6, UploadTotal: n * 10e6 },
    ],
    ...extra,
  };
}

async function fire(t, target, type, init = {}) {
  const event = new DomEvent(type, { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  await settle(t);
  return event;
}

async function click(t, target) {
  target.click();
  await settle(t);
}

async function navigate(t, screen) {
  const button = t.el('nav').querySelector(`[data-screen="${screen}"]`);
  // 从导航内部的 SVG 冒泡，经过 closest 和父容器委托，而非直接调用 setScreen。
  await fire(t, button.querySelector('svg') || button, 'click');
  eq(button.getAttribute('aria-current'), 'page', `导航确实切到 ${screen}`);
  eq(t.document.querySelector(`.screen[data-screen="${screen}"]`).hidden, false, '目标屏已显示');
}

async function unit(t, value) {
  t.el('setRateUnit').value = value;
  await fire(t, t.el('setRateUnit'), 'change');
}

async function visibility(t, hidden) {
  t.document.hidden = hidden;
  await fire(t, t.document, 'visibilitychange');
}

function mainRates(t) {
  return ['totalDownValue', 'totalDownUnit', 'totalUpValue', 'totalUpUnit']
    .map((id) => t.el(id).textContent).join('|');
}

function miniRates(t) {
  return ['orbDownV', 'orbDownU', 'orbUpV', 'orbUpU', 'ptDownV', 'ptDownU', 'ptUpV', 'ptUpU']
    .map((id) => t.el(id).textContent).join('|');
}

function mainOffline(t, label, waiting = false) {
  eq(t.ctx.NetPeekLive.lastSnapshot(), null, `${label}：实时缓存失效`);
  eq(mainRates(t), '—||—|', `${label}：速率和单位保持空态`);
  for (const id of ['totalDownValue', 'totalUpValue']) {
    eq(t.el(id).parentElement.classList.contains('is-blank'), true, `${label}：保持无数据样式`);
  }
  eq(t.el('statusText').textContent, '未连接采集服务', `${label}：不伪装在线`);
  eq(t.el('statusPill').classList.contains('is-ok'), false, `${label}：不恢复在线标记`);
  eq(t.el('frame').classList.contains('is-paused'), false, `${label}：不恢复旧暂停态`);
  eq(t.el('tableWrap').hidden, true, `${label}：旧行不重新可见`);
  eq(t.el('procSkeleton').hidden, !waiting, `${label}：等待骨架正确`);
  eq(t.el('procState').hidden, waiting, `${label}：断线异常态正确`);
  eq(t.el('procStateActions').hidden, waiting, `${label}：重试入口正确`);
  eq(t.chart()?.axesOnly, true, `${label}：曲线只剩坐标轴`);
  eq(t.el('fldService').textContent, '未连接采集服务', `${label}：检查栏仍离线`);
  eq(t.el('fldCoverage').textContent, '—', `${label}：无过期覆盖率`);
  eq(t.el('fldLost').textContent, '—', `${label}：无过期丢事件数`);
  eq(t.el('svcStatus').textContent, '未连接', `${label}：设置屏仍离线`);
  eq(t.el('svcPause').disabled, true, `${label}：不启用服务控制`);
}

function mainFrame(t, snap, rates) {
  const paused = snap.Status === 'paused';
  eq(t.ctx.NetPeekLive.lastSnapshot()?.TimestampUnixMs, snap.TimestampUnixMs, '缓存是最新帧');
  eq(t.ctx.NetPeekLive.lastSnapshot()?.Status, snap.Status, '缓存保留快照状态');
  eq(mainRates(t), rates, '顶栏显示本帧速率与当前单位');
  eq(t.el('statusText').textContent, paused ? '已暂停' : '监控中', '真实快照恢复对应状态');
  eq(t.el('frame').classList.contains('is-paused'), paused, '主窗暂停样式跟随本帧');
  eq(t.el('tableWrap').hidden, false, '有数据后显示进程表');
  eq(t.el('procSkeleton').hidden, true, '有数据后撤销等待骨架');
  eq(t.el('procState').hidden, true, '有数据后撤销断线异常态');
  eq(t.el('svcStatus').textContent, paused ? '已暂停' : '监控中', '真实设置模块收到本帧');
  eq(t.el('svcPause').disabled, false, '收到本帧后才允许服务控制');
  eq(t.chart()?.axesOnly === true, false, '有数据后才恢复带宽曲线');
  eq(t.chart()?.series?.[0].values.at(-1), snap.TotalDownloadBytes, '下载曲线尾部来自本帧');
  eq(t.chart()?.series?.[1].values.at(-1), snap.TotalUploadBytes, '上传曲线尾部来自本帧');
  eq(t.chart()?.dashFrom, paused ? t.chart().series[0].values.length - 1 : -1, '暂停虚线与恢复实线正确');
}

function miniOffline(t, label) {
  eq(miniRates(t), '--||--||--||--|', `${label}：球和面板均无旧速率或单位`);
  eq(t.el('panelDot').className, 'panel-dot is-error', `${label}：不恢复旧在线点`);
  eq(t.el('panelDot').title, '未连接采集服务', `${label}：状态文字仍离线`);
  eq(t.el('panelDot').getAttribute('aria-label'), '未连接采集服务', `${label}：读屏状态仍离线`);
  eq(t.el('orb').title, 'NetPeek · 未连接采集服务', `${label}：球提示仍离线`);
  eq(t.el('orb').classList.contains('is-paused'), false, `${label}：不恢复旧暂停态`);
  eq(t.el('btnPause').disabled, true, `${label}：服务控制保持禁用`);
  eq(t.el('orb').style.getPropertyValue('--level'), '0%', `${label}：不恢复旧水位`);
}

function miniFrame(t, snap, rates) {
  const paused = snap.Status === 'paused';
  eq(miniRates(t), rates, '球和面板使用同一帧读数');
  eq(t.el('panelDot').title, paused ? '已暂停' : '监控中', '小窗状态由新帧确认');
  eq(t.el('panelDot').className, paused ? 'panel-dot is-warn' : 'panel-dot is-ok', '小窗状态点正确');
  eq(t.el('orb').classList.contains('is-paused'), paused, '小窗暂停样式跟随快照');
  eq(t.el('btnPause').getAttribute('aria-pressed'), String(paused), '暂停控件语义跟随快照');
  eq(t.el('pauseLbl').textContent, paused ? '恢复' : '暂停', '暂停控件文案跟随快照');
  eq(t.el('btnPause').disabled, false, '收到新帧后才恢复小窗服务控制');
}

// 主窗口：断线、等待新帧及正常隐藏缓存。
async function redrawMain(t, waiting) {
  const steps = [
    ['切到历史', () => navigate(t, 'history')],
    ['切回实时', () => navigate(t, 'live')],
    ['切到设置', () => navigate(t, 'settings')],
    ['设置中切单位', () => unit(t, 'kb')],
    ['设置返回实时', () => navigate(t, 'live')],
    ['单位通知触发实时重绘', () => unit(t, 'mb')],
    ['按应用查看', () => click(t, t.el('viewToggle').querySelector('[data-view="app"]'))],
    ['按进程查看', () => click(t, t.el('viewToggle').querySelector('[data-view="process"]'))],
    ['搜索过滤', async () => { t.el('search').value = 'browser'; await fire(t, t.el('search'), 'input'); }],
    ['清空搜索', async () => { t.el('search').value = ''; await fire(t, t.el('search'), 'input'); }],
    ['表头排序', async () => {
      const th = t.document.querySelector('th[data-sort="download"]');
      await fire(t, th.querySelector('.sort-mark'), 'click');
      eq(th.getAttribute('aria-sort'), 'descending', '排序监听确实执行');
    }],
    ['恢复默认排序', async () => {
      await click(t, t.el('sortReset'));
      eq(t.el('sortReset').hidden, true, '排序复位监听确实执行');
    }],
    // 表格虽已隐藏，断线前排队的行事件也不能重放缓存。
    ['残留行选择', () => fire(t, t.el('rows').querySelector('.row-name'), 'click')],
    ['历史统计通知', () => fire(t, t.ctx, 'netpeek-historystats', { detail: { stats: { rows: 9, bytes: 4096 } } })],
    ['主题重绘', () => fire(t, t.ctx, 'netpeek-themechange')],
    ['窗口缩放防抖', async () => {
      await fire(t, t.ctx, 'resize');
      await t.clock.advance(120);
      await settle(t);
    }],
    ['宿主尺寸变化', () => click(t, t.el('winMax'))],
    ['隐藏再显示', async () => { await visibility(t, true); await visibility(t, false); }],
    ['分钟历史刷新', async () => {
      const count = t.calls.filter((c) => c.command === 'history_process_totals').length;
      await t.clock.advance(62_000);
      await settle(t);
      ok(t.calls.filter((c) => c.command === 'history_process_totals').length > count, '循环定时器确实刷新历史');
    }],
  ];
  for (const [label, run] of steps) {
    await run();
    mainOffline(t, label, waiting);
  }
}

for (const previous of ['ok', 'paused']) {
  section(`主窗：${previous} 快照 → 断线 → 各入口重绘 → connected 等待 → 新帧恢复`);
  const t = await fixture('main');
  const first = snapshot(1);
  await t.emit('snapshot', first);
  mainFrame(t, first, '1.00|MB/s|2.00|MB/s');
  eq(t.el('rows').children.length, 2, '完整渲染器创建真实进程行');
  if (previous === 'paused') {
    await navigate(t, 'settings');
    await click(t, t.el('svcPause'));
    eq(t.controls().at(-1)?.args.command, 'pause', '设置按钮通过真实事件发送暂停命令');
    eq(t.el('svcStatus').textContent, '监控中', '命令成功尚不代表暂停已生效');
    eq(t.el('svcPause').disabled, true, '等待快照确认时禁用按钮');
    const paused = snapshot(2, 'paused');
    await t.emit('snapshot', paused);
    await navigate(t, 'live');
    mainFrame(t, paused, '0|B/s|0|B/s');
    await navigate(t, 'settings'); // 断线不只发生在实时屏。
  }
  await t.emit('pipe-status', 'disconnected');
  mainOffline(t, '收到断线事件');
  await redrawMain(t, false);
  const commands = t.controls().length;
  await click(t, t.el('svcPause'));
  eq(t.controls().length, commands, '断线时禁用按钮不会发命令');
  await click(t, t.el('retryConnect'));
  mainOffline(t, '点击重试只进入等待', true);
  await t.emit('pipe-status', 'connected');
  await t.emit('pipe-status', 'connected');
  mainOffline(t, '重复 connected 也没有新帧', true);
  await redrawMain(t, true);
  await t.emit('pipe-status', 'disconnected');
  mainOffline(t, '等待中再次断线');
  await t.emit('pipe-status', 'connected');
  mainOffline(t, '再次连接仍要等快照', true);
  const fresh = snapshot(5);
  await t.emit('snapshot', fresh);
  mainFrame(t, fresh, '5.0|MB/s|10.0|MB/s');
  eq(t.el('totalDownValue').parentElement.classList.contains('is-blank'), false, '新帧撤销无数据样式');
  eq(t.el('rows').children[0].procData.UploadBytes, 7.5e6, '进程行也使用新帧而非旧缓存');
}

section('主窗：正常隐藏继续缓存、采样、记账和收图标，恢复只补画而不重复记账');
{
  const t = await fixture('main');
  await t.emit('snapshot', snapshot(1));
  const row = t.el('rows').children[0];
  const oldRates = mainRates(t), oldTotal = t.el('todayTotal').textContent;
  await visibility(t, true);
  const painted = t.drawings.length;
  await t.emit('snapshot', snapshot(2, 'ok', { IconUpdates: { 'C:\\Apps\\browser.exe': ICON } }));
  const latest = snapshot(3);
  await t.emit('snapshot', latest);
  eq(t.ctx.NetPeekLive.lastSnapshot()?.TimestampUnixMs, latest.TimestampUnixMs, '隐藏期间缓存推进到最新一帧');
  eq(mainRates(t), oldRates, '隐藏期间不绘制速率');
  eq(t.el('todayTotal').textContent, oldTotal, '隐藏期间不绘制今日合计');
  eq(t.el('rows').children[0], row, '隐藏期间不重建进程行');
  eq(t.drawings.length, painted, '隐藏期间不重画图表');
  await visibility(t, false);
  mainFrame(t, latest, '3.00|MB/s|6.00|MB/s');
  eq(t.chart().series[0].values.join(','), '1000000,2000000,3000000', '隐藏期间的采样一帧不少');
  eq(t.el('todayTotal').textContent, '18.0MB', '隐藏期间每帧记账，补画没有重复累计');
  eq(t.el('rows').children[0], row, '补画复用已有行节点');
  eq(t.ctx.NetPeekLive.iconForName('browser.exe'), ICON, '隐藏期间收到的增量图标仍然缓存');
  const browser = t.el('rows').children.find((r) => r.querySelector('.row-name').textContent === 'browser.exe');
  eq(browser.querySelector('img').src, ICON, '最新帧未重发图标也能绘制');
  await visibility(t, true);
  await visibility(t, false);
  eq(t.chart().series[0].values.length, 3, '重复显隐不重复采样');
  eq(t.el('todayTotal').textContent, '18.0MB', '重复显隐不重复记账');

  await visibility(t, true);
  const paused = snapshot(4, 'paused');
  await t.emit('snapshot', paused);
  eq(t.el('statusText').textContent, '监控中', '隐藏时不绘制暂停顶栏');
  eq(t.el('svcStatus').textContent, '已暂停', '隐藏时仍同步服务控制状态');
  await visibility(t, false);
  mainFrame(t, paused, '0|B/s|0|B/s');
  await visibility(t, true);
  const resumed = snapshot(5);
  await t.emit('snapshot', resumed);
  await visibility(t, false);
  mainFrame(t, resumed, '5.00|MB/s|10.00|MB/s');

  await visibility(t, true);
  await t.emit('snapshot', snapshot(6));
  await t.emit('pipe-status', 'disconnected');
  await t.emit('pipe-status', 'connected');
  await visibility(t, false);
  mainOffline(t, '隐藏期间缓存后断线，显示不能补画旧帧', true);
  const fresh = snapshot(7);
  await t.emit('snapshot', fresh);
  mainFrame(t, fresh, '7.00|MB/s|14.00|MB/s');

  await navigate(t, 'history');
  const before = t.drawings.length;
  const background = snapshot(8);
  await t.emit('snapshot', background);
  eq(t.drawings.length, before, '非实时屏只缓存快照，不重画实时图表');
  await visibility(t, true);
  await visibility(t, false);
  eq(mainRates(t), '7.00|MB/s|14.00|MB/s', '非实时屏恢复可见也不提前绘制实时件');
  await navigate(t, 'live');
  mainFrame(t, background, '8.00|MB/s|16.00|MB/s');
}

// 迷你窗口：断线、等待新帧及两路显隐缓存。
async function miniVisibility(t, visible, label = 'mini') {
  await t.emit('win-visibility', { label, visible });
}

async function redrawMini(t) {
  const steps = [
    ['点击球展开面板', async () => {
      await fire(t, t.el('orbDownV'), 'click');
      eq(t.el('panel').hidden, false, '球内元素的 click 冒泡到展开处理器');
      eq(t.el('orb').hidden, true, '展开后隐藏球');
    }],
    ['收起为球', async () => {
      await fire(t, t.el('btnCollapse').querySelector('svg'), 'click');
      eq(t.el('panel').hidden, true, '收起按钮里的 SVG 也能触发处理器');
      eq(t.el('orb').hidden, false, '收起后显示球');
    }],
    ['键盘展开', async () => {
      const event = await fire(t, t.el('orb'), 'keydown', { key: 'Enter' });
      eq(event.defaultPrevented, true, '键盘事件确实由球的处理器消费');
      eq(t.el('panel').hidden, false, '键盘展开后显示面板');
    }],
    ['托盘显示后尺寸对齐', async () => {
      const before = t.calls.length;
      await t.emit('mini-shown');
      eq(t.calls.length, before + 1, 'mini-shown 确实请求宿主重设尺寸');
      eq(t.calls.at(-1)?.command, 'set_mini_shape', '真实尺寸处理器执行');
      eq(t.calls.at(-1)?.args.shape, 'panel', '重设尺寸保留当前形态');
    }],
    ['document 隐藏再显示', async () => { await visibility(t, true); await visibility(t, false); }],
    ['宿主隐藏再显示', async () => { await miniVisibility(t, false); await miniVisibility(t, true); }],
    ['其他窗口显隐通知', () => miniVisibility(t, true, 'main')],
    ['主题广播', () => t.emit('theme-changed', { tokens: {} })],
  ];
  for (const [label, run] of steps) {
    await run();
    miniOffline(t, label);
  }
}

for (const previous of ['ok', 'paused']) {
  section(`小窗：${previous} 快照 → 断线 → 显隐/形态切换 → connected 等待 → 新帧恢复`);
  const t = await fixture('mini');
  await miniVisibility(t, true);
  const first = snapshot(1);
  await t.emit('snapshot', first);
  miniFrame(t, first, '1.00|MB/s|2.00|MB/s|1.00|MB/s|2.00|MB/s');
  eq(t.el('panelList').children.length, 2, '完整渲染器创建两条应用记录');
  const rates = miniRates(t), level = t.el('orb').style.getPropertyValue('--level');
  const row = t.el('panelList').firstElementChild;
  if (previous === 'paused') {
    await click(t, t.el('orb'));
    await click(t, t.el('btnPause'));
    eq(t.controls().at(-1)?.args.command, 'pause', '小窗按钮通过真实事件发送暂停命令');
    eq(t.el('panelDot').title, '监控中', '命令成功不能提前显示已暂停');
    eq(t.el('btnPause').disabled, true, '等待暂停快照时禁用按钮');
    const paused = snapshot(2, 'paused');
    await t.emit('snapshot', paused);
    miniFrame(t, paused, rates);
    eq(t.el('orb').style.getPropertyValue('--level'), level, '正常暂停冻结上一帧水位');
    ok(t.el('panelList').firstElementChild === row, '正常暂停不重画应用列表');
  }
  await t.emit('pipe-status', 'disconnected');
  miniOffline(t, '收到断线事件');
  await redrawMini(t);
  const commands = t.controls().length;
  await click(t, t.el('btnPause'));
  eq(t.controls().length, commands, '离线时禁用的小窗按钮不发送命令');
  await t.emit('pipe-status', 'connected');
  await t.emit('pipe-status', 'connected');
  miniOffline(t, '重复 connected 也要等待新帧');
  await redrawMini(t);
  await t.emit('pipe-status', 'disconnected');
  miniOffline(t, '等待期间再次断线');
  await t.emit('pipe-status', 'connected');
  miniOffline(t, '再次 connected 仍未收到新帧');

  // 重连后首帧也可能是 paused：只能确认暂停，不能借出断线前的速率和水位。
  const paused = snapshot(4, 'paused');
  await t.emit('snapshot', paused);
  miniFrame(t, paused, '--||--||--||--|');
  eq(t.el('orb').style.getPropertyValue('--level'), '0%', '新暂停帧不能恢复断线前的水位');
  await click(t, t.el('btnPause'));
  eq(t.controls().at(-1)?.args.command, 'resume', '新暂停帧到达后允许发送恢复命令');
  eq(t.el('panelDot').title, '已暂停', '恢复命令成功也须等新帧确认');
  const fresh = snapshot(5);
  await t.emit('snapshot', fresh);
  miniFrame(t, fresh, '5.00|MB/s|10.0|MB/s|5.00|MB/s|10.0|MB/s');
  ok(parseFloat(t.el('orb').style.getPropertyValue('--level')) > 0, '新速率恢复水位');
  eq(t.el('panelList').firstElementChild.querySelector('.prate.is-up').textContent.trim(), '7.50 MB/s', '应用列表使用恢复后的新速率');
}

for (const source of ['document', 'host']) {
  section(`小窗：${source} 隐藏缓存、双信号门控、暂停冻结及隐藏断线恢复`);
  const t = await fixture('mini');
  const hide = () => source === 'document' ? visibility(t, true) : miniVisibility(t, false);
  const show = () => source === 'document' ? visibility(t, false) : miniVisibility(t, true);
  const first = snapshot(1);
  await t.emit('snapshot', first);
  eq(miniRates(t), '--||--||--||--|', '宿主初始隐藏时只缓存，不渲染');
  await visibility(t, false);
  await miniVisibility(t, true, 'main');
  eq(miniRates(t), '--||--||--||--|', 'document 可见和其他窗口通知都不能越过宿主隐藏门控');
  await miniVisibility(t, true);
  miniFrame(t, first, '1.00|MB/s|2.00|MB/s|1.00|MB/s|2.00|MB/s');

  const rates = miniRates(t), level = t.el('orb').style.getPropertyValue('--level');
  const row = t.el('panelList').firstElementChild;
  await hide();
  await t.emit('snapshot', snapshot(2, 'ok', { IconUpdates: { 'C:\\Apps\\browser.exe': ICON } }));
  const latest = snapshot(3);
  await t.emit('snapshot', latest);
  if (source === 'document') {
    await miniVisibility(t, false);
    await miniVisibility(t, true);
  } else {
    await visibility(t, true);
    await visibility(t, false);
  }
  eq(miniRates(t), rates, '另一条可见信号不能越过当前隐藏门控');
  eq(t.el('orb').style.getPropertyValue('--level'), level, '隐藏期间不更新水位');
  ok(t.el('panelList').firstElementChild === row, '隐藏期间不重建列表节点');
  await show();
  miniFrame(t, latest, '3.00|MB/s|6.00|MB/s|3.00|MB/s|6.00|MB/s');
  const browser = t.el('panelList').children.find((r) => r.querySelector('.pname').textContent === 'browser.exe');
  eq(browser.querySelector('img').src, ICON, '隐藏期间缓存图标，最新帧无需重发也能补画');

  const beforePause = miniRates(t), pauseLevel = t.el('orb').style.getPropertyValue('--level');
  const pauseRow = t.el('panelList').firstElementChild;
  await hide();
  await t.emit('snapshot', snapshot(4));
  const paused = snapshot(5, 'paused');
  await t.emit('snapshot', paused);
  eq(t.el('panelDot').title, '监控中', '隐藏期间只缓存暂停态，不更新状态点');
  await show();
  miniFrame(t, paused, beforePause);
  eq(t.el('orb').style.getPropertyValue('--level'), pauseLevel, '补画暂停帧仍冻结最后可见水位');
  ok(t.el('panelList').firstElementChild === pauseRow, '补画暂停帧不把隐藏期间的中间帧当作可见帧');
  await hide();
  const resumed = snapshot(6);
  await t.emit('snapshot', resumed);
  await show();
  miniFrame(t, resumed, '6.00|MB/s|12.0|MB/s|6.00|MB/s|12.0|MB/s');

  await hide();
  await t.emit('snapshot', snapshot(7));
  await t.emit('snapshot', snapshot(8, 'paused'));
  await t.emit('pipe-status', 'disconnected');
  await t.emit('pipe-status', 'connected');
  await show();
  miniOffline(t, '隐藏期间缓存后断线，显示不能恢复旧暂停态或速率');
  await hide();
  const fresh = snapshot(9);
  await t.emit('snapshot', fresh);
  miniOffline(t, '等待中收到隐藏新帧，仍不提前绘制');
  await show();
  miniFrame(t, fresh, '9.00|MB/s|18.0|MB/s|9.00|MB/s|18.0|MB/s');
  await miniVisibility(t, false, 'main');
  const next = snapshot(10);
  await t.emit('snapshot', next);
  miniFrame(t, next, '10.0|MB/s|20.0|MB/s|10.0|MB/s|20.0|MB/s');
}

process.exit(report('disconnect-events.test'));
