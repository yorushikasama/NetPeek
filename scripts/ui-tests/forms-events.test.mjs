// 表单事件回归：解析现有 HTML，原样加载 IIFE，不抽取、替换或导出私有业务函数。
// 边界桩仅覆盖 IPC、时钟、存储和图表；change/input 必须从控件冒泡，submit 必须走表单。
// 运行：node scripts/ui-tests/forms-events.test.mjs
import { loadScripts, readUi, eq, ok, section, report } from './_harness.mjs';
import { DomEvent, EventTarget, makeEventDocument } from './_event-dom.mjs';

const NOW = new Date('2026-10-02T12:34:56').getTime();
const TODAY = '2026-10-02';
const PAST = '2026-10-01';
const LS_KEY = 'netpeek-settings';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
const seconds = (date, time) => new Date(`${date}T${time}:00`).getTime() / 1000;
const fail = () => { throw new Error('模拟 IPC 失败'); };

function fixture({ replies = {}, cached = {}, tauri = true } = {}) {
  const document = makeEventDocument(readUi('index.html'));
  const events = Object.assign(new EventTarget(), { ownerDocument: document });
  const calls = [], drawings = [], unexpected = [];
  const stored = new Map([[LS_KEY, JSON.stringify(cached)]]);
  const localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
  };
  const answers = {
    load_settings: JSON.stringify({ autostart: false, rateUnit: 'auto', retentionDays: 30 }),
    save_settings: undefined,
    get_autostart: false,
    history_stats: JSON.stringify({ rows: 0, bytes: 0 }),
    history_daily: '[]', history_range: '[]', history_range_days: '[]',
    data_dir_path: 'C:\\NetPeek', collector_log_path: 'C:\\NetPeek\\collector.log',
    country_db_info: JSON.stringify({ mode: 'builtin' }),
    ...replies,
  };
  const ctx = loadScripts(['common.js', 'settings-ui.js', 'history-ui.js'], {
    document, localStorage, Date: FixedDate, Event: DomEvent, CustomEvent: DomEvent,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    NetPeekCharts: {
      bars: (_canvas, options) => { drawings.push(options); return { indexAt: () => -1 }; },
      axisBytes: (value) => `${value} B`,
    },
    __TAURI__: tauri ? { core: { async invoke(command, args = {}) {
      calls.push({ command, args });
      if (!Object.hasOwn(answers, command)) { unexpected.push(command); throw new Error(command); }
      const answer = answers[command];
      return typeof answer === 'function' ? answer(args) : answer;
    } } } : undefined,
  });
  eq(ctx.NetPeekCommon._missingIds.length, 0, '真实 HTML 包含两个业务脚本依赖的全部节点');
  return {
    ctx, document, calls, drawings, unexpected, localStorage,
    el: (id) => document.getElementById(id),
    queries: () => calls.filter((c) => ['history_daily', 'history_range', 'history_range_days'].includes(c.command)),
    saves: () => calls.filter((c) => c.command === 'save_settings').map((c) => JSON.parse(c.args.json)),
    cached: () => JSON.parse(localStorage.getItem(LS_KEY)),
  };
}

async function settle(t) {
  await new Promise((resolve) => setImmediate(resolve));
  eq(t.document.errors.map(String).join(';'), '', '异步事件处理无未捕获错误');
  eq(t.unexpected.join(','), '', '没有未声明的 IPC 调用');
}
function change(t, id, value, type = 'change') {
  const el = t.el(id);
  if (el.getAttribute('type') === 'checkbox') el.checked = value;
  else el.value = value;
  el.dispatchEvent(new DomEvent(type, { bubbles: true }));
}
function draft(t, start, end, startTime = '', endTime = '') {
  for (const [id, value] of Object.entries({ histStartDate: start, histEndDate: end, histStartTime: startTime, histEndTime: endTime })) {
    change(t, id, value);
  }
}
async function openHistory(t) { t.el('histCustomToggle').click(); await settle(t); }
async function submit(t) {
  const event = new DomEvent('submit', { bubbles: true, cancelable: true });
  t.el('histCustomRange').dispatchEvent(event);
  eq(event.defaultPrevented, true, 'submit 由现有处理器阻止默认导航');
  await settle(t);
}
async function flush(t) { t.ctx.dispatchEvent(new DomEvent('blur')); await settle(t); }
function rangeValues(t) {
  return ['histStartDate', 'histEndDate', 'histStartTime', 'histEndTime'].map((id) => t.el(id).value);
}
function checkQuery(t, command, args) {
  eq(JSON.stringify(t.queries().at(-1)), JSON.stringify({ command, args }), '查询命令及边界准确');
  eq(t.el('histCustomRange').hidden, true, '合法提交关闭表单');
  eq(t.el('histRangeError').hidden, true, '合法提交不残留错误');
  eq(t.el('histCustomToggle').classList.contains('is-active'), true, '自定义范围成为当前档位');
}
function checkRejected(t, message, values, queryCount, drawingCount) {
  eq(t.el('histCustomRange').hidden, false, '非法提交留在原表单');
  eq(t.el('histCustomToggle').getAttribute('aria-expanded'), 'true', '表单展开态不变');
  eq(t.el('histRangeError').hidden, false, '错误就地显示');
  eq(t.el('histRangeError').textContent, message, '错误明确指向原始输入');
  eq(JSON.stringify(rangeValues(t)), JSON.stringify(values), '四个控件保留原始输入');
  eq(t.queries().length, queryCount, '非法提交不发历史查询');
  eq(t.drawings.length, drawingCount, '非法提交不替换已有图表');
  eq(t.el('histCustomToggle').classList.contains('is-active'), false, '非法范围不成为当前档位');
}

