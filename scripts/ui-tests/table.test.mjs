// main.js 进程表单测：可见集合（过滤 / 应用聚合 / 排序）与行节点的增删复用。
//
// 为什么值得测：main.js 1103 行此前零单测，而这三段恰好是最容易出静默回归的地方。
// git 历史里已经踩过同类问题（排行行缺 flex:none 把 8 行压成 18px、聚合键从 pid
// 改成 (pid,start_ts) 之前把两个进程的字节串到一起），共同点是——都不报错，
// 只是数字悄悄变得不对。
//
// 行增删这段尤其要盯：renderTable 靠一个 alive 集合决定删谁。少删了，
// 已经退出的进程会永远挂在表上（读起来像它还在跑）；多删了，正在刷新的行
// 每秒重建一次，悬浮提示会被打断、选中态会掉。两种都只有断言能拦住。

import { makeWith, loadScripts, eq, ok, section, report } from './_harness.mjs';

const ctx = loadScripts(['flags.js', 'services.js', 'common.js']);

// 排序访问器是 const 对象、不是函数，grabFunction 抓不到，按原样注入。
const sortAccessors = {
  name: (p) => (p.Name || '').toLowerCase(),
  pid: (p) => p.Pid,
  download: (p) => p.DownloadBytes || 0,
  upload: (p) => p.UploadBytes || 0,
  day24: (p) => (p.Day24Down || 0) + (p.Day24Up || 0),
};

// 近 24 小时的两张表：默认空。测试要验「附加与排序」时用 day24Table() 造一份真的，
// 让这段走的是 buildDay24 / day24Of 本身，而不是一个替身 —— 替身测不出键格式漂移。
const emptyDay24 = () => ({ byKey: new Map(), byName: new Map(), ready: false });
const UNATTR = '(系统/未归因)';

// 默认顺序也是 const 对象，同样按原样注入（sortKey 为空时的落点）
const DEFAULT_SORT = { key: 'download', dir: -1 };

/** 按给定的界面状态取一份 visibleProcesses / rowKey。 */
function withState(state) {
  return makeWith(
    'main.js',
    [
      'parseQuery', 'searchFields', 'matchesQuery', 'histKey',
      'day24Key', 'buildDay24', 'day24Of', 'visibleProcesses', 'rowKey',
    ],
    {
      window: ctx,
      sortAccessors,
      DEFAULT_SORT,
      iconOf: () => '',
      query: '',
      viewMode: 'process',
      // 与运行时的初值一致：空 sortKey = 未排序（表格走 DEFAULT_SORT 的顺序）
      sortKey: '',
      sortDir: -1,
      day24Tables: emptyDay24(),
      UNATTR,
      ...state,
    },
  );
}

const proc = (over) => Object.assign({
  Pid: 1000,
  Name: 'app.exe',
  Path: 'C:\\app.exe',
  StartTimeUnixMs: 1_700_000_000_000,
  DownloadBytes: 0,
  UploadBytes: 0,
  DownloadTotal: 0,
  UploadTotal: 0,
  RetransmitTotal: 0,
  TopRemoteIp: '',
  TopRemotePort: 0,
  TopRemoteCountry: '',
}, over);

// ---------- 排序 ----------

section('visibleProcesses 排序');
{
  const snap = {
    Processes: [
      proc({ Pid: 1, Name: 'b.exe', DownloadBytes: 100, UploadBytes: 5 }),
      proc({ Pid: 2, Name: 'a.exe', DownloadBytes: 300, UploadBytes: 1 }),
      proc({ Pid: 3, Name: 'c.exe', DownloadBytes: 200, UploadBytes: 9 }),
    ],
  };

  const byDown = withState({ sortKey: 'download', sortDir: -1 }).visibleProcesses(snap);
  eq(byDown.map((p) => p.Pid).join(','), '2,3,1', '按下载降序');

  const byDownAsc = withState({ sortKey: 'download', sortDir: 1 }).visibleProcesses(snap);
  eq(byDownAsc.map((p) => p.Pid).join(','), '1,3,2', 'sortDir=1 翻成升序');

  const byName = withState({ sortKey: 'name', sortDir: 1 }).visibleProcesses(snap);
  eq(byName.map((p) => p.Name).join(','), 'a.exe,b.exe,c.exe', '按名称升序（大小写无关）');

  const byUp = withState({ sortKey: 'upload', sortDir: -1 }).visibleProcesses(snap);
  eq(byUp.map((p) => p.Pid).join(','), '3,1,2', '按上传降序');

  // 原始快照不能被就地排序：lastSnapshot 会被右栏、图表、历史屏共用，
  // 在这里 sort 掉会让别处读到的顺序莫名其妙地跟着表头变。
  eq(snap.Processes.map((p) => p.Pid).join(','), '1,2,3', '不改动入参快照的顺序');
}

