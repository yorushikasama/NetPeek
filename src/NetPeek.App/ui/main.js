// NetPeek 前端主逻辑。监听采集服务经 Tauri 转发的 TrafficSnapshot 事件，
// 渲染顶栏总速率、进程表、检查栏与两张实时图；同时负责屏切换、密集模式和无边框窗口的控制。
// 快照字段为 PascalCase（与 C# System.Text.Json 默认序列化一致）。
//
// 布局与样式规格见 docs/UI生成提示词.md §2–3。几条关键约束在这里体现：
// - 数字直接替换，不做补间：数据每秒一帧，补间等于永远在滚（§3.6）。
// - 一张图只答一个问题：底部带宽图答「总带宽这一分钟怎么走的」，
//   检查栏实时图答「这个应用这一分钟怎么走的」，30 天图答「这个应用一个月用了多少」。
// - 装饰性动效只有一处：从静默跨到有流量的那一刻，岛屿外发光涨一次再落回。

const { listen } = window.__TAURI__.event;
const C = window.NetPeekCharts;
const $ = (id) => document.getElementById(id);

const WINDOW_SECS = 60;      // 两张实时图的时间窗
const DENSE_KEY = 'netpeek-dense';

const els = {
  frame: $('frame'),
  shell: $('shell'),
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  lostDot: $('lostDot'),
  totalDownValue: $('totalDownValue'),
  totalDownUnit: $('totalDownUnit'),
  totalUpValue: $('totalUpValue'),
  totalUpUnit: $('totalUpUnit'),
  todayTotal: $('todayTotal'),
  viewToggle: $('viewToggle'),
  search: $('search'),
  pidLabel: $('pidLabel'),
  rows: $('rows'),
  tableWrap: $('tableWrap'),
  procState: $('procState'),
  procStateTitle: $('procStateTitle'),
  procStateDesc: $('procStateDesc'),
  bandwidthChart: $('bandwidthChart'),
  denseGrip: $('denseGrip'),
  nav: $('nav'),
  stagePickBg: $('stagePickBg'),
  inspIcon: $('inspIcon'),
  inspIconPh: $('inspIconPh'),
  inspName: $('inspName'),
  inspPath: $('inspPath'),
  inspMeta: $('inspMeta'),
  inspDownTotal: $('inspDownTotal'),
  inspUpTotal: $('inspUpTotal'),
  inspUpLabel: $('inspUpLabel'),
  inspLiveSec: $('inspLiveSec'),
  inspLiveDown: $('inspLiveDown'),
  inspLiveUp: $('inspLiveUp'),
  inspLiveChart: $('inspLiveChart'),
  inspFieldsSec: $('inspFieldsSec'),
  fldCoverage: $('fldCoverage'),
  fldService: $('fldService'),
  fldLost: $('fldLost'),
  fldDbSize: $('fldDbSize'),
  attribNote: $('attribNote'),
  insp30Title: $('insp30Title'),
  insp30Total: $('insp30Total'),
  insp30Chart: $('insp30Chart'),
};

// ===== 状态 =====

let lastSnapshot = null;
let query = '';
let sortKey = 'download';
let sortDir = -1;              // 1 升序 / -1 降序
let viewMode = 'process';      // process 按进程明细 / app 按应用聚合
let rateUnit = 'auto';         // 由设置屏更新
let selected = null;           // { keyStr, mode, key, data }
let screen = 'live';
let wasIdle = true;            // 上一帧是否静默，用于发光脉冲的边界判定
let todayBase = 0;             // 今日已落库的字节数（启动时从历史库取）
let todayDelta = 0;            // 启动之后累加的字节数
let todayStamp = new Date().toDateString();

// 总带宽 60 秒环形缓冲
const samples = [];            // { t, down, up }
// 每个进程的 60 秒速率环形缓冲。键用 PID + 启动时刻：PID 会被系统复用，
// 只按 PID 存会把新进程接到上一个进程的曲线尾巴上（后端历史聚合同样按这两项）。
const procHist = new Map();    // "pid:startMs" -> { t: [], down: [], up: [] }

function histKey(p) {
  return `${p.Pid}:${p.StartTimeUnixMs || 0}`;
}

// ===== 格式化 =====

