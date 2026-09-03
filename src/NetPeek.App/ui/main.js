// NetPeek 前端：监听采集服务经 Tauri 转发的快照事件，虚拟化渲染进程列表 + 实时速率折线图。
// 快照字段为 PascalCase（与 C# System.Text.Json 默认序列化一致）。

const rowsEl = document.getElementById('rows');
const totalDownEl = document.getElementById('totalDown');
const totalUpEl = document.getElementById('totalUp');
const statusEl = document.getElementById('status');
const searchEl = document.getElementById('search');
const viewportEl = document.getElementById('viewport');
const chartEl = document.getElementById('rateChart');
const cardsEl = document.getElementById('cards');
const sbServiceEl = document.getElementById('sb-service');
const sbSessionEl = document.getElementById('sb-session');
const sbCoverageEl = document.getElementById('sb-coverage');
const detailEl = document.getElementById('detail');
const detailIconEl = document.getElementById('detailIcon');
const detailIconPhEl = document.getElementById('detailIconPlaceholder');
const detailNameEl = document.getElementById('detailName');
const detailSubEl = document.getElementById('detailSub');
const detailPathEl = document.getElementById('detailPath');
const detailPidEl = document.getElementById('detailPid');
const detailDurationEl = document.getElementById('detailDuration');
const detailDownTotalEl = document.getElementById('detailDownTotal');
const detailUpTotalEl = document.getElementById('detailUpTotal');
const detailRetransEl = document.getElementById('detailRetrans');
const detailChartEl = document.getElementById('detailChart');
const detailCloseEl = document.getElementById('detailClose');

const { listen } = window.__TAURI__.event;

const ROW_HEIGHT = 43; // 与 styles.css 中 .proc-table td 的 height 一致
const OVERSCAN = 8; // 视口上下各多渲染的行数，减少滚动时的空白闪烁

let lastSnapshot = null;
let query = '';
let sortKey = 'downloadTotal';
let sortDir = -1; // 1 升序 / -1 降序
let viewMode = 'process'; // 'process' 按进程明细 / 'app' 按应用聚合

function fmtRate(bytesPerSec) {
  if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(1) + ' MB/s';
  if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(1) + ' KB/s';
  return bytesPerSec + ' B/s';
}

function fmtBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
  return bytes + ' B';
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

// ===== 实时速率折线图（uPlot）=====

const CHART_HEIGHT = 120;

// 从 CSS 变量读取主题色，使图表跟随系统深浅色主题。
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

let chartWindow = 10; // 秒，默认 10s
const samples = []; // { t: 秒, down, up }，1 秒一个点
let uplot = null;

function chartOpts() {
  const colorDown = cssVar('--down');
  const colorUp = cssVar('--up');
  const colorAxis = cssVar('--muted');
  const colorGrid = cssVar('--border');
  return {
    width: chartEl.clientWidth,
    height: CHART_HEIGHT,
    legend: { show: true },
    cursor: { y: true },
    scales: {
      x: { time: true },
      y: { range: [0, null] },
    },
    series: [
      {},
      {
        label: '下载',
        stroke: colorDown,
        width: 2,
        fill: hexA(colorDown, 0.10),
        value: (u, v) => (v == null ? '--' : fmtRate(v)),
      },
      {
        label: '上传',
        stroke: colorUp,
        width: 2,
        fill: hexA(colorUp, 0.10),
        value: (u, v) => (v == null ? '--' : fmtRate(v)),
      },
    ],
    axes: [
      { stroke: colorAxis, grid: { stroke: colorGrid, width: 1 } },
      {
        stroke: colorAxis,
        grid: { stroke: colorGrid, width: 1 },
        size: 64,
        values: (u, splits) => splits.map((v) => fmtRate(v)),
      },
    ],
  };
}

// 把 #rrggbb 转成带透明度的 rgba()，用于曲线下的渐变填充。
function hexA(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function initChart() {
  uplot = new uPlot(chartOpts(), [[], [], []], chartEl);
}

// 系统主题切换时重建图表以应用新配色。
function rebuildChart() {
  if (!uplot) return;
  const data = [
    samples.map((s) => s.t),
    samples.map((s) => s.down),
    samples.map((s) => s.up),
  ];
  uplot.destroy();
  uplot = new uPlot(chartOpts(), data, chartEl);
  renderChart();
}

if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  (mq.addEventListener || mq.addListener).call(mq, 'change', () => {
    rebuildChart();
    rebuildDetailChart();
  });
}

