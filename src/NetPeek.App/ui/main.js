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
const $ = (id) => window.NetPeekCommon.byId(id, 'main');

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
  sortReset: $('sortReset'),
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
  detailCard: $('detailCard'),
};

// ===== 状态 =====

let lastSnapshot = null;
let query = '';
// 排序状态。sortKey 为空串 = 「未排序」，表格走默认顺序（见 DEFAULT_SORT）且表头不标箭头。
// 这一态是必须存在的：以前只有「按某列升/降序」两种，点完列头就再也回不到默认呈现，
// 想按上传看过一眼再回到「谁在占带宽」得靠用户自己记住默认是按下载降序。
let sortKey = '';
let sortDir = -1;              // 1 升序 / -1 降序。sortKey 为空时无意义
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

// 常驻托盘数天时，不同可执行文件路径会持续累积。Map 按插入序迭代，超上限时
// 从最旧的键开始逐条淘汰（近似 LRU）：图标丢了下一帧采集端会重发，只是一次额外提取，
// 不影响正确性。上限取机器上不同可执行文件数量级的宽松值。
const ICON_CACHE_MAX = 2048;
function capMap(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function mergeIcons(snap) {
  const updates = snap.IconUpdates;
  if (updates) for (const k of Object.keys(updates)) iconCache.set(k, updates[k]);
  capMap(iconCache, ICON_CACHE_MAX);
}

// 名称 -> 图标，本次会话只增不减。历史屏要给「昨天跑过、现在已经退出」的应用配
// 图标，而 iconCache 是按路径存的、只有当前帧的进程才知道自己的路径，所以这里
// 按进程名再记一份。同名不同路径（多版本、多安装位置）保留先到的那个：历史是
// 按名字聚合的，本来就分不开这两者。
const iconByName = new Map();

function rememberIcons(snap) {
  for (const p of snap.Processes || []) {
    const name = (p.Name || '').toLowerCase();
    if (!name || iconByName.has(name)) continue;
    const icon = iconOf(p);
    if (icon) iconByName.set(name, icon);
  }
  capMap(iconByName, ICON_CACHE_MAX);
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
// 实现全部在 common.js：小窗是独立 webview，历史屏又要跟表格里的数字对得上，
// 各写一份迟早漂移成三套档位。这里只是把当前的 rateUnit 绑上去。

const _K = window.NetPeekCommon;
const UNATTR = _K.UNATTR;

function fmtRate(bps) { return _K.fmtRate(bps, rateUnit); }
function fmtBytes(bytes) { return _K.fmtBytes(bytes, rateUnit); }
function initialOf(name, len) { return _K.initialOf(name, len); }

// 顶栏的数字和单位分两个元素：单位降到 75% 不透明度且不跟着数字放大（§2.2）
function splitUnit(text) { return _K.splitUnit(text); }

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

// ===== 近 24 小时汇总 =====
// 历史库由 Rust 侧按「进程实例 × 分钟」落库（minute_stats），这里只把最近 24 小时的
// 合计整理成两张表：进程视图按实例取，应用视图按名字取。
// 不每秒查库：聚合本身就是整分钟翻转才落库的，当前这一分钟还在内存桶里，
// 刷新对齐到下一分钟之后一次就够（scheduleDay24）。

const DAY24_HOURS = 24;

// byKey: "pid:启动秒" -> {down, up}；byName: 小写应用名 -> {down, up}
let day24Tables = { byKey: new Map(), byName: new Map(), ready: false };

/** 进程身份键，与历史库的 (pid, start_ts) 对齐 —— 注意 start_ts 是**秒**。 */
function day24Key(p) {
  return `${p.Pid}:${Math.floor((p.StartTimeUnixMs || 0) / 1000)}`;
}

/**
 * 把 history_process_totals 的原始行整理成两张表。
 *
 * 空名字归一成 UNATTR：历史库里未归因进程的 name 是空串，而表格把它显示成
 * 「(系统/未归因)」—— 不归一，那一行的近 24 小时永远是破折号。
 * 同名同键的多行累加而不是覆盖：进程改名会让库里留下两行（后端把 name 也放进了
 * 分组键），覆盖等于把改名之前的量整段丢掉。
 *
 * 第三张表 byPid 是为**历史遗留的 start_ts=0 行**准备的（2026-09-21）。
 * 采集端曾经在拿不到进程启动时间时把它写成 0（成因见 ProcessMetadataCache.Fetch：
 * 句柄开不出来但名字拿得到，于是那一行有名字、没有身份键）。这类行按
 * `pid:0` 也能查到，**但前提是实时行那一侧也算出同一个键** —— 而实时行的
 * StartTimeUnixMs 同样可能缺失（那条路会给出 0 或干脆没有这个字段），
 * 于是两边一个写 0、一个写别的，键对不上，数据就"消失"了。
 *
 * 所以这里对 start_ts=0 的行额外登记一份「按 PID 兜底」的表：只有当实时行
 * 自己也没有可用启动时间时才会用到它（见 day24Of）。这样
 * ① 新数据不再产生这类行（采集端已修）；
 * ② 库里已有的老行也能重新被看见 —— 用户库里这样的行有 2,387 条、约 5.7 GB。
 */
function buildDay24(rows) {
  const byKey = new Map();
  const byName = new Map();
  // 仅收 start_ts=0 的行：有正常身份键的行不需要兜底（键就能精确匹配），
  // 把所有的行都塞进来只会让「按 PID 匹配」命中一堆同名不同实例的记录。
  const byPidOrphan = new Map();
  const unattr = UNATTR.toLowerCase();
  // name 一并存下来：幽灵行（已退出进程，见 ghostProcesses）没有实时快照可依，
  // 名字只能从历史行里取。同键多行时留先到的非空名，空名归一成「(系统/未归因)」。
  const add = (map, key, down, up, name) => {
    const hit = map.get(key);
    if (hit) { hit.down += down; hit.up += up; if (!hit.name && name) hit.name = name; }
    else map.set(key, { down, up, name: name || '' });
  };
  for (const r of rows || []) {
    const down = Number(r.down) || 0;
    const up = Number(r.up) || 0;
    const startTs = Number(r.startTs) || 0;
    const name = String(r.name || '').trim() || UNATTR;
    add(byKey, `${r.pid}:${startTs}`, down, up, name);
    add(byName, String(r.name || '').trim().toLowerCase() || unattr, down, up, name);
    // 名字为空的老行也收：它们只能靠 PID 认领（本来就没有别的线索）。
    if (startTs === 0) add(byPidOrphan, String(r.pid), down, up, name);
  }
  return { byKey, byName, byPidOrphan, ready: true };
}

/**
 * 取某一行对应的近 24 小时合计；历史库里没有这个身份/应用就返回 null。
 *
 * 进程视图的查找顺序（2026-09-21 起）：
 * 1. 精确身份键 `pid:start_ts` —— 正常路径，PID 复用时不会串到别的实例上。
 * 2. 实时行自己**没有可用启动时间**时（StartTimeUnixMs 缺失或为 0），
 *    退到 byPidOrphan 里按 PID 认领 start_ts=0 的老行。
 *
 * 第 2 条只在实时行确实没有身份时启用，这是刻意的：PID 会被系统复用，
 * 无差别按 PID 匹配会让「今天的 chrome(1234)」认领「三天前的某个 1234」的流量。
 * 而实时行自己都没拿到启动时间时，它本来就无法证明自己不是那个 1234 ——
 * 与其让那一段数据彻底不可见（旧行为），不如认领并如实显示。
 */
function day24Of(tables, p, mode) {
  if (!tables || !tables.ready) return null;
  if (mode === 'app') {
    const name = (p.Name || '').trim().toLowerCase() || UNATTR.toLowerCase();
    return tables.byName.get(name) || null;
  }
  const hit = tables.byKey.get(day24Key(p));
  if (hit) return hit;
  // 实时行没有启动时间 → 身份键是 `pid:0` 这个不可靠的形态，去老行表里认领。
  if (!(p.StartTimeUnixMs > 0)) {
    return tables.byPidOrphan.get(String(p.Pid)) || null;
  }
  return null;
}

/**
 * 单元格文案与悬浮说明。
 *
 * 没有记录时给破折号，不给「0 B」：0 B 是「记录到了零流量」的陈述，而这里更常见的
 * 情形是这一分钟还没落库（进程刚启动）或历史库刚被清空 —— 那时我们根本没测到，
 * 写 0 等于编一个读数出来（同顶栏断连时的破折号，见 blankRates）。
 */
function day24Cell(hit) {
  if (!hit) {
    return { text: '—', blank: true, title: '近 24 小时：暂无记录（进程刚启动，或历史库为空）' };
  }
  return {
    text: fmtBytes(hit.down + hit.up),
    blank: false,
    title: `近 24 小时：下载 ${fmtBytes(hit.down)} · 上传 ${fmtBytes(hit.up)}`,
  };
}

// 单批幽灵行的上限：超出的折成一行"其它已退出进程"。库里一天可能有上千个
// 短命实例，全渲染既压垮表格也没意义 —— 大头单列、长尾归一，整列求和照样守恒。
const GHOST_LIMIT = 40;

/**
 * "幽灵行"：近 24 小时里活跃过、但当前快照里已不在的进程实例 / 应用。
 *
 * 为什么要它：监控列表的"近24小时"这一列是挂在实时进程行上的（day24Of 按实时行的
 * 身份去历史库反查）。可一天的用量大头往往来自短命进程 —— AI 代理、构建、node/java、
 * 浏览器子进程 —— 它们早退出了，实时列表里没有它们的行，那几个 G 的历史量就无处显示，
 * 于是"把列表里的近24小时加起来"会明显小于真实用量（实测本机某天已退出进程占 64%）。
 * 这里把历史表里"没被任何实时行认领"的条目捞出来，渲染成实时行下方的一段历史行。
 *
 * covered 用来排除已被实时行显示的身份，避免重复计数：
 * - 进程视图：实时行的精确身份键 day24Key(p)；实时行没有启动时间时，它会走 byPidOrphan
 *   按 `pid:0` 认领老行（见 day24Of），所以这里也把 `pid:0` 记进 covered。
 * - 应用视图：实时行的小写名。有实时行的应用，其"近24小时"经 byName 本就已含全部实例，
 *   不需要补；只有整个应用都退出了才需要一行幽灵。
 */
function ghostProcesses(tables, liveProcs, mode) {
  if (!tables || !tables.ready) return [];
  const covered = new Set();
  for (const p of liveProcs || []) {
    if (mode === 'app') {
      covered.add((p.Name || '').trim().toLowerCase() || UNATTR.toLowerCase());
    } else {
      covered.add(day24Key(p));
      if (!(p.StartTimeUnixMs > 0)) covered.add(`${p.Pid}:0`);
    }
  }
  const src = mode === 'app' ? tables.byName : tables.byKey;
  const out = [];
  for (const [key, v] of src) {
    if (covered.has(key)) continue;
    out.push({ key, name: v.name || '', down: v.down || 0, up: v.up || 0 });
  }
  return out;
}

/**
 * 幽灵行排序：实时速率恒为 0，按当前排序键落到历史量上 —— 下载/上传各取对应方向，
 * 其余键（含默认的合计档、PID 列）一律按历史合计。名字列按名字。
 */
function sortGhosts(list, effKey, effDir) {
  const acc = effKey === 'name'
    ? (g) => (g.name || '').toLowerCase()
    : effKey === 'download' ? (g) => g.down
      : effKey === 'upload' ? (g) => g.up
        : (g) => g.down + g.up;
  return list.slice().sort((a, b) => {
    const av = acc(a);
    const bv = acc(b);
    if (av < bv) return -effDir;
    if (av > bv) return effDir;
    return 0;
  });
}

/**
 * 截断成最多 GHOST_LIMIT 个独立行 + 一行折叠尾。
 *
 * 截断按**历史合计**取头部（不管用户此刻按哪列排序）：留下的永远是量最大的那些，
 * 折叠的是长尾。折叠行携带长尾的合计并恒排在末尾，这样无论怎么排，
 * 这一列的求和都仍等于库内真实 24h 总量 —— 这正是这个功能要保证的那件事。
 */
function capGhosts(list, effKey, effDir) {
  let kept = list;
  let tailRow = null;
  if (list.length > GHOST_LIMIT) {
    const byTotal = list.slice().sort((a, b) => (b.down + b.up) - (a.down + a.up));
    kept = byTotal.slice(0, GHOST_LIMIT);
    const tail = byTotal.slice(GHOST_LIMIT);
    let d = 0;
    let u = 0;
    for (const g of tail) { d += g.down; u += g.up; }
    tailRow = { key: '__tail__', name: `其它已退出进程（${tail.length} 个）`, down: d, up: u, tail: true };
  }
  const sorted = sortGhosts(kept, effKey, effDir);
  if (tailRow) sorted.push(tailRow); // 折叠行恒在末尾，不参与排序
  return sorted;
}

async function loadDay24() {
  try {
    const raw = await window.__TAURI__.core.invoke('history_process_totals', { hours: DAY24_HOURS });
    day24Tables = buildDay24(JSON.parse(raw || '[]'));
  } catch {
    // 读库失败保留上一份表：这是一份 24 小时汇总，晚一轮不影响任何判断；
    // 清成空会让整列同时变成破折号，看着像采集坏了 —— 而它只是这一次读库失败。
  }
}

/** 对齐到「整分钟翻转 + 2 秒」再刷一次：落库在整分钟做，早查只会白查一轮。 */
function scheduleDay24() {
  const wait = 60_000 - (Date.now() % 60_000) + 2000;
  setTimeout(async () => { await loadDay24(); scheduleDay24(); }, wait);
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

// 断线时把两个速率换成占位破折号，而不是留着上一帧的数字或归零。
// 归零是「测得零流量」的陈述，而这时候我们根本没在测；留旧值是过期读数。
// 破折号是唯一不撒谎、又不会让顶栏塌陷的选择（20px 等宽，宽度几乎等于数字）。
function blankRates() {
  for (const [v, u] of [[els.totalDownValue, els.totalDownUnit], [els.totalUpValue, els.totalUpUnit]]) {
    v.textContent = '—';
    u.textContent = '';
    // 破折号不继承下载/上传的语义色 —— 它不是数据，是「没有数据」，
    // 一横橙线读起来仍然像个读数。降到弱字阶，和空态里其它的「—」同一档。
    v.parentElement.classList.add('is-blank');
  }
}

function renderTopbar(snap) {
  const down = splitUnit(fmtRate(snap.TotalDownloadBytes || 0));
  const up = splitUnit(fmtRate(snap.TotalUploadBytes || 0));
  els.totalDownValue.textContent = down.value;
  els.totalDownUnit.textContent = down.unit;
  els.totalUpValue.textContent = up.value;
  els.totalUpUnit.textContent = up.unit;
  els.totalDownValue.parentElement.classList.remove('is-blank');
  els.totalUpValue.parentElement.classList.remove('is-blank');
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
  // 近 24 小时列排的是下载 + 上传：一列只有一个数，拆开排会让「按这列排」
  // 的结果和列里看到的数字对不上。
  day24: (p) => (p.Day24Down || 0) + (p.Day24Up || 0),
  // 合计 = 这一秒的下载 + 上传。**没有对应的列**，它是默认顺序的取值器（见
  // DEFAULT_SORT）：一列只有一个数，可「占带宽」是双向的 —— 只按下载排，
  // 上传重下载轻的应用（网盘同步 / 直播推流 / 做种 / 备份）会整个沉底，
  // 而它可能正是这一秒把上行塞满的那个。迷你窗 Top5、历史屏应用排行、
  // 采集端快照顺序三处都已经是合计口径，这一处跟上，四处对齐。
  total: (p) => (p.DownloadBytes || 0) + (p.UploadBytes || 0),
};

/**
 * 默认顺序：未排序时表格的呈现顺序 —— **合计从高到低**，也就是「谁在占带宽」的答案。
 * 取消排序（点列头第三次，或点「恢复默认排序」）回到的就是它。
 * 单独拎出来是因为它同时被三处用到：排序取值、状态机落点、取消按钮的文案。
 */
const DEFAULT_SORT = { key: 'total', dir: -1 };

const SORT_HINT = '点击列头排序：先按这列的首选方向 → 再点反向 → 第三次取消排序（回到默认的合计从高到低）';

/**
 * 表头点击的排序状态机，三态循环：
 *   未排序 --点某列--> 该列首选方向 --再点--> 反向 --第三次点--> 回未排序
 * 首选方向由列的性质定：六列里只有「应用」是文本（A→Z，升序），其余都是量（多→少，降序）。
 *
 * 为什么第三下是「取消」而不是继续翻方向：两态循环没有出口 —— 用户点完列头就再也回不到
 * 默认呈现，只能自己记住默认是按下载降序。这就是这个函数存在的全部理由。
 *
 * 默认顺序是「合计降序」（见 DEFAULT_SORT），而合计没有对应的列头 —— 于是点
 * 任何一列的第一下都会真的重排，包括「下载」列（按下载降序，上传重的应用往下挪）。
 * 这不是死点击，也不是特例：用户点下载列就是要按下载看。第三下取消回默认态。
 */
function nextSortState(key, currentKey, currentDir) {
  const pref = key === 'name' ? 1 : -1;
  if (currentKey !== key) return { key, dir: pref };
  if (currentDir === pref) return { key, dir: -pref };
  return { key: '', dir: DEFAULT_SORT.dir };
}

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

  // 近 24 小时合计贴到每一行上：列渲染和「按这列排序」都要用，所以必须在排序之前算。
  // 表里查不到的行留 0，靠 Day24Known 区分「记录了零」和「没记录」（见 day24Cell）。
  for (const p of procs) {
    const hit = day24Of(day24Tables, p, viewMode);
    p.Day24Down = hit ? hit.down : 0;
    p.Day24Up = hit ? hit.up : 0;
    p.Day24Known = !!hit;
  }

  // sortKey 为空代表未排序：此时用默认顺序，而不是「不排」—— 快照里的顺序是采集端给的，
  // 原样端上来会让默认视图每秒跟着采集顺序抖一次。
  const effKey = sortKey || DEFAULT_SORT.key;
  const effDir = sortKey ? sortDir : DEFAULT_SORT.dir;
  const get = sortAccessors[effKey];
  procs.sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (av < bv) return -effDir;
    if (av > bv) return effDir;
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
    <td data-copy-label="应用名"><span class="cell-name">
      <img class="proc-icon" alt="" hidden /><span class="proc-icon is-placeholder"></span>
      <span class="row-name"></span><span class="count-suffix"></span>
    </span></td>
    <td class="td-peer" data-copy-label="对端地址"></td>
    <td class="is-num td-pid"></td>
    <td class="is-num td-rate down"></td>
    <td class="is-num td-rate up"></td>
    <td class="is-num td-day"></td>`;
  tr.refs = {
    img: tr.querySelector('img.proc-icon'),
    ph: tr.querySelector('.proc-icon.is-placeholder'),
    name: tr.querySelector('.row-name'),
    suffix: tr.querySelector('.count-suffix'),
    peer: tr.querySelector('.td-peer'),
    nameCell: tr.children[0],
    pid: tr.children[2],
    down: tr.children[3],
    up: tr.children[4],
    day: tr.children[5],
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
    // 清掉上一帧的复制值：行是按 key 复用的，对端从「有」变「无」时残留的 data-copy
    // 会让右键菜单复制出一个几秒前就已经断开的 IP。
    cell.dataset.copy = '';
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
  // 复制走完整形态（IP:端口（服务名）），而不是格子里那份省略过的文本 ——
  // 格子是给眼睛看的，剪贴板是给下一站（浏览器 / 终端 / 工单）用的。
  if (cell.dataset.copy !== parts.detail) cell.dataset.copy = parts.detail;
  cell.classList.add('has-peer');
}

/**
 * 整行占比条的读数（§49）。
 *
 * 口径是这一秒的**合计流量**（下载 + 上传），不是只看下载。只看下载会让上传重的
 * 应用那一行的条几乎空着 —— 而且用户手动点「上传」列头把它排到第一，条还是空的：
 * 排序改的是「位置」，条说的是「重量」，后者给了一个错的答案。默认排序键、迷你窗
 * Top5、历史屏应用排行、采集端快照顺序四处都是合计口径，这条是第五处。
 *
 * `dir` 是该行的主方向，条色跟着它走：条的长短说「有多少」，条的颜色说「往哪边」。
 * 下载重的行戴下载色、上传重的行戴上传色 —— 于是「条满格 + 条是上传色」一眼就是
 * 「这台机器正在拼命往上发」。
 *
 * `peak` 是**当前可见集合**里的合计峰值（最大的一行正好满格）。传 0（整表无流量）
 * 时返回 0，条看不见 —— 与「有流量但很小」区分不开，但这一秒本来也就没什么可说。
 */
function shareOf(p, peak) {
  const dn = p.DownloadBytes || 0;
  const up = p.UploadBytes || 0;
  const pct = peak > 0 ? Math.min(100, Math.round(((dn + up) / peak) * 100)) : 0;
  return { pct, dir: dn >= up ? 'down' : 'up' };
}

function updateRow(tr, p, peakTotal) {
  const r = tr.refs;
  const name = p.Name || '(系统/未归因)';
  const icon = iconOf(p);
  if (icon) {
    if (r.img.getAttribute('src') !== icon) r.img.src = icon;
    r.img.hidden = false;
    r.ph.hidden = true;
    // hidden 只挡渲染，不挡 textContent —— 图标是后到的（首帧没有图标，下一帧才有），
    // 留着上一帧写的首字母，右键「复制应用」与整行 TSV 就会把这个看不见的字母
    // 一起带上（"V verge-mihomo"）。凡是按 textContent 取值的地方都躲不过。
    r.ph.textContent = '';
  } else {
    r.img.hidden = true;
    r.ph.hidden = false;
    r.ph.textContent = initialOf(name, 1);
  }
  if (r.name.textContent !== name) r.name.textContent = name;
  r.suffix.textContent = viewMode === 'app' ? `×${p.Pid}` : '';
  // 应用列自己声明复制值：格子里除了名字还有首字母徽标（取不到图标时显示）与聚合计数，
  // 按 textContent 取会把它们一起带走（"V verge-mihomo" / "msedge×3"）——
  // 徽标是图标的替身、计数是编码，都不是名字的一部分。与对端列同一条规矩：
  // 单元格声明了 data-copy 就用它，没声明才退回显示文本。
  if (r.nameCell.dataset.copy !== name) r.nameCell.dataset.copy = name;
  updatePeerCell(r.peer, p);
  r.pid.textContent = viewMode === 'app' ? `${p.Pid} 个进程` : p.Pid;
  setRateCell(r.down, fmtRate(p.DownloadBytes || 0));
  setRateCell(r.up, fmtRate(p.UploadBytes || 0));

  // 近 24 小时（历史库）：与右边两列不同，这是「累计量」不是「速率」——
  // 单位里没有 /s，量级也大两三个档，两者靠单位就能分开读。
  const day = day24Cell(p.Day24Known ? { down: p.Day24Down, up: p.Day24Up } : null);
  setRateCell(r.day, day.text);
  r.day.classList.toggle('is-blank', day.blank);
  if (r.day.title !== day.title) r.day.title = day.title;

  // 占比不占列宽：整行背景一条从左起的极淡色渐变（§2.5）。
  // 渐变本身写在 styles.css 的 .proc-table tbody tr 里，这里只喂两个变量：
  // 长度（--share）与颜色（--share-color = 该行的主方向）。原来这里拼的是写死的
  // rgba(240,145,63)，换主题时这条占比条不跟着走；条色也是写死的下载色。
  const sh = shareOf(p, peakTotal);
  const pct = `${sh.pct}%`;
  if (tr.style.getPropertyValue('--share') !== pct) tr.style.setProperty('--share', pct);
  // 颜色只在方向翻了的时候写：1 Hz 刷新下每帧重设一次自定义属性会打断背景的过渡，
  // 而换向本来是这条渐变唯一值得看的变化。
  if (tr.dataset.shareDir !== sh.dir) {
    tr.dataset.shareDir = sh.dir;
    tr.style.setProperty('--share-color', `var(--${sh.dir})`);
  }

  tr.classList.toggle('is-selected', !!selected && selected.keyStr === tr.dataset.key);
}

// 分隔行：实时行与幽灵行之间的一条整宽分组标签。没有 data-key，
// 所以行点击/键盘处理（都靠 closest('tr[data-key]')）天然跳过它。
function buildGhostSep() {
  const tr = document.createElement('tr');
  tr.className = 'row-group-sep';
  tr.tabIndex = -1;
  tr.innerHTML = '<td colspan="6">近 24 小时内活跃、现已退出</td>';
  return tr;
}

/**
 * 幽灵行渲染：复用实时行的 DOM 结构（buildRow），但语义全然不同 ——
 * 它已退出，没有实时速率 / 对端 / 存活 PID。三处显示破折号，只有"近24小时"给真值。
 * is-ghost 类让样式表把整行降到弱字阶；tabIndex=-1 + 点击处理里的 is-ghost 判断
 * 一起把它挡在选中之外（inspector 只认实时字段，选中一行历史量无处可展）。
 */
function updateGhostRow(tr, g) {
  const r = tr.refs;
  const name = g.name || UNATTR;
  // 图标：进程已退出、拿不到 Path，只能按名字查本会话记下的图标（iconByName）。
  const icon = iconByName.get(name.toLowerCase()) || '';
  if (icon) {
    if (r.img.getAttribute('src') !== icon) r.img.src = icon;
    r.img.hidden = false;
    r.ph.hidden = true;
    r.ph.textContent = '';
  } else {
    r.img.hidden = true;
    r.ph.hidden = false;
    r.ph.textContent = initialOf(name, 1);
  }
  if (r.name.textContent !== name) r.name.textContent = name;
  r.suffix.textContent = '';
  if (r.nameCell.dataset.copy !== name) r.nameCell.dataset.copy = name;
  // 已退出：无实时对端 / PID / 速率，一律破折号（口径同顶栏断连，见 blankRates）。
  updatePeerCell(r.peer, {});
  r.pid.textContent = '—';
  setRateCell(r.down, '—');
  r.down.classList.add('is-blank');
  setRateCell(r.up, '—');
  r.up.classList.add('is-blank');
  const day = day24Cell({ down: g.down || 0, up: g.up || 0 });
  setRateCell(r.day, day.text);
  r.day.classList.toggle('is-blank', day.blank);
  if (r.day.title !== day.title) r.day.title = day.title;
  // 幽灵行没有实时占比，条清零。
  if (tr.style.getPropertyValue('--share') !== '0%') tr.style.setProperty('--share', '0%');
  tr.tabIndex = -1;
  tr.classList.add('is-ghost');
  tr.classList.remove('is-selected');
}

// renderTable 上一轮的幽灵行数量：renderAll 判空态要用它 —— 实时行为空但仍有
// 幽灵行时不能落到「无网络活动」的空态（那会连表格一起藏掉，幽灵行也就看不见了）。
let lastGhostCount = 0;

function renderTable(snap) {
  const procs = visibleProcesses(snap);
  // 占比条的分母是**合计**峰值（见 shareOf）—— 与条的分子同源，也与默认排序
  // 的取值器同源：满格的那一行就是排在第一位的那一行。
  const peakTotal = procs.reduce(
    (m, p) => Math.max(m, (p.DownloadBytes || 0) + (p.UploadBytes || 0)), 0);

  // 幽灵行：近 24 小时活跃、现已退出的实例（见 ghostProcesses）。covered 用**全部**
  // 实时进程（未经搜索过滤）算，免得被搜索藏起来的实时行反被当成已退出；结果再单独
  // 过一遍同一套搜索。
  let ghosts = ghostProcesses(day24Tables, snap.Processes || [], viewMode);
  const q = parseQuery(query);
  if (q) ghosts = ghosts.filter((g) => matchesQuery({ Name: g.name, Pid: '' }, q));
  if (ghosts.length) {
    const effKey = sortKey || DEFAULT_SORT.key;
    const effDir = sortKey ? sortDir : DEFAULT_SORT.dir;
    ghosts = capGhosts(ghosts, effKey, effDir);
  }
  lastGhostCount = ghosts.length;

  // 渲染顺序：实时行 → 分隔行 → 幽灵行。同一条 insertBefore 复用逻辑串起三段。
  const seq = procs.map((p) => ({ kind: 'live', p }));
  if (ghosts.length) {
    seq.push({ kind: 'sep' });
    for (const g of ghosts) seq.push({ kind: 'ghost', g });
  }

  const alive = new Set();
  seq.forEach((item, i) => {
    let key;
    let tr;
    if (item.kind === 'sep') {
      key = '__ghostsep__';
      tr = rowNodes.get(key);
      if (!tr) { tr = buildGhostSep(); rowNodes.set(key, tr); }
    } else if (item.kind === 'ghost') {
      key = `ghost:${viewMode}:${item.g.key}`;
      tr = rowNodes.get(key);
      if (!tr) { tr = buildRow(key); rowNodes.set(key, tr); }
      updateGhostRow(tr, item.g);
    } else {
      key = rowKey(item.p);
      tr = rowNodes.get(key);
      if (!tr) { tr = buildRow(key); rowNodes.set(key, tr); }
      tr.procData = item.p;
      updateRow(tr, item.p, peakTotal);
    }
    alive.add(key);
    // 排序变化时顺序会整体重排；只在位置不对时才动 DOM
    if (els.rows.children[i] !== tr) els.rows.insertBefore(tr, els.rows.children[i] || null);
  });

  for (const [key, tr] of rowNodes) {
    if (!alive.has(key)) { tr.remove(); rowNodes.delete(key); }
  }

  els.pidLabel.textContent = viewMode === 'app' ? '进程数' : 'PID';
  return procs;
}

/** 把排序状态刷到界面上：当前列的箭头 + 读屏用的 aria-sort + 取消按钮的显隐。
 *  单一出口 —— 状态机的每个分支都只调它，免得三处显示各自漂移。
 *  sortKey 为空（未排序）时没有任何一列匹配，箭头和 is-sorted 自然全灭。 */
function renderSortMarks() {
  const icon = window.NetPeekCommon.icon;
  for (const th of document.querySelectorAll('.proc-table th[data-sort]')) {
    const on = th.dataset.sort === sortKey;
    th.classList.toggle('is-sorted', on);
    th.querySelector('.sort-mark').innerHTML = on ? icon(sortDir === -1 ? 'caret-down' : 'caret-up') : '';
    // 读屏用户靠 aria-sort 知道当前按哪列、什么方向排序，光标图形它读不到
    th.setAttribute('aria-sort', on ? (sortDir === -1 ? 'descending' : 'ascending') : 'none');
  }
  // 「恢复默认排序」按钮只在排序生效时露面。它是排序状态在表外的唯一线索，
  // 也是唯一一个不靠「再点一次当前列」就能取消排序的入口（见 §36）。
  els.sortReset.hidden = !sortKey;
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
    title: '当前没有检测到网络活动', desc: '有进程收发数据时即刻显示。',
    retry: false, skeleton: false,
  },
  empty: {
    title: '没有匹配的进程', desc: '可更换关键词，或清空搜索框查看全部。', retry: false, skeleton: false,
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
let inspKey = 'o'; // 详情卡动画的 key：'o' = 总览，否则是选中行的 rowKey
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

  // 选中对象变了（换行 / 切回总览）才让详情卡重播 180ms 入场 —— 本函数每秒
  // 跑一次，靠 key 去重，逐帧刷新的重绘不会反复演。
  const key = sel ? `d:${rowKey(sel)}` : 'o';
  if (key !== inspKey) {
    inspKey = key;
    const card = els.detailCard;
    if (card) {
      card.classList.remove('is-enter');
      void card.offsetWidth; // 强制重排，让同名动画能重放
      card.classList.add('is-enter');
    }
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

// 归因覆盖率：用「接口计数 − 进程合计」算，而不是从进程列表内部数名字。
//
// 2026-09-21 改（原实现在进程列表里统计名字非空的占比）。那个口径有个根本问题：
// 它只能看到**已经在列表里**的进程，而真正没归因上的那部分（受保护进程、
// 短命连接、协议头、回环）压根不会进列表 —— 于是它永远显示接近 100%，
// 恒定的好看，恒定的没信息量。§9 要的是「接口总量与归因总量的差额」，
// 那就必须拿一条不经过归因的量尺来比，即采集端下发的 Unattributed* 字段。
//
// 口径与 §9 一致：差额单独显示，**不按比例摊回各应用**。
// 「归因说明」不另设入口，点这一行展开（§2.4）。
let histStats = null;

/**
 * 覆盖率单元格的文案（纯函数，便于单测）。
 *
 * 三种出口必须分清，它们看着都是「0」但含义完全不同：
 * · known=false → 破折号。没拿到接口计数，那个 0 是**没测到**；
 * · 总量为 0    → 「暂无流量」。接口和进程都没动，是真的没流量；
 * · 其余        → 百分比。差额按 §9 如实呈现，不摊回各应用。
 *
 * 写错第一条是最危险的：把「没测到」显示成「100% 已归因」，
 * 等于报了一个好看但与事实相反的读数。
 */
function coverageCell(snap) {
  const known = snap.UnattributedKnown !== false;
  const un = (snap.UnattributedDownloadBytes || 0) + (snap.UnattributedUploadBytes || 0);
  const attributed = (snap.TotalDownloadBytes || 0) + (snap.TotalUploadBytes || 0);
  const grand = attributed + un;

  if (!known) {
    return { text: '—', title: '本帧未能读到网卡接口计数，覆盖率暂不可用' };
  }
  if (grand <= 0) {
    return { text: '暂无流量', title: '' };
  }
  return {
    text: `${((attributed / grand) * 100).toFixed(1)}% 已归因`,
    title: `已归因 ${fmtBytes(attributed)} · 系统/未归因 ${fmtBytes(un)}（含协议头、回环与本地代理）`,
  };
}

function renderFields(snap) {
  const cov = coverageCell(snap);
  els.fldCoverage.textContent = cov.text;
  els.fldCoverage.title = cov.title;

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
    // 与悬浮读数同一套措辞（悬浮卡里写的是「37 秒前」），
    // 原来是「-60s」——一屏里两种时间写法，而且负号在中文语境里像减法。
    xLabels: [`${WINDOW_SECS} 秒前`, '现在'],
    formatY: C.axisRate,
    tipSuffix: '/s',   // 悬停读数的单位后缀（y 轴走紧凑 formatY，读数走全精度）
  }, extra);
}

// 暂停时曲线尾巴转虚线，从暂停那一刻的下标开始（§2.8）
let pausedIndex = -1;

function drawBandwidth() {
  if (!els.bandwidthChart) return;
  if (!lastSnapshot) {
    C.line(els.bandwidthChart, chartOpts({ axesOnly: true }));
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
    C.line(els.inspLiveChart, chartOpts({ axesOnly: true }));
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
  // 实时行为空、但有幽灵行时不落空态：空态会连表格一起藏掉，幽灵行也就看不见了。
  else if (procs.length === 0 && lastGhostCount === 0) setProcState(parseQuery(query) ? 'empty' : 'idle');
  else setProcState(null);

  renderInspector(snap, procs);
  drawBandwidth();
  syncTableScrollEdges();
}

// 表格的两个滚动装饰态（表头投影 / 底部渐隐，样式在 styles.css）：
// 行数随进程数每秒变，滚动高度也跟着变，所以不能只在 scroll 事件里更新 ——
// 每帧渲染完也刷一次。读 scrollHeight 会强制布局，但一帧只此一次，
// 且 renderTable 本来就已经在写 DOM 了。
function syncTableScrollEdges() {
  const el = els.tableWrap;
  if (!el || el.hidden) return;
  const max = el.scrollHeight - el.clientHeight;
  el.classList.toggle('is-scrollable', max > 1);
  el.classList.toggle('is-scrolled', max > 1 && el.scrollTop > 1);
  el.classList.toggle('is-end', max > 1 && el.scrollTop >= max - 1);
}

function onSnapshot(snap) {
  lastSnapshot = snap;
  mergeIcons(snap);
  rememberIcons(snap);
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
  blankRates();
  C.line(els.bandwidthChart, chartOpts({ axesOnly: true }));
  if (window.NetPeekSettingsUI) window.NetPeekSettingsUI.updateServiceOffline();
}

// ===== 屏切换 =====
// 主区三屏互斥显示；rail 的选中态跟过去。视图切换和搜索在表格卡头里，
// 随 live 屏整体显隐，不需要单独处理。

function setScreen(next, opts) {
  // opts 是给目标屏的「进去之后做什么」，比如从今日卡跳过去要落到今天。
  // 已经在这一屏、又没带这种要求时直接返回：切屏会让历史屏重拉一次库。
  if (next === screen && !opts) return;
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
  if (next === 'history' && window.NetPeekHistoryUI) window.NetPeekHistoryUI.onEnter(opts);
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

/** 当前是否有非折叠的文本选区。
 *  表格里的对端 / 应用名是可选中的（§35 让 IP 这类值能复制出去），而在可选文本上
 *  拖选一次，mouseup 会补一个 click —— 那一下不该顺手把行的选中态也翻过来。
 *  单击时选区是折叠的（mousedown 会先收起旧选区），所以正常点选不受影响。 */
function hasTextSelection() {
  const sel = document.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().trim() !== '';
}

function bindTable() {
  // 表头投影 / 底部渐隐跟着滚动位置翻转。每帧渲染后也会再刷一次
  // （行数在变，滚动高度跟着变，只靠 scroll 事件会停在上一帧的判断上）。
  els.tableWrap.addEventListener('scroll', syncTableScrollEdges, { passive: true });

  for (const th of document.querySelectorAll('.proc-table th[data-sort]')) {
    th.tabIndex = 0;
    // 循环说明写进列头的悬浮提示：改三态之后「怎么取消排序」在这块区域没有任何静态线索，
    // 而点之前一定会先悬浮一下。已有 title 的列（近 24 小时写着口径）追加而不是覆盖。
    th.title = th.title ? `${th.title}；${SORT_HINT}` : SORT_HINT;
    const toggle = () => {
      const next = nextSortState(th.dataset.sort, sortKey, sortDir);
      sortKey = next.key;
      sortDir = next.dir;
      renderSortMarks();
      if (lastSnapshot) renderAll(lastSnapshot);
    };
    th.addEventListener('click', toggle);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }

  // 表外的取消入口。隐藏时不必先判：默认态下它是 hidden，点不到。
  els.sortReset.addEventListener('click', () => {
    sortKey = '';
    sortDir = DEFAULT_SORT.dir;
    renderSortMarks();
    if (lastSnapshot) renderAll(lastSnapshot);
  });

  // 选中同一行再点一次就取消，回到总览态
  els.rows.addEventListener('click', (e) => {
    // 在可选中的单元格文本上拖选，mouseup 会补一个 click —— 那一下不该翻动行选中
    if (hasTextSelection()) return;
    const tr = e.target.closest('tr[data-key]');
    // 幽灵行（已退出）不可选中：inspector 只认实时字段，选中它无从展开
    if (!tr || tr.classList.contains('is-ghost')) return;
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
  // 点它就该去历史屏，而不是让用户自己去导航岛找图标（button 原生响应 Enter/Space）。
  // 并且要落到**今天那一格**：这个入口的全部语义就是「看今天的账」，
  // 只切屏的话人还得在 30 根柱子里自己找哪根是今天。
  $('todayBtn').addEventListener('click', () => setScreen('history', { focusToday: true }));

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
  iconForName: (name) => iconByName.get(String(name || '').toLowerCase()) || '',
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
    // 反向握手：两个监听都挂上了，才允许 Rust 侧去连管道。采集端连上就推首帧，
    // 而首帧是唯一带全量图标的一帧，发在监听登记之前就永远丢了（事件不缓冲，
    // iconCache 也没有补发机制）。不 await：信号是通知不是请求，失败不该拖住启动链。
    try { window.__TAURI__.core.invoke('frontend_ready').catch(() => {}); } catch { /* 忽略 */ }
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
  // 近 24 小时列表：先取一次（首帧就该有数），之后每分钟翻转后自刷
  await loadDay24();
  scheduleDay24();

  drawBandwidth();
  render30Day(null, true);

  // 放在所有 init 之后：theme-ui / settings-ui / history-ui 的 $() 是在各自
  // init 里跑的，早报会把它们还没查的节点算成「不缺」。
  window.NetPeekCommon.reportMissingIds();

  // 启动动效收尾：这里才允许揭幕。
  // 位置很关键 —— 必须在上面每一行之后。早报（比如放在 loadDay24 之前）会让
  // 用户看到「今天的数还没到、近 24 小时列表是空的」那种界面，
  // 而这正是启动层本来的职责：把没就绪的样子挡住。
  // 注意第一帧快照不在这一串里（它由管道异步推来），所以揭幕时可能仍是「未连接」——
  // 那是真实状态，界面自己有对应的提示，不该为了好看再压住。
  if (window.NetPeekBoot) window.NetPeekBoot.ready();
}

boot();