function fmtRate(bps) {
  if (rateUnit === 'kb') return `${(bps / 1e3).toFixed(1)} KB/s`;
  if (rateUnit === 'mb') return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (rateUnit === 'gb') return `${(bps / 1e9).toFixed(2)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtBytes(bytes) {
  if (rateUnit === 'kb') return `${(bytes / 1e3).toFixed(1)} KB`;
  if (rateUnit === 'mb') return `${(bytes / 1e6).toFixed(1)} MB`;
  if (rateUnit === 'gb') return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

// 图标取不到时的首字母占位。未归因流量的名字是「(系统/未归因)」，
// 直接切首字符会在徽标里画一个孤零零的半角括号，读成渲染出错而不是占位。
const UNATTR = '(系统/未归因)';
function initialOf(name, len) {
  const s = String(name || '').replace(/^[^\p{L}\p{N}]+/u, '');
  if (!s) return '·';
  return s.slice(0, len || 1).toUpperCase();
}

// 顶栏的数字和单位分两个元素：单位降到 75% 不透明度且不跟着数字放大（§2.2）
function splitUnit(text) {
  const i = text.lastIndexOf(' ');
  return i < 0 ? { value: text, unit: '' } : { value: text.slice(0, i), unit: text.slice(i + 1) };
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== 采样缓冲 =====

function pushSamples(snap) {
  const t = (snap.TimestampUnixMs || Date.now()) / 1000;
  samples.push({ t, down: snap.TotalDownloadBytes || 0, up: snap.TotalUploadBytes || 0 });
  while (samples.length > WINDOW_SECS) samples.shift();

  const seen = new Set();
  for (const p of snap.Processes || []) {
    const k = histKey(p);
    seen.add(k);
    let h = procHist.get(k);
    if (!h) { h = { t: [], down: [], up: [] }; procHist.set(k, h); }
    h.t.push(t);
    h.down.push(p.DownloadBytes || 0);
    h.up.push(p.UploadBytes || 0);
    if (h.t.length > WINDOW_SECS) { h.t.shift(); h.down.shift(); h.up.shift(); }
  }
  // 采集端约 30 帧后移除退出的进程；这里再等到 60 秒无更新才丢历史
  for (const [k, h] of procHist) {
    if (!seen.has(k) && h.t.length && t - h.t[h.t.length - 1] > WINDOW_SECS) procHist.delete(k);
  }
}

// 今日合计：启动时以历史库当日已落库量为底，之后累加每帧增量。
// 跨过本地零点就把底清零 —— 「今日」是本地日期，不是启动以来。
function accumulateToday(snap) {
  const stamp = new Date().toDateString();
  if (stamp !== todayStamp) {
    todayStamp = stamp;
    todayBase = 0;
    todayDelta = 0;
  }
  todayDelta += (snap.TotalDownloadBytes || 0) + (snap.TotalUploadBytes || 0);
}

async function loadTodayBase() {
  try {
    const raw = await window.__TAURI__.core.invoke('history_daily', { days: 1 });
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    let sum = 0;
    for (const r of JSON.parse(raw || '[]')) {
      if (r.day === key) sum += (r.down || 0) + (r.up || 0);
    }
    todayBase = sum;
  } catch { todayBase = 0; }
}

// ===== 顶栏 =====

const STATUS = {
  ok:        { cls: 'is-ok',    text: '监控中' },
  paused:    { cls: 'is-warn',  text: '已暂停' },
  error:     { cls: 'is-error', text: '服务异常 · 需管理员权限' },
  connecting:{ cls: 'is-warn',  text: '连接中' },
  offline:   { cls: '',         text: '未连接采集服务' },
};

function setStatus(kind) {
  const s = STATUS[kind] || STATUS.offline;
  els.statusPill.className = `status-pill ${s.cls}`.trim();
  els.statusText.textContent = s.text;
  els.frame.classList.toggle('is-paused', kind === 'paused');
}

function renderTopbar(snap) {
  const down = splitUnit(fmtRate(snap.TotalDownloadBytes || 0));
  const up = splitUnit(fmtRate(snap.TotalUploadBytes || 0));
  els.totalDownValue.textContent = down.value;
  els.totalDownUnit.textContent = down.unit;
  els.totalUpValue.textContent = up.value;
  els.totalUpUnit.textContent = up.unit;
  els.todayTotal.textContent = fmtBytes(todayBase + todayDelta);

  const lost = snap.EventsLost || 0;
  els.lostDot.hidden = lost === 0;
  if (lost > 0) els.lostDot.title = `事件丢失 ${lost} 条 · 实际用量可能高于显示值`;

  setStatus(snap.Status === 'ok' ? 'ok' : snap.Status === 'paused' ? 'paused' : 'error');
}

// 从静默跨到有流量的那一刻，四块岛屿的外发光涨一次再落回。
// 只在跨过边界时触发一次，速率持续变化时发光不动（§3.6）。
function pulseIfWaking(snap) {
  const busy = (snap.TotalDownloadBytes || 0) + (snap.TotalUploadBytes || 0) > 0;
  if (busy && wasIdle && snap.Status === 'ok') {
    const islands = document.querySelectorAll('.island');
    islands.forEach((el) => el.classList.remove('is-waking'));
    // 强制回流后再加类，否则连续触发时动画不会重播
    void els.shell.offsetWidth;
    islands.forEach((el) => el.classList.add('is-waking'));
    setTimeout(() => islands.forEach((el) => el.classList.remove('is-waking')), 320);
  }
  wasIdle = !busy;
}

// ===== 进程表 =====

const sortAccessors = {
  name: (p) => (p.Name || '').toLowerCase(),
  pid: (p) => p.Pid,
  download: (p) => p.DownloadBytes || 0,
  upload: (p) => p.UploadBytes || 0,
};

function visibleProcesses(snap) {
  let procs = (snap.Processes || []).slice();
  if (query) {
    const q = query.trim().toLowerCase();
    procs = procs.filter((p) =>
      (p.Name || '').toLowerCase().includes(q) || String(p.Pid).includes(q));
  }

  if (viewMode === 'app') {
    const map = new Map();
    for (const p of procs) {
      const name = (p.Name || '').trim() || '(系统/未归因)';
      const key = name.toLowerCase();
      let agg = map.get(key);
      if (!agg) {
        agg = {
          Name: name, IconBase64: '', Pid: 0, Path: p.Path || '', StartTimeUnixMs: 0,
          DownloadBytes: 0, UploadBytes: 0, DownloadTotal: 0, UploadTotal: 0, RetransmitTotal: 0,
          Members: [],
        };
        map.set(key, agg);
      }
      agg.Pid += 1;
      agg.Members.push(histKey(p));
      // 聚合行的会话时长取最早启动的那个进程
      if (p.StartTimeUnixMs && (!agg.StartTimeUnixMs || p.StartTimeUnixMs < agg.StartTimeUnixMs)) {
        agg.StartTimeUnixMs = p.StartTimeUnixMs;
      }
      agg.DownloadBytes += p.DownloadBytes || 0;
      agg.UploadBytes += p.UploadBytes || 0;
      agg.DownloadTotal += p.DownloadTotal || 0;
      agg.UploadTotal += p.UploadTotal || 0;
      agg.RetransmitTotal += p.RetransmitTotal || 0;
      if (!agg.IconBase64 && p.IconBase64) agg.IconBase64 = p.IconBase64;
    }
    procs = Array.from(map.values());
  }

  const get = sortAccessors[sortKey];
  procs.sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av < bv) return -sortDir;
    if (av > bv) return sortDir;
    return 0;
  });
  return procs;
}

function rowKey(p) {
  return viewMode === 'app'
    ? `app:${(p.Name || '').trim().toLowerCase()}`
    : `pid:${histKey(p)}`;
}

// 行按 key 复用：1 Hz 刷新下重建整棵子树是白扔的开销，也会打断悬浮态。
const rowNodes = new Map();

function buildRow(key) {
  const tr = document.createElement('tr');
  tr.dataset.key = key;
  tr.tabIndex = 0;
  tr.innerHTML = `
    <td><span class="cell-name">
      <img class="proc-icon" alt="" hidden /><span class="proc-icon is-placeholder"></span>
      <span class="row-name"></span><span class="count-suffix"></span>
    </span></td>
    <td class="is-num td-pid"></td>
    <td class="is-num td-rate down"></td>
    <td class="is-num td-rate up"></td>`;
  tr.refs = {
    img: tr.querySelector('img.proc-icon'),
    ph: tr.querySelector('.proc-icon.is-placeholder'),
    name: tr.querySelector('.row-name'),
    suffix: tr.querySelector('.count-suffix'),
    pid: tr.children[1],
    down: tr.children[2],
    up: tr.children[3],
  };
  return tr;
}

function updateRow(tr, p, peakDown) {
  const r = tr.refs;
  const name = p.Name || '(系统/未归因)';
  if (p.IconBase64) {
    if (r.img.getAttribute('src') !== p.IconBase64) r.img.src = p.IconBase64;
    r.img.hidden = false;
    r.ph.hidden = true;
  } else {
    r.img.hidden = true;
    r.ph.hidden = false;
    r.ph.textContent = initialOf(name, 1);
  }
  if (r.name.textContent !== name) r.name.textContent = name;
  r.suffix.textContent = viewMode === 'app' ? `×${p.Pid}` : '';
  r.pid.textContent = viewMode === 'app' ? `${p.Pid} 个进程` : p.Pid;
  r.down.textContent = fmtRate(p.DownloadBytes || 0);
  r.up.textContent = fmtRate(p.UploadBytes || 0);

  // 占比不占列宽：整行背景一条从左起的极淡琥珀渐变（§2.5）
  const share = peakDown > 0 ? Math.min(100, Math.round(((p.DownloadBytes || 0) / peakDown) * 100)) : 0;
  const grad = share > 0
    ? `linear-gradient(90deg, rgba(240,145,63,0.09), rgba(240,145,63,0) ${share}%)`
    : 'none';
  if (tr.style.backgroundImage !== grad) tr.style.backgroundImage = grad;

  tr.classList.toggle('is-selected', !!selected && selected.keyStr === tr.dataset.key);
}

function renderTable(snap) {
  const procs = visibleProcesses(snap);
  const peakDown = procs.reduce((m, p) => Math.max(m, p.DownloadBytes || 0), 0);
  const alive = new Set();

  procs.forEach((p, i) => {
    const key = rowKey(p);
    alive.add(key);
    let tr = rowNodes.get(key);
    if (!tr) { tr = buildRow(key); rowNodes.set(key, tr); }
    tr.procData = p;
    updateRow(tr, p, peakDown);
    // 排序变化时顺序会整体重排；只在位置不对时才动 DOM
    if (els.rows.children[i] !== tr) els.rows.insertBefore(tr, els.rows.children[i] || null);
  });

  for (const [key, tr] of rowNodes) {
    if (!alive.has(key)) { tr.remove(); rowNodes.delete(key); }
  }

  els.pidLabel.textContent = viewMode === 'app' ? '进程数' : 'PID';
  return procs;
}

function renderSortMarks() {
  for (const th of document.querySelectorAll('.proc-table th[data-sort]')) {
    const on = th.dataset.sort === sortKey;
    th.classList.toggle('is-sorted', on);
    th.querySelector('.sort-mark').textContent = on ? (sortDir === -1 ? '▼' : '▲') : '';
  }
}

// 空态 / 异常态（§2.8）。骨架条只在「连接中」出现，转圈一律不用。
const PROC_STATES = {
  connecting: {
    title: '正在连接采集服务', desc: '首帧数据通常在一秒内到达。', retry: false, skeleton: true,
  },
  offline: {
    title: '采集服务未连接',
    desc: 'NetPeek 的 ETW 采集需要 LocalSystem 权限。请确认 NetPeekCollector 服务正在运行。',
    retry: true, skeleton: false,
  },
  error: {
    title: '采集服务异常',
    desc: 'ETW 内核会话启动失败，通常是权限不足或已有会话占用。重启服务可恢复。',
    retry: true, skeleton: false,
  },
  idle: {
    title: '当前没有检测到网络活动', desc: '有进程收发数据时会立刻出现在这里。',
    retry: false, skeleton: false,
  },
  empty: {
    title: '没有匹配的进程', desc: '换个关键词，或清空搜索框看全部。', retry: false, skeleton: false,
  },
};

function setProcState(kind) {
  const s = kind ? PROC_STATES[kind] : null;
  els.procState.hidden = !s;
  $('procSkeleton').hidden = !(s && s.skeleton);
  els.tableWrap.hidden = !!s;
  if (!s) return;
  els.procStateTitle.textContent = s.title;
  els.procStateDesc.textContent = s.desc;
  $('procStateActions').hidden = !s.retry;
  // 骨架态自带解释，标题和说明留着，但不给「重试」——它还在连
  els.procState.hidden = !!s.skeleton;
}

// ===== 检查栏 =====

// 未选中任何行时是总览态：全局字段 + 全局合计；选中后是详情态。
// 两态共用头部与合计两行，只切换中间那一段（§2.4）。
function renderInspector(snap, procs) {
  const sel = selected && rowNodes.get(selected.keyStr)
    ? rowNodes.get(selected.keyStr).procData
    : (selected ? findSelected(procs) : null);

  if (!sel) {
    selected = null;
    renderOverview(snap, procs);
  } else {
    renderDetail(snap, sel);
  }
}

function findSelected(procs) {
  return procs.find((p) => rowKey(p) === selected.keyStr) || null;
}

function renderOverview(snap, procs) {
  els.inspIcon.hidden = true;
  els.inspIconPh.hidden = false;
  els.inspIconPh.textContent = 'NP';
  els.inspName.textContent = '总览';

  const startedMs = snap.SessionStartedUnixMs || 0;
  const upSec = startedMs > 0 ? ((snap.TimestampUnixMs || Date.now()) - startedMs) / 1000 : samples.length;
  els.inspPath.textContent = `已采集 ${fmtDuration(upSec)}`;
  els.inspMeta.textContent = `${procs.length} 个${viewMode === 'app' ? '应用' : '进程'}有流量`;

  const all = snap.Processes || [];
  els.inspDownTotal.textContent = fmtBytes(all.reduce((s, p) => s + (p.DownloadTotal || 0), 0));
  els.inspUpTotal.textContent = fmtBytes(all.reduce((s, p) => s + (p.UploadTotal || 0), 0));
  els.inspUpLabel.textContent = '启动以来上传';

  els.inspLiveSec.hidden = true;
  els.inspFieldsSec.hidden = false;
  renderFields(snap);
  render30Day(null);
}

// 详情态。会话时长按进程创建时间算，不是「选中以来」。
function renderDetail(snap, p) {
  const name = p.Name || '(系统/未归因)';
  if (p.IconBase64) {
    if (els.inspIcon.getAttribute('src') !== p.IconBase64) els.inspIcon.src = p.IconBase64;
    els.inspIcon.hidden = false;
    els.inspIconPh.hidden = true;
  } else {
    els.inspIcon.hidden = true;
    els.inspIconPh.hidden = false;
    els.inspIconPh.textContent = initialOf(name, 2);
  }
  els.inspName.textContent = name;
  // 路径在 \ 后插零宽空格，换行才断在目录分隔符上，不会把 com.netpeek.app 劈成两截
  els.inspPath.textContent = p.Path
    ? p.Path.replace(/\\/g, '\\\u200b')
    : '路径不可用（权限不足或进程已退出）';
  els.inspPath.title = p.Path || '';

  const parts = [];
  parts.push(viewMode === 'app' ? `${p.Pid} 个进程` : `PID ${p.Pid}`);
  if (p.StartTimeUnixMs > 0) {
    parts.push(`会话 ${fmtDuration(((snap.TimestampUnixMs || Date.now()) - p.StartTimeUnixMs) / 1000)}`);
  }
  if (p.RetransmitTotal > 0) parts.push(`重传 ${fmtBytes(p.RetransmitTotal)}`);
  els.inspMeta.textContent = parts.join(' · ');

  els.inspDownTotal.textContent = fmtBytes(p.DownloadTotal || 0);
  els.inspUpTotal.textContent = fmtBytes(p.UploadTotal || 0);
  els.inspUpLabel.textContent = '启动以来上传';

  els.inspFieldsSec.hidden = true;
  els.inspLiveSec.hidden = false;
  els.inspLiveDown.textContent = `▼ ${fmtRate(p.DownloadBytes || 0)}`;
  els.inspLiveUp.textContent = `▲ ${fmtRate(p.UploadBytes || 0)}`;
  drawProcChart(p);
  render30Day(name);
}

// 归因覆盖率是算出来的，不是采集端给的：名字为空的那部分就是没归因上的。
// 「归因说明」不另设入口，点这一行就展开（§2.4）。
let histStats = null;

function renderFields(snap) {
  const all = snap.Processes || [];
  let named = 0;
  let total = 0;
  for (const p of all) {
    const bytes = (p.DownloadTotal || 0) + (p.UploadTotal || 0);
    total += bytes;
    if ((p.Name || '').trim()) named += bytes;
  }
  els.fldCoverage.textContent = total > 0
    ? `${((named / total) * 100).toFixed(1)}% 已归因`
    : '暂无流量';

  els.fldService.textContent = STATUS[snap.Status === 'ok' ? 'ok'
    : snap.Status === 'paused' ? 'paused' : 'error'].text;

  const lost = snap.EventsLost || 0;
  els.fldLost.textContent = lost === 0 ? '无丢失' : `${lost} 条`;
  els.fldLost.classList.toggle('is-warn', lost > 0);

  els.fldDbSize.textContent = histStats && histStats.rows
    ? `${window.NetPeekSettingsUI.fmtSize(histStats.bytes)} · ${histStats.rows} 条`
    : '暂无数据';
}

function setFieldsOffline() {
  els.fldCoverage.textContent = '—';
  els.fldService.textContent = STATUS.offline.text;
  els.fldLost.textContent = '—';
  els.fldLost.classList.remove('is-warn');
}

// ===== 三张图 =====
// 底部带宽图答「总带宽这一分钟怎么走的」；检查栏实时图答「这个应用这一分钟怎么走的」；
// 30 天图答「这个应用一个月用了多少」。三个问题不重叠（§3.7 第 9 条）。

// 暂停时曲线尾巴转虚线，从暂停那一刻的下标开始（§2.8）
let pausedIndex = -1;

// ===== 实时折线（ECharts）=====
// 1Hz × 60 点的小数据量，交互与美观优先；真正的海量高频流才需要
// uPlot 级别的方案（§4.2）。与统计页共用同一份 vendored ECharts。
// 平滑用 smoothMonotone:'x' 抑制曲线过冲 —— 速率读数不许画出比峰值还高的鼓包。

function ensureLineChart(el) {
  let inst = echarts.getInstanceByDom(el);
  if (!inst) inst = echarts.init(el);
  // init 落在布局完成前会拿到 0×0（ECharts 回退 100×100），尺寸不符就重量测
  if (inst.getWidth() !== el.clientWidth || inst.getHeight() !== el.clientHeight) inst.resize();
  return inst;
}

// defs: [{ name, color, points: [[tMs, v]...], dashFrom }]；dashFrom ≥ 0 时该下标起转虚线，
// 虚线段补上边界前一点保持视觉接续。opt: { area, yMax, tooltip, grid, windowMs }
function liveLineOption(defs, opt = {}) {
  const mut = C.cssVar('--text-muted') || '#b4a99e';
  const txt = C.cssVar('--text') || '#f6efe8';
  const line = 'rgba(255,255,255,0.08)';
  const now = Date.now();
  const windowMs = (opt.windowSecs || WINDOW_SECS) * 1000;
  const series = [];
  for (const d of defs) {
    const solid = [];
    const dash = [];
    const cut = Number.isInteger(d.dashFrom) ? d.dashFrom : -1;
    d.points.forEach(([t, v], i) => {
      if (cut >= 0 && i >= cut) {
        dash.push([t, v]);
      } else {
        solid.push([t, v]);
        if (cut >= 0 && i === cut - 1) dash.push([t, v]);
      }
    });
    const lineBase = {
      type: 'line', showSymbol: false, smooth: true, smoothMonotone: 'x',
      lineStyle: { width: 2, color: d.color },
    };
    series.push({
      ...lineBase, name: d.name,
      areaStyle: opt.area ? {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: d.color + '38' },
          { offset: 1, color: d.color + '00' },
        ]),
      } : undefined,
      data: solid,
    });
    if (cut >= 0) {
      series.push({
        ...lineBase, name: `${d.name}（暂停）`,
        lineStyle: { width: 2, color: d.color, type: 'dashed', opacity: 0.7 },
        data: dash,
      });
    }
  }
  return {
    animation: false,
    grid: opt.grid || { left: 52, right: 12, top: 12, bottom: 8 },
    xAxis: { type: 'time', min: now - windowMs, max: now,
      axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { show: false } },
    yAxis: { type: 'value', min: 0, max: opt.yMax, splitNumber: 2,
      axisLabel: { color: mut, fontSize: 10, formatter: C.axisRate },
      splitLine: { lineStyle: { color: line, type: 'dashed' } } },
    tooltip: opt.tooltip ? {
      trigger: 'axis',
      backgroundColor: C.cssVar('--surface') || '#1e1a16',
      borderColor: 'rgba(255,255,255,0.12)',
      textStyle: { color: txt, fontSize: 12 },
      valueFormatter: (v) => C.axisRate(v),
    } : undefined,
    series,
  };
}

function drawBandwidth() {
  if (!els.bandwidthChart) return;
  const inst = ensureLineChart(els.bandwidthChart);
  if (!lastSnapshot) {
    // 断线：只留空坐标轴（§2.8），连接恢复后下一帧自然填上
    inst.setOption(liveLineOption([], { yMax: 1 }), true);
    return;
  }
  const pts = (pick) => samples.map((s) => [s.t * 1000, pick(s)]);
  const peak = samples.reduce((m, s) => Math.max(m, s.down, s.up), 1);
  inst.setOption(liveLineOption([
    { name: '下载', color: C.cssVar('--down') || '#f0913f', points: pts((s) => s.down), dashFrom: pausedIndex },
    { name: '上传', color: C.cssVar('--up') || '#7fa8c9', points: pts((s) => s.up), dashFrom: pausedIndex },
  ], { yMax: C.niceMax(peak), area: true }), true);
  // 不给实时图配 tooltip：1Hz setOption 会每秒把浮层重置掉（一闪一灭），
  // 且当前精确值就在顶栏大数字里 —— 这张图只负责「趋势形状」。
}

// 选中行的 60 秒曲线。按应用聚合时把成员进程逐槽相加，
// 不能只画首个进程 —— 那和表格里显示的合计对不上。
function seriesFor(p) {
  const keys = p.Members && p.Members.length ? p.Members : [histKey(p)];
  const down = new Array(WINDOW_SECS).fill(0);
  const up = new Array(WINDOW_SECS).fill(0);
  let len = 0;
  for (const k of keys) {
    const h = procHist.get(k);
    if (!h) continue;
    len = Math.max(len, h.t.length);
    // 各进程缓冲长度不同，一律右对齐后相加
    const off = WINDOW_SECS - h.t.length;
    for (let i = 0; i < h.t.length; i++) {
      down[off + i] += h.down[i];
      up[off + i] += h.up[i];
    }
  }
  const start = WINDOW_SECS - len;
  return { down: down.slice(start), up: up.slice(start) };
}

function drawProcChart(p) {
  if (!els.inspLiveChart || els.inspLiveSec.hidden) return;
  const s = seriesFor(p);
  const inst = ensureLineChart(els.inspLiveChart);
  if (!s.down.length) {
    inst.setOption(liveLineOption([], { yMax: 1, grid: { left: 44, right: 8, top: 8, bottom: 6 } }), true);
    return;
  }
  // 槽位右对齐：最右一个槽就是当前秒
  const len = s.down.length;
  const now = Date.now() / 1000;
  const toPoints = (arr) => arr.map((v, i) => [(now - (len - 1 - i)) * 1000, v]);
  const peak = s.down.reduce((m, v) => Math.max(m, v), s.up.reduce((m2, v) => Math.max(m2, v), 1));
  inst.setOption(liveLineOption([
    { name: '下载', color: C.cssVar('--down') || '#f0913f', points: toPoints(s.down), dashFrom: pausedIndex },
    { name: '上传', color: C.cssVar('--up') || '#7fa8c9', points: toPoints(s.up), dashFrom: pausedIndex },
  ], { yMax: C.niceMax(peak), area: true, grid: { left: 44, right: 8, top: 8, bottom: 6 } }), true);
}

// 30 天下载柱图。检查栏只有 296px 宽，挤不开双色分组柱，上传去历史屏看（§2.4）。
// 数据复用历史屏那一次日聚合查询，不再单独查库。
// 库每整分钟落一次盘，仅靠「换选中行才重查」的话，UI 启动那一刻库还是空的
// 就会永远停在「合计 0 B」—— 所以超过 60s 的渲染强制重查一次。
const REFRESH_30_MS = 60000;
let last30Name = undefined;
let last30At = 0;

async function render30Day(name, force) {
  const stale = Date.now() - last30At >= REFRESH_30_MS;
  if (!force && name === last30Name && !stale) return;
  last30Name = name;
  last30At = Date.now();
  els.insp30Title.textContent = name ? '30 天下载' : '30 天下载（全部应用）';
  if (!window.NetPeekHistoryUI) return;
  try {
    const points = await window.NetPeekHistoryUI.dailyFor(name, 30);
    if (last30Name !== name) return;      // 期间又换了选中行，这份结果作废
    const total = points.reduce((s, p) => s + p.value, 0);
    els.insp30Total.textContent = total > 0 ? `合计 ${fmtBytes(total)}` : '暂无数据';
    C.bars(els.insp30Chart, {
      groups: points.map((p) => ({ label: p.label, values: [p.value] })),
      colors: [C.cssVar('--down') || '#f0913f'],
      formatY: C.axisBytes,
      tipFormat: fmtBytes,
      seriesNames: ['下载'],
      xLabels: points.length ? [points[0].label, points[points.length - 1].label] : [],
      emptyText: '暂无历史数据',
    });
  } catch {
    els.insp30Total.textContent = '合计 —';
    C.bars(els.insp30Chart, { groups: [], formatY: C.axisBytes, xLabels: [] });
  }
}

// ===== 一帧的完整渲染 =====

function renderAll(snap) {
  renderTopbar(snap);
  const procs = renderTable(snap);

  if (snap.Status !== 'ok' && snap.Status !== 'paused') setProcState('error');
  else if (procs.length === 0) setProcState(query ? 'empty' : 'idle');
  else setProcState(null);

  renderInspector(snap, procs);
  drawBandwidth();
  pulseIfWaking(snap);
}

// 隐藏到托盘时跳过 DOM/canvas 重绘（§4.1/§11 硬性要求）。
// 可见性有两个来源：document.hidden（页面级）与 win-visibility 事件 —— WebView2
// 对宿主窗口隐藏不保证触发 visibilitychange，所以 Rust 侧在 show/hide 时显式广播兜底。
let winHidden = false;
function uiVisible() { return !document.hidden && !winHidden; }
function repaintIfVisible() {
  if (uiVisible() && screen === 'live' && lastSnapshot) renderAll(lastSnapshot);
}

function onSnapshot(snap) {
  lastSnapshot = snap;
  pushSamples(snap);
  accumulateToday(snap);
  // 暂停是从当前这一帧起虚线；恢复后回到全实线
  pausedIndex = snap.Status === 'paused'
    ? (pausedIndex >= 0 ? pausedIndex : samples.length - 1)
    : -1;
  if (window.NetPeekSettingsUI) window.NetPeekSettingsUI.updateService(snap);
  if (!uiVisible()) return;              // 隐藏到托盘：数据照常进采样缓冲，只停重绘
  if (screen !== 'live') return;         // 别的屏不用重画实时件
  renderAll(snap);
}

document.addEventListener('visibilitychange', repaintIfVisible);

// 断线：数字停在最后一帧，图只留坐标轴，表格换成可重试的异常态（§2.8）
function onDisconnected() {
  setStatus('offline');
  setProcState('offline');
  setFieldsOffline();
  drawBandwidth(); // lastSnapshot 为空 → 空坐标轴分支
  if (window.NetPeekSettingsUI) window.NetPeekSettingsUI.updateServiceOffline();
}

// ===== 屏切换 =====
// 岛的位置不动，只换岛内内容（§2.6）。视图切换和搜索只对实时屏有意义，
// 换屏时隐藏它们，而不是留在那里点了没反应。

function setScreen(next) {
  if (next === screen) return;
  screen = next;
  // 当前屏挂到 body 上：CSS 按屏调骨架（如历史屏把数据岛加高），JS 不感知具体值
  document.body.dataset.screen = next;
  for (const pane of document.querySelectorAll('.pane[data-screen]')) {
    pane.hidden = pane.dataset.screen !== next;
  }
  for (const btn of els.nav.querySelectorAll('.nav-item')) {
    const on = btn.dataset.screen === next;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-current', on ? 'page' : 'false');
  }
  els.viewToggle.hidden = next !== 'live';
  $('searchBox').hidden = next !== 'live';

  if (next === 'live' && lastSnapshot) renderAll(lastSnapshot);
  if (next === 'history' && window.NetPeekHistoryUI) window.NetPeekHistoryUI.onEnter();
  if (next === 'settings' && window.NetPeekSettingsUI) window.NetPeekSettingsUI.onEnter();
}

// ===== 密集模式 =====
// 收起留白区和检查栏，把数据岛撑到整个下半部分。导航岛留在原位：
// 唯一的导航入口不该被一个临时视图吞掉（这一条是对规格的有意偏离）。

function setDense(on) {
  els.shell.classList.toggle('is-dense', on);
  els.denseGrip.setAttribute('aria-expanded', String(on));
  els.denseGrip.title = on ? '双击恢复三段布局' : '双击展开进程表';
  localStorage.setItem(DENSE_KEY, on ? '1' : '0');
  // 布局变了，画布尺寸也变了，图得重画
  requestAnimationFrame(() => {
    if (screen === 'live') drawBandwidth();
    if (screen === 'history' && window.NetPeekHistoryUI) window.NetPeekHistoryUI.redraw();
  });
}

function bindDenseGrip() {
  let startY = 0;
  let dragging = false;
  els.denseGrip.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    els.denseGrip.setPointerCapture(e.pointerId);
  });
  els.denseGrip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (dy < -24) { setDense(true); dragging = false; }
    else if (dy > 24) { setDense(false); dragging = false; }
  });
  els.denseGrip.addEventListener('pointerup', () => { dragging = false; });
  els.denseGrip.addEventListener('dblclick', () => {
    setDense(!els.shell.classList.contains('is-dense'));
  });
}

// ===== 无边框窗口 =====
// decorations:false 之后标题栏、缩放边框、系统按钮全没了，都得自己给。
// 拖动靠顶栏上的 data-tauri-drag-region（它也带双击最大化），这里只补按钮和缩放热区。

function currentWindow() {
  const w = window.__TAURI__;
  return w && w.window ? w.window.getCurrentWindow() : null;
}

async function bindWindowFrame() {
  const win = currentWindow();
  if (!win) return;                       // 浏览器里预览时整段跳过

  $('winMin').addEventListener('click', () => win.minimize());
  $('winMax').addEventListener('click', () => win.toggleMaximize());
  // 关闭是隐藏到托盘，不退进程：采集要继续，托盘菜单才是退出口
  $('winClose').addEventListener('click', () => win.hide());

  for (const edge of document.querySelectorAll('.resize-edge')) {
    edge.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      win.startResizeDragging(edge.dataset.dir);
    });
  }

  // 最大化时抹掉 20px 外框圆角：贴着屏幕边缘的圆角会漏出桌面
  const syncMax = async () => {
    const on = await win.isMaximized();
    els.frame.classList.toggle('is-maximized', on);
    requestAnimationFrame(() => {
      if (screen === 'live') { drawBandwidth(); if (lastSnapshot) renderAll(lastSnapshot); }
      if (screen === 'history' && window.NetPeekHistoryUI) window.NetPeekHistoryUI.redraw();
    });
  };
  await syncMax();
  win.onResized(syncMax);
}

// ===== 事件绑定 =====

function bindTable() {
  for (const th of document.querySelectorAll('.proc-table th[data-sort]')) {
    th.tabIndex = 0;
    const toggle = () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir = -sortDir;
      else { sortKey = key; sortDir = key === 'name' ? 1 : -1; }
      renderSortMarks();
      if (lastSnapshot) renderAll(lastSnapshot);
    };
    th.addEventListener('click', toggle);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }

  // 选中同一行再点一次就取消，回到总览态
  els.rows.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    selected = selected && selected.keyStr === tr.dataset.key ? null : { keyStr: tr.dataset.key };
    if (lastSnapshot) renderAll(lastSnapshot);
  });
  els.rows.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); }
    else if (e.key === 'ArrowDown' && tr.nextElementSibling) { e.preventDefault(); tr.nextElementSibling.focus(); }
    else if (e.key === 'ArrowUp' && tr.previousElementSibling) { e.preventDefault(); tr.previousElementSibling.focus(); }
  });
}

function bindControls() {
  els.viewToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-view]');
    if (!btn) return;
    viewMode = btn.dataset.view;
    for (const b of els.viewToggle.querySelectorAll('button')) {
      const on = b === btn;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
    }
    // 聚合键和进程键不通用，切视图时选中作废
    selected = null;
    if (lastSnapshot) renderAll(lastSnapshot);
  });

  els.search.addEventListener('input', () => {
    query = els.search.value;
    if (lastSnapshot) renderAll(lastSnapshot);
  });

  els.nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (btn) setScreen(btn.dataset.screen);
  });

  // 归因说明挂在归因覆盖率上：点开点收，不另设入口（§2.4）
  const toggleNote = () => {
    els.attribNote.hidden = !els.attribNote.hidden;
    els.fldCoverage.setAttribute('aria-expanded', String(!els.attribNote.hidden));
  };
  els.fldCoverage.addEventListener('click', toggleNote);
  els.fldCoverage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleNote(); }
  });

  $('retryConnect').addEventListener('click', () => {
    setProcState('connecting');
    // 管道客户端自己每秒重连，这里只把界面切回等待态
  });

  // 留白区的按钮是无背景图态的唯一例外（§2.8）
  els.stagePickBg.addEventListener('click', () => {
    setScreen('theme');
    if (window.NetPeekThemeUI) window.NetPeekThemeUI.pickBackground();
  });

  window.addEventListener('netpeek-settingschange', (e) => {
    rateUnit = e.detail.rateUnit || 'auto';
    if (lastSnapshot && screen === 'live') renderAll(lastSnapshot);
  });

  window.addEventListener('netpeek-historystats', (e) => {
    histStats = e.detail.stats;
    if (lastSnapshot && screen === 'live') renderFields(lastSnapshot);
  });

  // 换主题会改 --down / --up / --line，canvas 里的颜色是画上去的，得重画
  window.addEventListener('netpeek-themechange', () => {
    if (screen === 'live') { drawBandwidth(); if (lastSnapshot) renderAll(lastSnapshot); }
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (screen === 'live') { drawBandwidth(); if (lastSnapshot) renderAll(lastSnapshot); }
      if (screen === 'history' && window.NetPeekHistoryUI) window.NetPeekHistoryUI.redraw();
    }, 120);
  });
}

// ===== 启动 =====

// history-ui.js 要用最近一帧快照借应用图标，settings-ui.js 要用同一套字节格式化。
window.NetPeekLive = {
  lastSnapshot: () => lastSnapshot,
  fmtBytes,
  fmtRate,
  initialOf,
  UNATTR,
};

async function boot() {
  renderSortMarks();
  setDense(localStorage.getItem(DENSE_KEY) === '1');
  setProcState('connecting');
  els.viewToggle.hidden = false;
  bindTable();
  bindControls();
  bindDenseGrip();

  // 管道监听先挂上：后面的主题、设置、首绘任何一步抛错都不该让界面收不到快照
  if (window.__TAURI__) {
    await listen('snapshot', (e) => onSnapshot(e.payload));
    await listen('pipe-status', (e) => {
      if (e.payload === 'connected') setProcState('connecting');
      else onDisconnected();
    });
    // Rust 侧 show/hide 时广播的窗口可见性（uiVisible 的权威来源，见其注释）
    await listen('win-visibility', (e) => {
      if (e.payload.label !== 'main') return;
      winHidden = !e.payload.visible;
      repaintIfVisible();
    });
  } else {
    // 浏览器里直接开 index.html 时没有管道，停在异常态而不是空白
    onDisconnected();
  }

  // 和下面两行一样包起来：窗口装饰绑定失败（旧版 Tauri 缺 onResized 之类）只该让
  // 拖动/缩放失灵，不该把后面的主题、设置、首绘一起带走 —— 那会让整个界面停在
  // 未初始化状态：语义色块全黑、图表用不到主题色。
  try { await bindWindowFrame(); } catch { /* 无边框控件降级，界面继续起 */ }
  // 主题要在首绘之前起来：图里的颜色是从 --down / --up 读出来画上去的
  if (window.NetPeekThemeUI) { try { await window.NetPeekThemeUI.init(); } catch { /* 用默认令牌 */ } }
  if (window.NetPeekSettingsUI) { try { await window.NetPeekSettingsUI.init(); } catch { /* 用默认设置 */ } }

  drawBandwidth();
  // 首绘就绪，显示窗口（此前窗口隐藏，WebView2 冷启动期的空白帧不会露出来）
  showWindow();
  console.log('[netpeek] 界面就绪', Math.round(performance.now() - (window.__BOOT_T0 || 0)), 'ms');

  // 非关键路径后置：今日合计底数从历史库补，晚到几百毫秒只影响顶栏一个读数
  loadTodayBase();
  render30Day(null, true);
}

function showWindow() {
  try {
    window.__TAURI__?.window?.getCurrentWindow?.().show();
  } catch { /* 浏览器预览没有窗口对象 */ }
}

boot();