section('未排序（sortKey 为空）：走默认顺序，不是采集顺序');
{
  // 默认顺序是「下载从高到低」，和 sortKey='download'/dir=-1 同序 —— 但这两者不是
  // 一回事：空 sortKey 不标箭头、露出「恢复默认排序」的反面（按钮收起来）。
  // 单独测一遍是因为 sortKey='' 会走 sortAccessors[effKey] 这条解析路径，
  // 漏了它就会拿 undefined 当取值器，每秒抛一次异常而页面看着只是「没排序」。
  const snap = {
    Processes: [
      proc({ Pid: 1, Name: 'b.exe', DownloadBytes: 100 }),
      proc({ Pid: 2, Name: 'a.exe', DownloadBytes: 300 }),
      proc({ Pid: 3, Name: 'c.exe', DownloadBytes: 200 }),
    ],
  };
  const off = withState({ sortKey: '' }).visibleProcesses(snap);
  eq(off.map((p) => p.Pid).join(','), '2,3,1', '空 sortKey 按默认（下载降序）排');
  // 采集端给的顺序是 1,2,3，若哪天「未排序」被理解成「原样端上」，这条会先炸
  eq(off.map((p) => p.Pid).join(','), withState({ sortKey: 'download', sortDir: -1 })
    .visibleProcesses(snap).map((p) => p.Pid).join(','), '与显式「按下载降序」同序');
}

section('排序状态机：三态循环，第三次点回默认（§36 修的是没有出口）');
{
  const sm = makeWith('main.js', ['nextSortState'], { DEFAULT_SORT });

  // 数值列：首选降序（多 → 少）
  const u1 = sm.nextSortState('upload', '', -1);
  eq(`${u1.key}/${u1.dir}`, 'upload/-1', '未排序点上传 → 上传降序');
  const u2 = sm.nextSortState('upload', 'upload', -1);
  eq(`${u2.key}/${u2.dir}`, 'upload/1', '再点上传 → 翻成升序');
  const u3 = sm.nextSortState('upload', 'upload', 1);
  eq(u3.key, '', '第三次点上传 → 取消排序（回默认态）');
  eq(u3.dir, -1, '取消后的方向回到默认方向，不是沿用上一列的方向');

  // 文本列：首选升序（A → Z）
  const n1 = sm.nextSortState('name', '', -1);
  eq(`${n1.key}/${n1.dir}`, 'name/1', '未排序点应用 → 应用升序');
  eq(sm.nextSortState('name', 'name', 1).dir, -1, '再点应用 → 翻成降序');
  eq(sm.nextSortState('name', 'name', -1).key, '', '第三次点应用 → 取消排序');

  // 换列：走新列的首选方向，不受上一列方向的影响
  eq(`${sm.nextSortState('pid', 'upload', 1).key}/${sm.nextSortState('pid', 'upload', 1).dir}`,
    'pid/-1', '从上传（升序）切到 PID → PID 降序，不沿用升序');
  eq(`${sm.nextSortState('name', 'pid', -1).key}/${sm.nextSortState('name', 'pid', -1).dir}`,
    'name/1', '从 PID 切到应用 → 应用升序');

  // 下载列特例：默认顺序本来就是下载降序，从默认态点它第一下行序不动，
  // 但状态变成「显式排序」（箭头亮起）。这一下不是死点击，也不是漏洞。
  const d1 = sm.nextSortState('download', '', -1);
  eq(`${d1.key}/${d1.dir}`, 'download/-1', '未排序点下载 → 下载降序（与默认同序，只多出箭头）');
  eq(sm.nextSortState('download', 'download', -1).dir, 1, '再点下载 → 升序');
  eq(sm.nextSortState('download', 'download', 1).key, '', '第三次点下载 → 取消排序');
}

section('visibleProcesses 空与异常输入');
{
  eq(withState({}).visibleProcesses({}).length, 0, '没有 Processes 字段返回空数组');
  eq(withState({}).visibleProcesses({ Processes: [] }).length, 0, '空进程列表返回空数组');
}

// ---------- 过滤 ----------