function pushSample(snap) {
  const t = (snap.TimestampUnixMs || Date.now()) / 1000;
  samples.push({
    t,
    down: snap.TotalDownloadBytes || 0,
    up: snap.TotalUploadBytes || 0,
  });
  // 只保留最近 5 分钟，避免长时间运行内存无限增长。
  const cutoff = t - 300;
  while (samples.length && samples[0].t < cutoff) samples.shift();
  renderChart();
}

function renderChart() {
  if (!uplot) return;
  const now = samples.length ? samples[samples.length - 1].t : Date.now() / 1000;
  const cutoff = now - chartWindow;
  const win = samples.filter((s) => s.t >= cutoff);

  uplot.setData([
    win.map((s) => s.t),
    win.map((s) => s.down),
    win.map((s) => s.up),
  ]);
  uplot.setScale('x', { min: cutoff, max: now });
}

function resizeChart() {
  if (uplot) uplot.setSize({ width: chartEl.clientWidth, height: CHART_HEIGHT });
}

// ===== Top 4 应用卡片 =====

// 按应用聚合（同名进程合并），取累计流量最高的 4 个。
function topApps(snap, n) {
  const map = new Map();
  for (const p of snap.Processes || []) {
    const name = (p.Name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    let agg = map.get(key);
    if (!agg) {
      agg = {
        Name: name,
        IconBase64: p.IconBase64 || '',
        DownloadBytes: 0,
        UploadBytes: 0,
        DownloadTotal: 0,
        UploadTotal: 0,
      };
      map.set(key, agg);
    }
    agg.DownloadBytes += p.DownloadBytes || 0;
    agg.UploadBytes += p.UploadBytes || 0;
    agg.DownloadTotal += p.DownloadTotal || 0;
    agg.UploadTotal += p.UploadTotal || 0;
    if (!agg.IconBase64 && p.IconBase64) agg.IconBase64 = p.IconBase64;
  }
  const apps = Array.from(map.values());
  apps.sort((a, b) => (b.DownloadTotal + b.UploadTotal) - (a.DownloadTotal + a.UploadTotal));
  return apps.slice(0, n);
}

function renderCards(snap) {
  const apps = topApps(snap, 4);
  const grandTotal = apps.reduce((s, a) => s + a.DownloadTotal + a.UploadTotal, 0);
  const frag = document.createDocumentFragment();

  for (const a of apps) {
    const pct = grandTotal > 0 ? Math.round(((a.DownloadTotal + a.UploadTotal) / grandTotal) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'card';
    card.title = a.Name;
    card.innerHTML = `
      ${a.IconBase64
        ? `<img class="card-icon" src="${a.IconBase64}" alt="" />`
        : '<span class="card-icon placeholder"></span>'}
      <div class="card-body">
        <div class="card-name">${esc(a.Name)}</div>
        <div class="card-rates">
          <span class="down">↓ ${fmtRate(a.DownloadBytes || 0)}</span>
          <span class="up">↑ ${fmtRate(a.UploadBytes || 0)}</span>
        </div>
        <div class="card-bar"><div class="card-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    frag.appendChild(card);
  }

  cardsEl.replaceChildren(frag);
}

// ===== 底部状态栏 =====

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderStatusBar(snap) {
  const lost = snap.EventsLost || 0;
  if (snap.Status === 'paused') {
    sbServiceEl.textContent = '已暂停';
    sbServiceEl.className = 'warn';
  } else if (snap.Status !== 'ok') {
    sbServiceEl.textContent = '采集服务异常';
    sbServiceEl.className = 'error';
  } else if (lost > 0) {
    sbServiceEl.textContent = `监控中 · 丢事件 ${lost}`;
    sbServiceEl.className = 'warn';
  } else {
    sbServiceEl.textContent = '监控中';
    sbServiceEl.className = 'ok';
  }

  const started = snap.SessionStartedUnixMs || 0;
  const now = Date.now();
  sbSessionEl.textContent = started > 0
    ? `会话 ${fmtDuration((now - started) / 1000)}`
    : '会话 --';

  // 归因覆盖率：能解析出进程名的字节占比。ETW 全量按 PID 归因，
  // 未解析到名称的主要是系统/受保护进程。
  let totalBytes = 0;
  let namedBytes = 0;
  for (const p of snap.Processes || []) {
    const b = (p.DownloadTotal || 0) + (p.UploadTotal || 0);
    totalBytes += b;
    if ((p.Name || '').trim()) namedBytes += b;
  }
  sbCoverageEl.textContent = totalBytes > 0
    ? `归因 ${Math.round((namedBytes / totalBytes) * 100)}%`
    : '归因 --';
}

// ===== 右侧详情面板 =====

// 选中行状态。mode = 'process'（key 为 PID）或 'app'（key 为小写应用名）。
let selected = null; // { keyStr, mode, key, data }

const HIST_CAP = 3600; // 1 小时（每秒一帧），每个 PID 一个环形缓冲
const hist = new Map(); // pid -> { t:[], down:[], up:[] }
let detailUplot = null;

// 每个快照帧记录一次每个进程的速率历史；顺带清理已退出的条目。
function recordHist(snap) {
  const t = (snap.TimestampUnixMs || Date.now()) / 1000;
  const seen = new Set();
  for (const p of snap.Processes || []) {
    seen.add(p.Pid);
    let h = hist.get(p.Pid);
    if (!h) { h = { t: [], down: [], up: [] }; hist.set(p.Pid, h); }
    h.t.push(t);
    h.down.push(p.DownloadBytes || 0);
    h.up.push(p.UploadBytes || 0);
    if (h.t.length > HIST_CAP) { h.t.shift(); h.down.shift(); h.up.shift(); }
  }
  // 已不在快照且 60 秒未再出现 → 进程已退出（采集端约 30 帧后移除），丢弃历史。
  for (const [pid, h] of hist) {
    if (!seen.has(pid) && h.t.length && t - h.t[h.t.length - 1] > 60) hist.delete(pid);
  }
}

function detailChartOpts() {
  const colorDown = cssVar('--down');
  const colorUp = cssVar('--up');
  const colorAxis = cssVar('--muted');
  const colorGrid = cssVar('--border');
  return {
    width: detailChartEl.clientWidth,
    height: 110,
    legend: { show: true },
    scales: {
      x: { time: true },
      y: { range: [0, null] },
    },
    series: [
      {},
      {
        label: '下载',
        stroke: colorDown,
        width: 1.5,
        fill: hexA(colorDown, 0.10),
        value: (u, v) => (v == null ? '--' : fmtRate(v)),
      },
      {
        label: '上传',
        stroke: colorUp,
        width: 1.5,
        fill: hexA(colorUp, 0.10),
        value: (u, v) => (v == null ? '--' : fmtRate(v)),
      },
    ],
    axes: [
      { stroke: colorAxis, grid: { stroke: colorGrid, width: 1 } },
      {
        stroke: colorAxis,
        grid: { stroke: colorGrid, width: 1 },
        size: 60,
        values: (u, splits) => splits.map((v) => fmtRate(v)),
      },
    ],
  };
}

function ensureDetailChart() {
  if (!detailUplot) detailUplot = new uPlot(detailChartOpts(), [[], [], []], detailChartEl);
}

// 按应用聚合历史：把同名各 PID 的速率按时间戳合并求和。
function appCurve(name, snap) {
  const map = new Map(); // t -> [down, up]
  for (const p of snap.Processes || []) {
    if ((p.Name || '').trim().toLowerCase() !== name) continue;
    const h = hist.get(p.Pid);
    if (!h) continue;
    for (let i = 0; i < h.t.length; i++) {
      const t = h.t[i];
      const cur = map.get(t);
      if (cur) { cur[0] += h.down[i]; cur[1] += h.up[i]; }
      else map.set(t, [h.down[i], h.up[i]]);
    }
  }
  const ts = Array.from(map.keys()).sort((a, b) => a - b);
  return { t: ts, down: ts.map((t) => map.get(t)[0]), up: ts.map((t) => map.get(t)[1]) };
}

function renderDetailChart() {
  if (!detailUplot || !selected || !lastSnapshot) return;
  let curve;
  if (selected.mode === 'process') {
    const h = hist.get(selected.key);
    curve = h ? { t: h.t, down: h.down, up: h.up } : { t: [], down: [], up: [] };
  } else {
    curve = appCurve(selected.key, lastSnapshot);
  }
  const now = curve.t.length ? curve.t[curve.t.length - 1] : Date.now() / 1000;
  const cutoff = now - 3600;
  let i0 = curve.t.length;
  for (let i = 0; i < curve.t.length; i++) {
    if (curve.t[i] >= cutoff) { i0 = i; break; }
  }
  detailUplot.setData([curve.t.slice(i0), curve.down.slice(i0), curve.up.slice(i0)]);
  detailUplot.setScale('x', { min: cutoff, max: now });
}

function renderDetail() {
  const snap = lastSnapshot;
  if (!selected || !snap) {
    detailEl.hidden = true;
    return;
  }

  let d = null;
  if (selected.mode === 'process') {
    d = (snap.Processes || []).find((p) => p.Pid === selected.key) || null;
  } else {
    const members = (snap.Processes || []).filter(
      (p) => (p.Name || '').trim().toLowerCase() === selected.key);
    if (members.length) {
      let icon = '';
      let downB = 0, upB = 0, downT = 0, upT = 0, retrans = 0;
      for (const m of members) {
        if (!icon && m.IconBase64) icon = m.IconBase64;
        downB += m.DownloadBytes || 0;
        upB += m.UploadBytes || 0;
        downT += m.DownloadTotal || 0;
        upT += m.UploadTotal || 0;
        retrans += m.RetransmitTotal || 0;
      }
      d = {
        Name: members[0].Name,
        IconBase64: icon,
        Pid: members.length,
        DownloadBytes: downB,
        UploadBytes: upB,
        DownloadTotal: downT,
        UploadTotal: upT,
        RetransmitTotal: retrans,
      };
    }
  }

  if (!d) {
    // 进程已退出：保留上次数据继续展示（速率等字段停留在最后值）。
    d = selected.data;
    if (!d) { detailEl.hidden = true; return; }
  } else {
    selected.data = d;
  }

  detailEl.hidden = false;
  ensureDetailChart();

  if (d.IconBase64) {
    detailIconEl.src = d.IconBase64;
    detailIconEl.hidden = false;
    detailIconPhEl.hidden = true;
  } else {
    detailIconEl.hidden = true;
    detailIconPhEl.hidden = false;
  }

  detailNameEl.textContent = d.Name || '(系统/未归因)';
  detailSubEl.textContent = selected.mode === 'app'
    ? `按应用聚合 · ${d.Pid} 个进程`
    : (d.Path ? '进程' : '进程 · 路径未知');
  detailPathEl.textContent = selected.mode === 'app' ? '多进程聚合' : (d.Path || '—');
  detailPidEl.textContent = selected.mode === 'app' ? `×${d.Pid}` : d.Pid;
  detailDurationEl.textContent = (selected.mode === 'process' && d.StartTimeUnixMs > 0)
    ? fmtDuration((Date.now() - d.StartTimeUnixMs) / 1000)
    : '—';
  detailDownTotalEl.textContent = fmtBytes(d.DownloadTotal || 0);
  detailUpTotalEl.textContent = fmtBytes(d.UploadTotal || 0);
  detailRetransEl.textContent = fmtBytes(d.RetransmitTotal || 0);

  renderDetailChart();
}

function rebuildDetailChart() {
  if (!detailUplot) return;
  const data = detailUplot.data;
  detailUplot.destroy();
  detailUplot = null;
  if (!detailEl.hidden) {
    ensureDetailChart();
    renderDetailChart();
  }
}

// ===== 进程列表 =====

const sortAccessors = {
  name: (p) => (p.Name || '').toLowerCase(),
  pid: (p) => p.Pid,
  download: (p) => p.DownloadBytes || 0,
  upload: (p) => p.UploadBytes || 0,
  downloadTotal: (p) => p.DownloadTotal || 0,
  uploadTotal: (p) => p.UploadTotal || 0,
  retransmit: (p) => p.RetransmitTotal || 0,
};

function getVisibleProcesses(snap) {
  let procs = (snap.Processes || []).slice();
  if (query) {
    const q = query.trim().toLowerCase();
    procs = procs.filter((p) =>
      (p.Name || '').toLowerCase().includes(q) || String(p.Pid).includes(q));
  }

  // 按应用聚合：同名进程（如 chrome.exe 多进程）合并为一行，PID 列改为进程数。
  if (viewMode === 'app') {
    const map = new Map();
    for (const p of procs) {
      const name = (p.Name || '').trim() || '(系统/未归因)';
      const key = name.toLowerCase();
      let agg = map.get(key);
      if (!agg) {
        agg = {
          Name: name,
          IconBase64: '',
          Pid: 0,
          DownloadBytes: 0,
          UploadBytes: 0,
          DownloadTotal: 0,
          UploadTotal: 0,
          RetransmitTotal: 0,
        };
        map.set(key, agg);
      }
      agg.Pid += 1;
      agg.DownloadBytes += p.DownloadBytes || 0;
      agg.UploadBytes += p.UploadBytes || 0;
      agg.DownloadTotal += p.DownloadTotal || 0;
      agg.UploadTotal += p.UploadTotal || 0;
      agg.RetransmitTotal += p.RetransmitTotal || 0;
      if (!agg.IconBase64 && p.IconBase64) agg.IconBase64 = p.IconBase64;
    }
    procs = Array.from(map.values());
  }

  const accessor = sortAccessors[sortKey];
  procs.sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av < bv) return -1 * sortDir;
    if (av > bv) return 1 * sortDir;
    return 0;
  });
  return procs;
}

function processRow(p) {
  const name = p.Name || '(系统/未归因)';
  const pidCell = viewMode === 'app' ? `×${p.Pid}` : p.Pid;
  const icon = p.IconBase64
    ? `<img class="proc-icon" src="${p.IconBase64}" alt="" />`
    : '<span class="proc-icon placeholder"></span>';
  const keyStr = viewMode === 'app'
    ? `app:${(p.Name || '').trim().toLowerCase()}`
    : `pid:${p.Pid}`;
  const tr = document.createElement('tr');
  tr.dataset.key = keyStr;
  if (selected && selected.keyStr === keyStr) tr.classList.add('selected');
  tr.innerHTML = `
    <td class="name">${icon}${esc(name)}</td>
    <td class="num">${pidCell}</td>
    <td class="num down">${fmtRate(p.DownloadBytes || 0)}</td>
    <td class="num up">${fmtRate(p.UploadBytes || 0)}</td>
    <td class="num">${fmtBytes(p.DownloadTotal || 0)}</td>
    <td class="num">${fmtBytes(p.UploadTotal || 0)}</td>
    <td class="num retrans">${fmtBytes(p.RetransmitTotal || 0)}</td>`;
  return tr;
}

function spacerRow(height) {
  const tr = document.createElement('tr');
  tr.className = 'spacer';
  tr.setAttribute('aria-hidden', 'true');
  const td = document.createElement('td');
  td.colSpan = 7;
  td.style.height = `${height}px`;
  tr.appendChild(td);
  return tr;
}

function emptyRow(msg) {
  const tr = document.createElement('tr');
  tr.className = 'empty-row';
  tr.innerHTML = `<td colspan="7">${esc(msg)}</td>`;
  return tr;
}

// 只渲染可视区内的行，用上下 spacer 撑出完整滚动高度。
function renderRows() {
  const procs = lastSnapshot ? getVisibleProcesses(lastSnapshot) : [];
  const total = procs.length;
  const viewportHeight = viewportEl.clientHeight || 600;
  const scrollTop = viewportEl.scrollTop;

  const frag = document.createDocumentFragment();

  if (total === 0) {
    const msg = lastSnapshot === null
      ? '正在等待采集服务…'
      : ((lastSnapshot.Processes || []).length === 0 ? '当前没有检测到网络活动' : '没有匹配的进程');
    frag.appendChild(emptyRow(msg));
    rowsEl.replaceChildren(frag);
    return;
  }

  let start = Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN;
  start = Math.max(0, start);
  let end = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN;
  end = Math.min(total, end);

  if (start > 0) frag.appendChild(spacerRow(start * ROW_HEIGHT));
  for (let i = start; i < end; i++) frag.appendChild(processRow(procs[i]));
  if (end < total) frag.appendChild(spacerRow((total - end) * ROW_HEIGHT));

  rowsEl.replaceChildren(frag);
}

function render(snap) {
  lastSnapshot = snap;

  totalDownEl.textContent = fmtRate(snap.TotalDownloadBytes || 0);
  totalUpEl.textContent = fmtRate(snap.TotalUploadBytes || 0);

  if (snap.Status === 'paused') {
    statusEl.textContent = '已暂停';
    statusEl.className = 'status paused';
  } else if (snap.Status !== 'ok') {
    statusEl.textContent = '采集服务异常（需管理员权限）';
    statusEl.className = 'status error';
  } else if ((snap.EventsLost || 0) > 0) {
    statusEl.textContent = `监控中 · 丢事件 ${snap.EventsLost}`;
    statusEl.className = 'status warn';
  } else {
    statusEl.textContent = '监控中';
    statusEl.className = 'status ok';
  }

  pushSample(snap);
  recordHist(snap);
  renderCards(snap);
  renderStatusBar(snap);
  renderRows();
  renderDetail();
}

function updateSortMarks() {
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    const mark = th.querySelector('.sort-mark');
    if (th.dataset.sort === sortKey) {
      mark.textContent = sortDir < 0 ? '▼' : '▲';
      th.classList.add('sorted');
    } else {
      mark.textContent = '';
      th.classList.remove('sorted');
    }
  });
}

// ===== 事件绑定 =====

document.querySelectorAll('thead th[data-sort]').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir = -sortDir;
    } else {
      sortKey = key;
      sortDir = -1;
    }
    updateSortMarks();
    viewportEl.scrollTop = 0;
    if (lastSnapshot) render(lastSnapshot);
  });
});

searchEl.addEventListener('input', () => {
  query = searchEl.value;
  viewportEl.scrollTop = 0;
  if (lastSnapshot) render(lastSnapshot);
});

const pidLabelEl = document.querySelector('.pid-label');
document.querySelectorAll('#viewToggle .vt').forEach((btn) => {
  btn.addEventListener('click', () => {
    viewMode = btn.dataset.view;
    document.querySelectorAll('#viewToggle .vt').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    pidLabelEl.textContent = viewMode === 'app' ? '进程数' : 'PID';
    viewportEl.scrollTop = 0;
    // 视图语义变了（PID 行 ⇄ 应用聚合行），清掉选中避免详情与行不匹配。
    selected = null;
    if (lastSnapshot) render(lastSnapshot);
  });
});

document.querySelectorAll('.chip[data-window]').forEach((chip) => {
  chip.addEventListener('click', () => {
    chartWindow = parseInt(chip.dataset.window, 10);
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    renderChart();
  });
});

let scrollRaf = null;
viewportEl.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    renderRows();
  });
});

// 行点击：选中/取消选中，驱动右侧详情面板。
rowsEl.addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  const keyStr = tr.dataset.key;
  if (selected && selected.keyStr === keyStr) {
    selected = null; // 再次点击同一行取消选中
  } else if (keyStr.startsWith('pid:')) {
    selected = { keyStr, mode: 'process', key: Number(keyStr.slice(4)), data: null };
  } else {
    selected = { keyStr, mode: 'app', key: keyStr.slice(4), data: null };
  }
  if (lastSnapshot) render(lastSnapshot);
});

detailCloseEl.addEventListener('click', () => {
  selected = null;
  if (lastSnapshot) render(lastSnapshot);
});

window.addEventListener('resize', () => {
  resizeChart();
  if (detailUplot) detailUplot.setSize({ width: detailChartEl.clientWidth, height: 110 });
});

listen('snapshot', (e) => render(e.payload));
listen('pipe-status', (e) => {
  if (e.payload !== 'connected') {
    statusEl.textContent = '未连接采集服务';
    statusEl.className = 'status';
  }
});

updateSortMarks();
initChart();
renderChart();
renderRows();