// 历史表单事件用例。
section('历史：change → submit 拦截反向时刻 / 未来起点，原地修正后可提交');
for (const sample of [
  { date: PAST, startTime: '18:00', endTime: '08:00', error: '开始时刻不能晚于结束时刻。', corrected: '06:00', end: seconds(PAST, '08:00') },
  { date: TODAY, startTime: '18:00', endTime: '20:00', error: '开始时间不能晚于当前时间。', corrected: '08:00', end: NOW / 1000 },
]) {
  const t = fixture();
  await t.ctx.NetPeekHistoryUI.onEnter();
  await openHistory(t);
  const queryCount = t.queries().length, drawingCount = t.drawings.length;
  const values = [sample.date, sample.date, sample.startTime, sample.endTime];
  draft(t, ...values);
  eq(t.el('histStartTimeWrap').hidden, false, '非法时刻仍可见，便于原地修正');
  eq(t.el('histEndTimeWrap').hidden, false, '结束时刻也不因非法范围消失');
  eq(t.el('histGranNote').textContent, '', '非法范围不误报为超过三天');
  await submit(t);
  checkRejected(t, sample.error, values, queryCount, drawingCount);
  eq(t.el('histRangeTitle').textContent, '近 30 天', '错误不覆盖已有范围标题');
  eq(t.el('histRange').querySelector('button[data-days="30"]').classList.contains('is-active'), true, '原预设仍生效');

  // 显隐只是展示状态：即使它滞后，也不能跳过原始时刻校验。
  t.el('histStartTimeWrap').hidden = t.el('histEndTimeWrap').hidden = true;
  await submit(t);
  checkRejected(t, sample.error, values, queryCount, drawingCount);

  change(t, 'histStartTime', sample.corrected);
  await submit(t);
  eq(t.queries().length, queryCount + 1, '修正后的范围只发一次查询');
  checkQuery(t, 'history_range', { start: seconds(sample.date, sample.corrected), end: sample.end, bucket: 3600, anchor: 0 });
}

section('历史：日期校验保留原有错误优先级与输入');
for (const [start, end, error, replies] of [
  ['', TODAY, '请选择开始日期和结束日期。'],
  [TODAY, '', '请选择开始日期和结束日期。'],
  [TODAY, PAST, '开始日期不能晚于结束日期。'],
  [TODAY, '2026-10-03', '结束日期不能晚于今天。'],
  ['2010-01-01', TODAY, '区间最长 3660 天（约 10 年）。'],
  ['2026-09-01', '2026-09-02', `历史库最早记录是 ${PAST}，这个区间没有数据。`, { history_stats: JSON.stringify({ firstTs: seconds(PAST, '00:00'), rows: 1 }) }],
]) {
  const t = fixture({ replies });
  await openHistory(t);
  const values = [start, end, '08:00', '12:00'];
  draft(t, ...values);
  await submit(t);
  checkRejected(t, error, values, 0, 0);
}

section('历史：合法短范围按小时查询、绘图、合计并保留明确时刻');
{
  const t = fixture({ replies: { history_range: JSON.stringify([
    { ts: seconds(PAST, '08:00'), name: 'browser.exe', down: 120, up: 20 },
    { ts: seconds(PAST, '10:00'), name: 'browser.exe', down: 80, up: 30 },
  ]) } });
  await openHistory(t);
  draft(t, PAST, PAST, '08:00', '12:00');
  eq(t.el('histGranNote').textContent, '按小时聚合 · 共 4 小时', '短范围预览与骨架一致');
  await submit(t);
  checkQuery(t, 'history_range', { start: seconds(PAST, '08:00'), end: seconds(PAST, '12:00'), bucket: 3600, anchor: 0 });
  eq(t.drawings.at(-1)?.groups.length, 4, '结束整点不多画一根柱');
  eq(t.el('histSumDown').textContent, '200B', '小时下载合计正确');
  eq(t.el('histSumUp').textContent, '50B', '小时上传合计正确');
  eq(t.el('histSumAll').textContent, '250B', '小时总量正确');
  await openHistory(t);
  eq(JSON.stringify(rangeValues(t)), JSON.stringify([PAST, PAST, '08:00', '12:00']), '重新打开保留明确时刻');
}