section('visibleProcesses 过滤');
{
  const snap = {
    Processes: [
      proc({ Pid: 1, Name: 'chrome.exe', DownloadBytes: 10 }),
      proc({ Pid: 2, Name: 'msedge.exe', DownloadBytes: 20 }),
    ],
  };
  eq(withState({ query: 'chrome' }).visibleProcesses(snap).length, 1, '关键词只留匹配行');
  eq(withState({ query: '!chrome' }).visibleProcesses(snap)[0].Name, 'msedge.exe', '! 反向过滤');
  eq(withState({ query: '   ' }).visibleProcesses(snap).length, 2, '纯空白不过滤');
}

// ---------- 应用聚合 ----------

section('visibleProcesses 应用聚合');
{
  const snap = {
    Processes: [
      proc({
        Pid: 10, Name: 'msedge', StartTimeUnixMs: 5000,
        DownloadBytes: 100, UploadBytes: 10, DownloadTotal: 1000, RetransmitTotal: 7,
        TopRemoteIp: '1.1.1.1', TopRemotePort: 443, TopRemoteCountry: 'US',
      }),
      proc({
        Pid: 11, Name: 'msedge', StartTimeUnixMs: 3000,
        DownloadBytes: 400, UploadBytes: 20, DownloadTotal: 2000, RetransmitTotal: 3,
        TopRemoteIp: '2.2.2.2', TopRemotePort: 80, TopRemoteCountry: 'JP',
      }),
      proc({ Pid: 12, Name: 'chrome', DownloadBytes: 50 }),
    ],
  };
  const rows = withState({ viewMode: 'app' }).visibleProcesses(snap);

  eq(rows.length, 2, '同名进程并成一行');
  const edge = rows.find((r) => r.Name === 'msedge');

  eq(edge.DownloadBytes, 500, '瞬时下载相加');
  eq(edge.UploadBytes, 30, '瞬时上传相加');
  eq(edge.DownloadTotal, 3000, '累计下载相加');
  eq(edge.RetransmitTotal, 10, '重传相加');
  eq(edge.Pid, 2, '聚合行的 Pid 字段改用成员个数');
  eq(edge.Members.length, 2, 'Members 记下成员，供 60 秒曲线逐槽相加');
  eq(edge.Members.join(','), '10:5000,11:3000', 'Members 用 pid:startMs，不是裸 pid');

  // 会话时长要取最早启动的成员：取最晚的会让「已运行 3 小时」在开了新标签页
  // （新进程）后突然缩短成几秒。
  eq(edge.StartTimeUnixMs, 3000, '会话时长取最早启动的成员');

  // 对端取流量最大的那个成员，不是最后遍历到的那个
  eq(edge.TopRemoteIp, '2.2.2.2', '对端取流量最大的成员');
  eq(edge.TopRemotePort, 80, '端口跟着同一个成员走');
  eq(edge.TopRemoteCountry, 'JP', '国家码跟着同一个成员走');

  // 空名字归到未归因，而不是留一行空白名
  const unattr = withState({ viewMode: 'app' })
    .visibleProcesses({ Processes: [proc({ Pid: 0, Name: '   ', DownloadBytes: 1 })] });
  eq(unattr[0].Name, '(系统/未归因)', '空名字归入未归因');
}

// ---------- 近 24 小时列 ----------

section('近 24 小时：按进程身份取，取不到标成「不知道」而不是「零」');
{
  const tables = withState({}).buildDay24([
    { name: 'chrome.exe', pid: 7, startTs: 1_700_000_000, down: 900, up: 100 },
  ]);
  const rows = withState({ day24Tables: tables, sortKey: 'name', sortDir: 1 }).visibleProcesses({
    Processes: [
      proc({ Pid: 7, Name: 'chrome.exe', StartTimeUnixMs: 1_700_000_000_000 }),
      proc({ Pid: 8, Name: 'steam.exe', StartTimeUnixMs: 1_700_000_000_000 }),
    ],
  });
  const chrome = rows.find((r) => r.Name === 'chrome.exe');
  eq(chrome.Day24Down, 900, '命中：下载取到');
  eq(chrome.Day24Up, 100, '命中：上传取到');
  eq(chrome.Day24Known, true, '命中标记');

  // 库里没有这个身份时必须是「没记录」，不能悄悄变成「用了 0 字节」——
  // 两者在界面上长得一样，只有前者该显示破折号。
  const steam = rows.find((r) => r.Name === 'steam.exe');
  eq(steam.Day24Known, false, '没记录的进程标成不知道');
  eq(steam.Day24Down, 0, '数值兜底 0');
}

