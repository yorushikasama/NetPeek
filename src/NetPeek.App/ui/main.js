// NetPeek 前端主逻辑。监听采集服务经 Tauri 转发的 TrafficSnapshot 事件，
// 渲染顶栏总速率、进程表与右栏三卡；同时负责屏切换、迷你窗入口和无边框窗口的控制。
// 快照字段为 PascalCase（与 C# System.Text.Json 默认序列化一致）。
//
// 布局与样式规格见 docs/redesign/netpeek-redesign-v2.html。几条关键约束在这里体现：
// - 数字直接替换，不做补间：数据每秒一帧，补间等于永远在滚。
// - 一张图只答一个问题：带宽图答「总带宽这一分钟怎么走的」，
//   右栏实时图答「这个应用这一分钟怎么走的」，30 天图答「这个应用一个月用了多少」。
// - 不做装饰性动效：卡片层次靠底色差和 1px 边线给，不靠发光脉冲。

const { listen } = window.__TAURI__.event;
const C = window.NetPeekCharts;
const $ = (id) => document.getElementById(id);

const WINDOW_SECS = 60;      // 两张实时图的时间窗

const els = {
  frame: $('frame'),
  statusPill: $('statusPill'),
  statusText: $('statusText'),
  lostDot: $('lostDot'),
  topMeta: $('topMeta'),
  totalDownValue: $('totalDownValue'),
  totalDownUnit: $('totalDownUnit'),
  totalUpValue: $('totalUpValue'),
  totalUpUnit: $('totalUpUnit'),
  todayTotal: $('todayTotal'),
  todayDown: $('todayDown'),
  todayUp: $('todayUp'),
  viewToggle: $('viewToggle'),
  procCount: $('procCount'),
  search: $('search'),
  pidLabel: $('pidLabel'),
  rows: $('rows'),
  tableWrap: $('tableWrap'),
  procState: $('procState'),
  procStateTitle: $('procStateTitle'),
  procStateDesc: $('procStateDesc'),
  bandwidthChart: $('bandwidthChart'),
  nav: $('nav'),
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
let todayBase = { down: 0, up: 0 };  // 今日已落库的字节数（启动时从历史库取）
let todayDelta = { down: 0, up: 0 }; // 启动之后累加的字节数
let todayStamp = new Date().toDateString();

// 总带宽 60 秒环形缓冲
const samples = [];            // { t, down, up }
// 每个进程的 60 秒速率环形缓冲。键用 PID + 启动时刻：PID 会被系统复用，
// 只按 PID 存会把新进程接到上一个进程的曲线尾巴上（后端历史聚合同样按这两项）。
const procHist = new Map();    // "pid:startMs" -> { t: [], down: [], up: [] }

// 图标缓存：path -> dataURL。图标不再逐帧随进程下发（32px base64 每个 2–5KB，
// 每秒全量搬一遍是白扔的开销），采集端只在路径首次出现时发 IconUpdates，
// 这里收下并按路径解析 —— 进程数据里只带 Path，不再带图标本体。
const iconCache = new Map();

function mergeIcons(snap) {
  const updates = snap.IconUpdates;
  if (updates) for (const k of Object.keys(updates)) iconCache.set(k, updates[k]);
}

// 进程行图标解析：兼容旧协议（IconBase64 内联），新协议按 Path 查缓存。
function iconOf(p) {
  if (p.IconBase64) return p.IconBase64;
  return p.Path ? (iconCache.get(p.Path) || '') : '';
}

function histKey(p) {
  return `${p.Pid}:${p.StartTimeUnixMs || 0}`;
}

// ===== 格式化 =====

// 单位非 B 时把数值压到 999 上限。起因：999_999 字节 / 1000 = 999.999，
// 四舍五入成 "1000.0 KB" —— 数字跨出了自己的单位，读起来像计算错误。
// 压到 999 比进位换单位简单，且在显示层面与真实量级的偏差可忽略。
function clampUnit(n) {
  return n > 999 ? 999 : n;
}

function fmtRate(bps) {
  if (rateUnit === 'kb') return `${clampUnit(bps / 1e3).toFixed(1)} KB/s`;
  if (rateUnit === 'mb') return `${clampUnit(bps / 1e6).toFixed(1)} MB/s`;
  if (rateUnit === 'gb') return `${clampUnit(bps / 1e9).toFixed(2)} GB/s`;
  // GB 档此前缺失：万兆链路（1.25 GB/s）会被压在 "999.00 MB/s"，与 fmtBytes 的档位也不一致。
  if (bps >= 1e9) return `${clampUnit(bps / 1e9).toFixed(2)} GB/s`;
  if (bps >= 1e6) return `${clampUnit(bps / 1e6).toFixed(2)} MB/s`;
  if (bps >= 1e3) return `${clampUnit(bps / 1e3).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}

function fmtBytes(bytes) {
  if (rateUnit === 'kb') return `${clampUnit(bytes / 1e3).toFixed(1)} KB`;
  if (rateUnit === 'mb') return `${clampUnit(bytes / 1e6).toFixed(1)} MB`;
  if (rateUnit === 'gb') return `${clampUnit(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e9) return `${clampUnit(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${clampUnit(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${clampUnit(bytes / 1e3).toFixed(1)} KB`;
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

// 数字主体 + 小一号的灰单位，同一规则铺到表格速率、检查栏累计、今日合计 ——
// 单位跟着数字同大小同色时，一列数字读起来是三段等重的字符串，量级感出不来。
// 复用首次插入的节点：速率单元格每秒刷新，不能每次 replaceChildren 造垃圾。
function setRateCell(cell, text) {
  const { value, unit } = splitUnit(text);
  if (!cell._rateV) {
    const v = document.createTextNode('');
    const u = document.createElement('span');
    u.className = 'u';
    cell.replaceChildren(v, u);
    cell._rateV = v;
    cell._rateU = u;
  }
  if (cell._rateV.nodeValue !== value) cell._rateV.nodeValue = value;
  if (cell._rateU.textContent !== unit) cell._rateU.textContent = unit;
}

// 一次性场景（累计值 / 今日合计），不值得预建节点
function setSplitText(el, text) {
  const { value, unit } = splitUnit(text);
  const u = document.createElement('span');
  u.className = 'u';
  u.textContent = unit;
  el.replaceChildren(value, u);
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// 本界面不用 innerHTML 拼外部字符串（表格行走 DOM API），无需转义器；
// 其余脚本统一从 common.js 取 escapeHtml。

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
    todayBase = { down: 0, up: 0 };
    todayDelta = { down: 0, up: 0 };
  }
  todayDelta.down += snap.TotalDownloadBytes || 0;
  todayDelta.up += snap.TotalUploadBytes || 0;
}

async function loadTodayBase() {
  try {
    const raw = await window.__TAURI__.core.invoke('history_daily', { days: 1 });
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const base = { down: 0, up: 0 };
    for (const r of JSON.parse(raw || '[]')) {
      if (r.day === key) {
        base.down += r.down || 0;
        base.up += r.up || 0;
      }
    }
    todayBase = base;
  } catch { todayBase = { down: 0, up: 0 }; }
}

// ===== 顶栏 =====

const STATUS = {
  ok:        { cls: 'is-ok',    text: '监控中' },
  paused:    { cls: 'is-warn',  text: '已暂停' },
  starting:  { cls: 'is-warn',  text: '正在启动采集' },
  error:     { cls: 'is-error', text: '服务异常 · 需管理员权限' },
  connecting:{ cls: 'is-warn',  text: '连接中' },
  offline:   { cls: '',         text: '未连接采集服务' },
};

// 快照 Status（ok / paused / starting / error）→ STATUS 的键。
// starting 必须单列：ETW 会话在后台起，含残留会话清理实测 0.3–2.4s，这段窗口里
// 管道已经在推帧但还没有事件——归到 error 就是在每次启动的头几秒稳定播报
// 「服务异常 · 需管理员权限」，与事实相反。未知值仍按 error 兜底。
function statusKey(status) {
  return status === 'ok' || status === 'paused' || status === 'starting' ? status : 'error';
}

function setStatus(kind) {
  const s = STATUS[kind] || STATUS.offline;
  els.statusPill.className = `top-status ${s.cls}`.trim();
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

  // 顶栏元信息承接原检查栏总览的「已采集 / N 个进程」：采集状态是常看项，
  // 放在视野里比收进详情卡字段里顺手
  const startedMs = snap.SessionStartedUnixMs || 0;
  const upSec = startedMs > 0 ? ((snap.TimestampUnixMs || Date.now()) - startedMs) / 1000 : samples.length;
  const procN = (snap.Processes || []).length;
  els.topMeta.textContent = `已采集 ${fmtDuration(upSec)} · ${procN} 个进程`;

  // 今日卡：合计大字 + 下载/上传两个小值
  setSplitText(els.todayTotal, fmtBytes(todayBase.down + todayDelta.down + todayBase.up + todayDelta.up));
  setSplitText(els.todayDown, fmtBytes(todayBase.down + todayDelta.down));
  setSplitText(els.todayUp, fmtBytes(todayBase.up + todayDelta.up));

  const lost = snap.EventsLost || 0;
  els.lostDot.hidden = lost === 0;
  if (lost > 0) {
    const msg = `事件丢失 ${lost} 条 · 实际用量可能高于显示值`;
    els.lostDot.title = msg;
    els.lostDot.setAttribute('aria-label', msg);
  }

  setStatus(statusKey(snap.Status));
}

// ===== 搜索 =====

// 统一前缀语义（照 Sniffnet 的 FilterInputType 做法）：=x 精确、!=x 不等于、!x 不含、x 含。
// 大小写一律不敏感。加维度只改这张表，不改判断逻辑——这是把「搜索」从
// 一串 includes 变成可扩展机制的关键。
function parseQuery(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  let op = 'has';
  let body = text;
  if (text.startsWith('!=')) { op = 'ne'; body = text.slice(2); }
  else if (text.startsWith('=')) { op = 'eq'; body = text.slice(1); }
  else if (text.startsWith('!')) { op = 'not'; body = text.slice(1); }
  // 只认最前面那一个操作符，后面出现的一律当普通字符——`!a=b` 是「不含 'a=b'」，
  // 不做嵌套解析（搜索框不是查询语言，多一层规则就多一层要记的东西）。
  body = body.trim().toLowerCase();
  if (!body) return null;
  return { op, body };
}

// 参与搜索的维度。名字用英文键是为了让用户能 `=chrome.exe` 这种写法保持直觉：
// 这里比的是「值」，不引入字段名语法，避免多一层要记的规则。
function searchFields(p) {
  const S = window.NetPeekServices || {};
  const port = Number(p.TopRemotePort) || 0;
  return [
    p.Name || '',
    p.Path || '',
    String(p.Pid),
    p.TopRemoteIp || '',
    port > 0 ? String(port) : '',
    S.serviceName ? S.serviceName(port) : '',
    p.TopRemoteCountry || '',
    S.bogonLabel ? S.bogonLabel(p.TopRemoteIp || '') : '',
  ];
}

function matchesQuery(p, q) {
  if (!q) return true;
  const fields = searchFields(p).map((v) => String(v).toLowerCase());
  switch (q.op) {
    case 'eq': return fields.some((v) => v === q.body);
    case 'ne': return fields.every((v) => v !== q.body);
    case 'not': return fields.every((v) => !v.includes(q.body));
    default: return fields.some((v) => v.includes(q.body));
  }
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
  const q = parseQuery(query);
  if (q) procs = procs.filter((p) => matchesQuery(p, q));

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
          TopRemoteIp: '', TopRemotePort: 0, TopRemoteCountry: '', _memberBytes: -1,
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
      if (!agg.IconBase64) agg.IconBase64 = iconOf(p);
      // 聚合行显示流量最大成员的对端（每秒都在变，取最热的一个有代表性）
      const memberBytes = (p.DownloadBytes || 0) + (p.UploadBytes || 0);
      if (memberBytes > agg._memberBytes) {
        agg._memberBytes = memberBytes;
        agg.TopRemoteIp = p.TopRemoteIp || '';
        agg.TopRemotePort = p.TopRemotePort || 0;
        agg.TopRemoteCountry = p.TopRemoteCountry || '';
      }
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
    <td class="td-peer"></td>
    <td class="is-num td-pid"></td>
    <td class="is-num td-rate down"></td>
    <td class="is-num td-rate up"></td>`;
  tr.refs = {
    img: tr.querySelector('img.proc-icon'),
    ph: tr.querySelector('.proc-icon.is-placeholder'),
    name: tr.querySelector('.row-name'),
    suffix: tr.querySelector('.count-suffix'),
    peer: tr.querySelector('.td-peer'),
    pid: tr.children[2],
    down: tr.children[3],
    up: tr.children[4],
  };
  return tr;
}

// 对端图标节点。key 形如 '' | 'sem:lan' | 'jp'。
// 国家码走 flags.png 雪碧图（就近取位，无网络、无解码开销）；
// 语义图标走内联 SVG，stroke 用 currentColor 以便跟随主题。
// 两者内容都来自自有常量、不含任何网络数据，所以这里的 innerHTML 是安全的。
function peerIconNode(key) {
  const F = window.NetPeekFlags;
  if (!key || !F) return null;
  // 形状合法但雪碧图里没有的码（DB-IP 的 ZZ、或库里新增而我们没重新生成图）必须退回
  // 语义图标——否则这个格子会既没有旗也没有图标，看着像渲染失败。
  const sem = key.startsWith('sem:') ? key.slice(4) : F.pos(key) ? '' : 'unknown';
  const el = document.createElement('span');
  if (sem) {
    const html = F.semantic(sem);
    if (!html) return null;
    el.className = 'peer-icon';
    el.innerHTML = html;
  } else {
    el.className = 'peer-flag';
    el.style.backgroundImage = 'url(flags.png)';
    el.style.backgroundPosition = F.pos(key);
    el.style.backgroundSize = `${F.size.sheetW}px ${F.size.sheetH}px`;
  }
  el.style.width = `${F.size.w}px`;
  el.style.height = `${F.size.h}px`;
  return el;
}

// 对端单元格：图标 + IP + 服务名。
// 图标只在 key 变化时重建——1 Hz 刷新下每秒重设一次 innerHTML 是白扔的开销，
// 也会把正在显示的悬浮提示打断。文本走独立文本节点，其余全程 textContent 语义。
function updatePeerCell(cell, p) {
  const S = window.NetPeekServices || {};
  const parts = S.peerParts
    ? S.peerParts(p.TopRemoteIp || '', Number(p.TopRemotePort) || 0, p.TopRemoteCountry || '')
    : { icon: '', text: '', title: '' };

  if (!parts.text) {
    if (cell.textContent !== '—') cell.textContent = '—';
    cell.title = '';
    cell._peerIcon = undefined;
    cell._peerText = null;
    cell.classList.remove('has-peer');
    return;
  }

  if (cell._peerIcon !== parts.icon) {
    cell._peerIcon = parts.icon;
    const icon = peerIconNode(parts.icon);
    const text = document.createTextNode('');
    cell.replaceChildren(...(icon ? [icon] : []), text);
    cell._peerText = text;
  }
  if (cell._peerText.nodeValue !== parts.text) cell._peerText.nodeValue = parts.text;
  if (cell.title !== parts.title) cell.title = parts.title;
  cell.classList.add('has-peer');
}

function updateRow(tr, p, peakDown) {
  const r = tr.refs;
  const name = p.Name || '(系统/未归因)';
  const icon = iconOf(p);
  if (icon) {
    if (r.img.getAttribute('src') !== icon) r.img.src = icon;
    r.img.hidden = false;
    r.ph.hidden = true;
  } else {
    r.img.hidden = true;
    r.ph.hidden = false;
    r.ph.textContent = initialOf(name, 1);
  }
  if (r.name.textContent !== name) r.name.textContent = name;
  r.suffix.textContent = viewMode === 'app' ? `×${p.Pid}` : '';
  updatePeerCell(r.peer, p);
  r.pid.textContent = viewMode === 'app' ? `${p.Pid} 个进程` : p.Pid;
  setRateCell(r.down, fmtRate(p.DownloadBytes || 0));
  setRateCell(r.up, fmtRate(p.UploadBytes || 0));

  // 占比不占列宽：整行背景一条从左起的极淡下载色渐变（§2.5）。
  // 渐变本身写在 styles.css 的 .proc-table tbody tr 里，这里只喂百分比 ——
  // 原来这里拼的是写死的 rgba(240,145,63)，换主题时这条占比条不跟着走。
  const share = peakDown > 0 ? Math.min(100, Math.round(((p.DownloadBytes || 0) / peakDown) * 100)) : 0;
  const pct = `${share}%`;
  if (tr.style.getPropertyValue('--share') !== pct) tr.style.setProperty('--share', pct);

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
  const icon = window.NetPeekCommon.icon;
  for (const th of document.querySelectorAll('.proc-table th[data-sort]')) {
    const on = th.dataset.sort === sortKey;
    th.classList.toggle('is-sorted', on);
    th.querySelector('.sort-mark').innerHTML = on ? icon(sortDir === -1 ? 'caret-down' : 'caret-up') : '';
    // 读屏用户靠 aria-sort 知道当前按哪列、什么方向排序，光标图形它读不到
    th.setAttribute('aria-sort', on ? (sortDir === -1 ? 'descending' : 'ascending') : 'none');
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
  starting: {
    // 管道已连上、帧也在来，只是 ETW 会话还在后台起（含残留会话清理，实测
    // 0.3–2.4s）。骨架条而不是异常卡片：这几秒是正常启动流程，不该报错。
    title: '正在启动采集会话', desc: '内核 ETW 会话就绪后会立刻出现数据。', retry: false, skeleton: true,
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
  setSplitText(els.inspDownTotal, fmtBytes(all.reduce((s, p) => s + (p.DownloadTotal || 0), 0)));
  setSplitText(els.inspUpTotal, fmtBytes(all.reduce((s, p) => s + (p.UploadTotal || 0), 0)));
  els.inspUpLabel.textContent = '累计上传';

  els.inspLiveSec.hidden = true;
  els.inspFieldsSec.hidden = false;
  renderFields(snap);
  render30Day(null);
}

// 详情态。会话时长按进程创建时间算，不是「选中以来」。
// 详情行是「字符串 / 图标块」混排：国旗是图片节点，没法塞进 join 出来的字符串，
// 所以按节点拼。分隔符统一在这里生成，调用方只关心片段顺序。
function setInspMeta(parts) {
  const frag = document.createDocumentFragment();
  parts.forEach((part, i) => {
    if (i > 0) frag.appendChild(document.createTextNode(' · '));
    if (typeof part === 'string') {
      frag.appendChild(document.createTextNode(part));
      return;
    }
    if (part.lead) frag.appendChild(document.createTextNode(part.lead));
    const icon = peerIconNode(part.icon);
    if (icon) frag.appendChild(icon);
    frag.appendChild(document.createTextNode(part.text || ''));
  });
  els.inspMeta.replaceChildren(frag);
}

function renderDetail(snap, p) {
  const name = p.Name || '(系统/未归因)';
  const icon = iconOf(p);
  if (icon) {
    if (els.inspIcon.getAttribute('src') !== icon) els.inspIcon.src = icon;
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
  // 本秒最热的对端也上详情行：检查栏是看「这个应用在和谁说话」最顺眼的地方。
  // 这一项带图标，所以是对象而不是字符串（国旗是节点，塞不进一个串里）。
  if (p.TopRemoteIp) {
    const S = window.NetPeekServices || {};
    const d = S.peerParts
      ? S.peerParts(p.TopRemoteIp, Number(p.TopRemotePort) || 0, p.TopRemoteCountry || '')
      : null;
    if (d) parts.push({ lead: '对端 ', icon: d.icon, text: d.detail });
  }
  setInspMeta(parts);

  setSplitText(els.inspDownTotal, fmtBytes(p.DownloadTotal || 0));
  setSplitText(els.inspUpTotal, fmtBytes(p.UploadTotal || 0));
  els.inspUpLabel.textContent = '累计上传';

  els.inspFieldsSec.hidden = true;
  els.inspLiveSec.hidden = false;
  els.inspLiveDown.innerHTML = window.NetPeekCommon.icon('caret-down') + fmtRate(p.DownloadBytes || 0);
  els.inspLiveUp.innerHTML = window.NetPeekCommon.icon('caret-up') + fmtRate(p.UploadBytes || 0);
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

  els.fldService.textContent = STATUS[statusKey(snap.Status)].text;

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

function chartOpts(extra) {
  return Object.assign({
    window: WINDOW_SECS,
    xLabels: [`-${WINDOW_SECS}s`, '现在'],
    formatY: C.axisRate,
    tipSuffix: '/s',   // 悬停读数的单位后缀（y 轴走紧凑 formatY，读数走全精度）
  }, extra);
}

// 暂停时曲线尾巴转虚线，从暂停那一刻的下标开始（§2.8）
let pausedIndex = -1;

function drawBandwidth() {
  if (!els.bandwidthChart) return;
  if (!lastSnapshot) {
    C.line(els.bandwidthChart, chartOpts({ axesOnly: true, yMax: 1 }));
    return;
  }
  C.line(els.bandwidthChart, chartOpts({
    series: [
      { values: samples.map((s) => s.down), color: C.cssVar('--down'), label: '下载' },
      { values: samples.map((s) => s.up), color: C.cssVar('--up'), label: '上传' },
    ],
    dashFrom: pausedIndex,
  }));
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
  if (!s.down.length) {
    C.line(els.inspLiveChart, chartOpts({ axesOnly: true, yMax: 1 }));
    return;
  }
  C.line(els.inspLiveChart, chartOpts({
    series: [
      { values: s.down, color: C.cssVar('--down'), label: '下载' },
      { values: s.up, color: C.cssVar('--up'), label: '上传' },
    ],
    dashFrom: pausedIndex,
  }));
}

// 30 天下载柱图。检查栏只有 296px 宽，挤不开双色分组柱，上传去历史屏看（§2.4）。
// 数据复用历史屏那一次日聚合查询，不再单独查库。
let last30Name = undefined;

async function render30Day(name, force) {
  if (!force && name === last30Name) return;
  last30Name = name;
  els.insp30Title.textContent = name ? '30 天下载' : '30 天下载（全部应用）';
  if (!window.NetPeekHistoryUI) return;
  try {
    const points = await window.NetPeekHistoryUI.dailyFor(name, 30);
    if (last30Name !== name) return;      // 期间又换了选中行，这份结果作废
    const total = points.reduce((s, p) => s + p.value, 0);
    els.insp30Total.textContent = `合计 ${fmtBytes(total)}`;
    C.bars(els.insp30Chart, {
      groups: points.map((p) => ({ label: p.label, values: [p.value] })),
      formatY: C.axisBytes,
      xLabels: points.length ? [points[0].label, points[points.length - 1].label] : [],
      seriesNames: ['下载'],
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

  if (snap.Status === 'starting') setProcState('starting');
  else if (snap.Status !== 'ok' && snap.Status !== 'paused') setProcState('error');
  else if (procs.length === 0) setProcState(parseQuery(query) ? 'empty' : 'idle');
  else setProcState(null);

  renderInspector(snap, procs);
  drawBandwidth();
}

function onSnapshot(snap) {
  lastSnapshot = snap;
  mergeIcons(snap);
  pushSamples(snap);
  accumulateToday(snap);
  // 暂停是从当前这一帧起虚线；恢复后回到全实线
  pausedIndex = snap.Status === 'paused'
    ? (pausedIndex >= 0 ? pausedIndex : samples.length - 1)
    : -1;
  if (window.NetPeekSettingsUI) window.NetPeekSettingsUI.updateService(snap);
  // 窗口隐藏到托盘后不做任何渲染：记账照跑（今日合计、采样缓冲），省掉每秒
  // 一轮的 DOM 更新和 canvas 重画。恢复可见时补一帧，不等下一秒。
  if (document.hidden) return;
  if (screen !== 'live') return;         // 别的屏不用重画实时件
  renderAll(snap);
}

// 断线：数字停在最后一帧，图只留坐标轴，表格换成可重试的异常态（§2.8）
function onDisconnected() {
  setStatus('offline');
  setProcState('offline');
  setFieldsOffline();
  C.line(els.bandwidthChart, chartOpts({ axesOnly: true, yMax: 1 }));
  if (window.NetPeekSettingsUI) window.NetPeekSettingsUI.updateServiceOffline();
}

// ===== 屏切换 =====
// 主区三屏互斥显示；rail 的选中态跟过去。视图切换和搜索在表格卡头里，
// 随 live 屏整体显隐，不需要单独处理。

function setScreen(next) {
  if (next === screen) return;
  screen = next;
  for (const pane of document.querySelectorAll('.screen[data-screen]')) {
    pane.hidden = pane.dataset.screen !== next;
  }
  for (const btn of els.nav.querySelectorAll('.ri[data-screen]')) {
    const on = btn.dataset.screen === next;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-current', on ? 'page' : 'false');
  }

  if (next === 'live' && lastSnapshot) renderAll(lastSnapshot);
  if (next === 'history' && window.NetPeekHistoryUI) window.NetPeekHistoryUI.onEnter();
  if (next === 'settings' && window.NetPeekSettingsUI) window.NetPeekSettingsUI.onEnter();
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
    const btn = e.target.closest('.ri[data-screen]');
    if (btn) setScreen(btn.dataset.screen);
  });

  // 迷你窗入口：rail 底部的独立开关，托盘/能量球之外的第三个入口
  $('miniToggle').addEventListener('click', async () => {
    try { await window.__TAURI__.core.invoke('toggle_mini'); } catch { /* ignore */ }
  });

  // 今日合计 → 历史屏：实时屏里唯一指向「更早的数据」的数字，
  // 点它就该去历史屏，而不是让用户自己去导航岛找图标（button 原生响应 Enter/Space）
  $('todayBtn').addEventListener('click', () => setScreen('history'));

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

  // 从托盘恢复可见：onSnapshot 在隐藏期间提前返回了，这里立即补一帧，
  // 否则界面要干等到下一秒的快照才更新。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && screen === 'live' && lastSnapshot) renderAll(lastSnapshot);
  });
}

// ===== 启动 =====

// history-ui.js 要用最近一帧快照借应用图标，settings-ui.js 要用同一套字节格式化。
window.NetPeekLive = {
  lastSnapshot: () => lastSnapshot,
  fmtBytes,
  fmtRate,
  initialOf,
  iconOf,
  UNATTR,
};

async function boot() {
  renderSortMarks();
  setProcState('connecting');
  bindTable();
  bindControls();

  // 管道监听先挂上：后面的主题、设置、首绘任何一步抛错都不该让界面收不到快照
  if (window.__TAURI__) {
    await listen('snapshot', (e) => onSnapshot(e.payload));
    await listen('pipe-status', (e) => {
      if (e.payload === 'connected') setProcState('connecting');
      else onDisconnected();
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
  await loadTodayBase();

  drawBandwidth();
  render30Day(null, true);
}

boot();