section('历史：默认全天仍按小时查询今天，未来上界截到现在');
{
  const t = fixture();
  await openHistory(t);
  eq(JSON.stringify(rangeValues(t)), JSON.stringify([TODAY, TODAY, '', '']), '默认今天全天不伪造用户时刻');
  await submit(t);
  checkQuery(t, 'history_range', { start: seconds(TODAY, '00:00'), end: NOW / 1000, bucket: 3600, anchor: 0 });
  eq(t.drawings.at(-1)?.groups.length, 13, '今天保留当前小时');
}

section('历史：72 小时边界与长范围日 / 周聚合');
for (const sample of [
  { start: '2026-09-28', time: '08:00', hourly: true, days: 4, note: '按小时聚合 · 共 72 小时' },
  { start: '2026-09-28', time: '07:00', hourly: false, days: 4, note: '按天聚合 · 共 4 天（超过 3 天，时刻不参与）' },
  { start: '2026-07-01', time: '08:00', hourly: false, days: 93, note: '按周聚合 · 共 93 天（超过 3 天，时刻不参与）' },
]) {
  const t = fixture();
  await openHistory(t);
  draft(t, sample.start, PAST, sample.time, '08:00');
  eq(t.el('histGranNote').textContent, sample.note, '粒度预览准确');
  eq(t.el('histStartTimeWrap').hidden, !sample.hourly, '合法长范围才收起时刻');
  await submit(t);
  if (sample.hourly) {
    checkQuery(t, 'history_range', { start: seconds(sample.start, sample.time), end: seconds(PAST, '08:00'), bucket: 3600, anchor: 0 });
    eq(t.drawings.at(-1)?.groups.length, 72, '72 小时仍保留小时骨架');
  } else {
    checkQuery(t, 'history_range_days', { start: sample.start, end: PAST });
    eq(t.drawings.at(-1)?.groups.reduce((n, group) => n + group.slots.length, 0), sample.days, '日 / 周骨架覆盖完整日期范围');
    eq(t.el('histAggNote').hidden, sample.days <= 60, '周聚合标记与范围一致');
    await openHistory(t);
    eq(t.el('histStartTime').value, '', '长范围生效后开始时刻归一为全天');
    eq(t.el('histEndTime').value, '', '长范围生效后结束时刻归一为全天');
  }
}

section('历史：change / input 切换长短范围不清掉草稿时刻');
{
  const t = fixture({ replies: { history_range_days: JSON.stringify([
    { day: '2026-09-01', name: 'browser.exe', down: 300, up: 40 },
    { day: PAST, name: 'browser.exe', down: 100, up: 60 },
  ]) } });
  await openHistory(t);
  draft(t, PAST, PAST, '08:00', '12:00');
  change(t, 'histStartDate', '2026-09-01');
  eq(t.el('histStartTimeWrap').hidden, true, 'change 冒泡切到长范围');
  eq(t.el('histStartTime').value, '08:00', '隐藏不清掉开始时刻草稿');
  eq(t.el('histEndTime').value, '12:00', '隐藏不清掉结束时刻草稿');
  change(t, 'histStartDate', PAST, 'input');
  eq(t.el('histStartTimeWrap').hidden, false, 'input 冒泡切回短范围');
  eq(t.el('histGranNote').textContent, '按小时聚合 · 共 4 小时', '切回短范围按原时刻预览');
  change(t, 'histStartDate', '2026-09-01');
  await submit(t);
  checkQuery(t, 'history_range_days', { start: '2026-09-01', end: PAST });
  eq(t.el('histSumAll').textContent, '500B', '合法长范围的合计仍正常');
}

// 自启动表单事件用例。通过后续 save_settings / localStorage 观察私有 state，不导出测试钩子。
section('自启动：初始化回读同时同步复选框与后续保存状态（双向）');
for (const actual of [true, false]) {
  const t = fixture({ replies: {
    load_settings: JSON.stringify({ autostart: !actual, rateUnit: 'auto', retentionDays: 30 }),
    get_autostart: actual,
  } });
  await t.ctx.NetPeekSettingsUI.init();
  await settle(t);
  eq(t.el('setAutostart').checked, actual, '初始化勾选态以注册表为准');
  eq(t.saves().length, 0, '初始化回读不额外写盘');
  change(t, 'setRateUnit', 'mb');
  await flush(t);
  eq(t.saves().length, 1, '无关设置仍防抖保存一次');
  eq(t.saves().at(-1)?.rateUnit, 'mb', '单位改动正常保存');
  eq(t.saves().at(-1)?.autostart, actual, '无关设置不把旧文件自启动值写回');
}