section('近 24 小时：应用视图按名字把多个实例相加');
{
  // 库里按进程实例存（(pid,start_ts) 各一行），应用视图那一行要的是名字的合计。
  const tables = withState({}).buildDay24([
    { name: 'msedge', pid: 10, startTs: 5, down: 100, up: 10 },
    { name: 'msedge', pid: 11, startTs: 3, down: 400, up: 20 },
    { name: 'chrome', pid: 12, startTs: 1, down: 50, up: 5 },
  ]);
  const rows = withState({ viewMode: 'app', day24Tables: tables, sortKey: 'name', sortDir: 1 })
    .visibleProcesses({
      Processes: [
        proc({ Pid: 10, Name: 'msedge', StartTimeUnixMs: 5000 }),
        proc({ Pid: 11, Name: 'msedge', StartTimeUnixMs: 3000 }),
        proc({ Pid: 12, Name: 'chrome', StartTimeUnixMs: 1000 }),
      ],
    });
  eq(rows.find((r) => r.Name === 'msedge').Day24Down, 500, '两个 msedge 实例的下载相加');
  eq(rows.find((r) => r.Name === 'msedge').Day24Up, 30, '上传相加');
  eq(rows.find((r) => r.Name === 'chrome').Day24Down, 50, '另一应用不受影响');
}

section('近 24 小时：排序按「下载 + 上传」，与列里显示的数一致');
{
  // 一列只有一个数，排序就必须按那一个数来。按下载排会出现「这列看着更大却排在下面」，
  // 用户没法判断是排序错了还是自己看错了。
  const tables = withState({}).buildDay24([
    { name: 'a.exe', pid: 1, startTs: 0, down: 10, up: 10 },  // 合计 20
    { name: 'b.exe', pid: 2, startTs: 0, down: 100, up: 1 },  // 合计 101
    { name: 'c.exe', pid: 3, startTs: 0, down: 1, up: 100 },  // 合计 101（下行最小）
  ]);
  const snap = {
    Processes: [
      proc({ Pid: 1, Name: 'a.exe', StartTimeUnixMs: 0 }),
      proc({ Pid: 2, Name: 'b.exe', StartTimeUnixMs: 0 }),
      proc({ Pid: 3, Name: 'c.exe', StartTimeUnixMs: 0 }),
    ],
  };
  const desc = withState({ day24Tables: tables, sortKey: 'day24', sortDir: -1 })
    .visibleProcesses(snap);
  eq(desc[0].Name !== 'a.exe', true, '合计最小的不排第一');
  eq(desc[2].Name, 'a.exe', '合计 20 的排在最后（不是按下载 1 排后）');
}

section('rowKey 随视图切换');
{
  const p = proc({ Pid: 42, Name: 'MsEdge', StartTimeUnixMs: 999 });
  eq(withState({ viewMode: 'process' }).rowKey(p), 'pid:42:999', '进程视图用 pid:startMs');
  eq(withState({ viewMode: 'app' }).rowKey(p), 'app:msedge', '应用视图用小写名字');

  // PID 会被系统复用。只按 PID 做 key，新进程会接上一个进程的行（和它的曲线）。
  const reused = proc({ Pid: 42, Name: 'other', StartTimeUnixMs: 1234 });
  ok(withState({ viewMode: 'process' }).rowKey(p) !== withState({ viewMode: 'process' }).rowKey(reused),
    'PID 复用时 key 必须不同');
}

// ---------- 行增删复用 ----------

// renderTable 的 DOM 部分用一份最小替身：只要 children 数组 + insertBefore + remove。
// buildRow / updateRow 作为形参注入，这样测的是 renderTable 自己的增删判断，
// 不牵进真实 DOM（那需要 querySelector / innerHTML 解析，harness 里没有）。
function makeRenderTable(state) {
  const built = [];
  const updated = [];
  const rowNodes = new Map();
  const rows = {
    children: [],
    insertBefore(node, ref) {
      const cur = this.children.indexOf(node);
      if (cur >= 0) this.children.splice(cur, 1);
      const at = ref ? this.children.indexOf(ref) : this.children.length;
      this.children.splice(at < 0 ? this.children.length : at, 0, node);
      node._parent = this;
    },
  };
  const pidLabel = { textContent: '' };

  const api = makeWith(
    'main.js',
    [
      'parseQuery', 'searchFields', 'matchesQuery', 'histKey',
      'day24Key', 'buildDay24', 'day24Of', 'visibleProcesses', 'rowKey', 'renderTable',
    ],
    {
      window: ctx,
      sortAccessors,
      iconOf: () => '',
      query: '',
      viewMode: 'process',
      sortKey: 'download',
      sortDir: -1,
      rowNodes,
      day24Tables: emptyDay24(),
      UNATTR,
      els: { rows, pidLabel },
      buildRow: (key) => {
        built.push(key);
        return {
          dataset: { key },
          refs: {},
          _parent: null,
          remove() { const i = rows.children.indexOf(this); if (i >= 0) rows.children.splice(i, 1); },
        };
      },
      updateRow: (tr, p) => { updated.push(tr.dataset.key); },
      ...state,
    },
  );
  return { ...api, built, updated, rowNodes, rows, pidLabel };
}

