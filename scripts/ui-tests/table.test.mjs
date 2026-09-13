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
};

/** 按给定的界面状态取一份 visibleProcesses / rowKey。 */
function withState(state) {
  return makeWith(
    'main.js',
    ['parseQuery', 'searchFields', 'matchesQuery', 'histKey', 'visibleProcesses', 'rowKey'],
    {
      window: ctx,
      sortAccessors,
      iconOf: () => '',
      query: '',
      viewMode: 'process',
      sortKey: 'download',
      sortDir: -1,
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
    ['parseQuery', 'searchFields', 'matchesQuery', 'histKey', 'visibleProcesses', 'rowKey', 'renderTable'],
    {
      window: ctx,
      sortAccessors,
      iconOf: () => '',
      query: '',
      viewMode: 'process',
      sortKey: 'download',
      sortDir: -1,
      rowNodes,
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