section('自启动：change 立即保存后回读，后续保存不反弹（双向）');
for (const actual of [false, true]) {
  let reads = 0;
  const t = fixture({ replies: {
    load_settings: JSON.stringify({ autostart: actual }),
    get_autostart: () => { reads++; return actual; },
  } });
  await t.ctx.NetPeekSettingsUI.init();
  const before = t.calls.length;
  change(t, 'setAutostart', !actual);
  await settle(t);
  eq(t.saves().length, 1, '自启动 change 不等待防抖');
  eq(t.saves()[0]?.autostart, !actual, '先保存用户请求的状态');
  eq(t.calls.slice(before).map((call) => call.command).join(','), 'save_settings,get_autostart', '写入完成后才回读');
  eq(t.el('setAutostart').checked, actual, '回读不一致时复选框显示实际值');
  eq(reads, 2, '初始化和变更后各回读一次');
  change(t, 'setRecordUnattributed', false);
  await flush(t);
  eq(t.saves().length, 2, '无关变更仍可正常保存');
  eq(t.saves().at(-1)?.recordUnattributed, false, '无关字段保存正常');
  eq(t.saves().at(-1)?.autostart, actual, '后续保存沿用实际值而非刚才的请求值');
}

section('自启动：初始化回读失败保留文件值 / 缓存值 / 默认值');
for (const sample of [
  { replies: { load_settings: JSON.stringify({ autostart: true }) }, expected: true },
  { replies: { load_settings: fail }, cached: { autostart: true }, expected: true },
  { replies: { load_settings: fail }, expected: false },
]) {
  const t = fixture({ cached: sample.cached, replies: { ...sample.replies, get_autostart: fail } });
  await t.ctx.NetPeekSettingsUI.init();
  await settle(t);
  eq(t.el('setAutostart').checked, sample.expected, '初始化失败保留原降级勾选态');
  change(t, 'setRateUnit', 'kb');
  await flush(t);
  eq(t.saves().at(-1)?.autostart, sample.expected, '初始化失败保留原降级状态');
}

section('自启动：变更后回读失败不回滚用户选择（双向）');
for (const initial of [false, true]) {
  let reads = 0;
  const t = fixture({ replies: {
    load_settings: JSON.stringify({ autostart: initial }),
    get_autostart: () => ++reads === 1 ? initial : fail(),
  } });
  await t.ctx.NetPeekSettingsUI.init();
  change(t, 'setAutostart', !initial);
  await settle(t);
  eq(t.el('setAutostart').checked, !initial, '回读失败保留用户勾选态');
  change(t, 'setRateUnit', 'gb');
  await flush(t);
  eq(t.saves().at(-1)?.autostart, !initial, '回读失败后内部状态仍是用户选择');
}

section('自启动：保存失败仍写本地缓存，成功回读参与后续降级保存');
{
  const t = fixture({ replies: { save_settings: fail, get_autostart: false } });
  await t.ctx.NetPeekSettingsUI.init();
  change(t, 'setAutostart', true);
  await settle(t);
  eq(t.cached().autostart, true, '保存失败时先缓存用户请求');
  eq(t.el('setAutostart').checked, false, '保存失败后仍尝试注册表回读');
  change(t, 'setRateUnit', 'mb');
  await flush(t);
  eq(t.cached().rateUnit, 'mb', '其他设置仍能降级保存');
  eq(t.cached().autostart, false, '后续降级保存使用已回读的实际状态');
}

section('自启动：无 Tauri 时保持本地缓存降级流程');
{
  const t = fixture({ tauri: false, cached: { autostart: true, rateUnit: 'kb' } });
  await t.ctx.NetPeekSettingsUI.init();
  await settle(t);
  eq(t.el('setAutostart').checked, true, '浏览器环境从缓存加载勾选态');
  change(t, 'setAutostart', false);
  await settle(t);
  eq(t.el('setAutostart').checked, false, '回读不可用时保留新勾选态');
  eq(t.cached().autostart, false, '自启动变更降级到缓存');
  change(t, 'setRateUnit', 'mb');
  await flush(t);
  eq(t.cached().autostart, false, '无关设置不重置缓存自启动状态');
  eq(t.cached().rateUnit, 'mb', '无关设置继续写缓存');
  eq(t.calls.length, 0, '浏览器环境没有 IPC 调用');
}

process.exit(report('forms-events.test'));