section('renderTable 首帧建行');
{
  const t = makeRenderTable();
  t.renderTable({
    Processes: [
      proc({ Pid: 1, Name: 'a', DownloadBytes: 300 }),
      proc({ Pid: 2, Name: 'b', DownloadBytes: 100 }),
    ],
  });
  eq(t.built.length, 2, '两个进程建两行');
  eq(t.rowNodes.size, 2, 'rowNodes 记住两行');
  eq(t.rows.children.length, 2, '两行都挂进了 tbody');
  eq(t.rows.children.map((n) => n.dataset.key).join(','), 'pid:1:1700000000000,pid:2:1700000000000',
    '挂载顺序等于排序结果');
}

section('renderTable 第二帧复用同一批节点');
{
  const t = makeRenderTable();
  const snap = {
    Processes: [
      proc({ Pid: 1, Name: 'a', DownloadBytes: 300 }),
      proc({ Pid: 2, Name: 'b', DownloadBytes: 100 }),
    ],
  };
  t.renderTable(snap);
  const first = t.rows.children.slice();
  t.built.length = 0;

  t.renderTable(snap);
  eq(t.built.length, 0, '第二帧不新建任何行');
  eq(t.rows.children[0] === first[0], true, '第一行是同一个节点');
  eq(t.rows.children[1] === first[1], true, '第二行是同一个节点');
  eq(t.updated.length, 4, '两帧共四次 updateRow —— 数据靠就地改，不靠重建');
}

section('renderTable 进程退出后删行');
{
  const t = makeRenderTable();
  t.renderTable({
    Processes: [
      proc({ Pid: 1, Name: 'a', DownloadBytes: 300 }),
      proc({ Pid: 2, Name: 'b', DownloadBytes: 100 }),
    ],
  });
  // 第二帧只剩一个进程
  t.renderTable({ Processes: [proc({ Pid: 1, Name: 'a', DownloadBytes: 300 })] });

  eq(t.rowNodes.size, 1, '退出的进程从 rowNodes 移除');
  eq(t.rows.children.length, 1, '退出的行从 tbody 摘掉');
  eq(t.rows.children[0].dataset.key, 'pid:1:1700000000000', '留下的是仍在跑的那个');
}

section('renderTable 排序变化时就地重排，不重建');
{
  const t = makeRenderTable();
  const snap = {
    Processes: [
      proc({ Pid: 1, Name: 'a', DownloadBytes: 100 }),
      proc({ Pid: 2, Name: 'b', DownloadBytes: 300 }),
    ],
  };
  t.renderTable(snap);
  eq(t.rows.children.map((n) => n.dataset.key.split(':')[1]).join(','), '2,1', '按下载降序：2 在前');

  // 换成升序：同一批节点，顺序应当反过来
  const nodes = new Map(t.rowNodes);
  const t2 = makeRenderTable({ sortDir: 1 });
  t2.renderTable(snap);
  eq(t2.rows.children.map((n) => n.dataset.key.split(':')[1]).join(','), '1,2', '升序：1 在前');
  ok(nodes.size === 2, '前一次的节点表仍完整（重排不牵动节点身份）');
}

section('renderTable 过滤清空后行全删');
{
  const t = makeRenderTable();
  t.renderTable({ Processes: [proc({ Pid: 1, Name: 'a', DownloadBytes: 1 })] });
  eq(t.rows.children.length, 1, '先有一行');

  const t2 = makeRenderTable({ query: 'nomatch' });
  t2.renderTable({ Processes: [proc({ Pid: 1, Name: 'a', DownloadBytes: 1 })] });
  eq(t2.rows.children.length, 0, '搜索无结果时不留残行');
}

section('renderTable 同步 PID 列表头');
{
  const t = makeRenderTable({ viewMode: 'process' });
  t.renderTable({ Processes: [proc({ Pid: 1, DownloadBytes: 1 })] });
  eq(t.pidLabel.textContent, 'PID', '进程视图表头是 PID');

  const t2 = makeRenderTable({ viewMode: 'app' });
  t2.renderTable({ Processes: [proc({ Pid: 1, DownloadBytes: 1 })] });
  eq(t2.pidLabel.textContent, '进程数', '应用视图表头是进程数');
}

process.exit(report('table.test'));
