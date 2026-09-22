// renderTable 把幽灵行接进表格的集成测试：实时行 → 分隔行 → 幽灵行的顺序、
// 行的建立/复用、以及"实时为空但有幽灵时不落空态"这条空态开关。
//
// 与 ghost.test.mjs 的分工：那个测纯数据（捞取/排序/折叠），这个测 renderTable
// 把它们摆进 DOM 的接线 —— 分隔行有没有建、幽灵行在不在实时行之后、复用键对不对。

import { makeWith, loadScripts, eq, ok, section, report } from './_harness.mjs';

const ctx = loadScripts(['flags.js', 'services.js', 'common.js']);
const UNATTR = '(系统/未归因)';

const proc = (over) => Object.assign({
  Pid: 1000, Name: 'app.exe', Path: '', StartTimeUnixMs: 1_700_000_000_000,
  DownloadBytes: 0, UploadBytes: 0, DownloadTotal: 0, UploadTotal: 0, RetransmitTotal: 0,
  TopRemoteIp: '', TopRemotePort: 0, TopRemoteCountry: '',
}, over);

// 只读键（sortAccessors 是 const 对象，grabFunction 抓不到，按原样注入）
const src = (await import('node:fs')).readFileSync(
  new URL('../../src/NetPeek.App/ui/main.js', import.meta.url), 'utf8');
const sortAccessors = new Function(`${src.match(/const sortAccessors = \{[\s\S]*?\n\};/)[0]}\nreturn sortAccessors;`)();
const DEFAULT_SORT = { key: 'total', dir: -1 };

function makeRT(state = {}) {
  const built = [];
  const updatedLive = [];
  const updatedGhost = [];
  const rows = {
    children: [],
    insertBefore(node, ref) {
      const at = ref ? this.children.indexOf(ref) : -1;
      this.children.splice(at < 0 ? this.children.length : at, 0, node);
    },
  };
  const mkNode = (extra) => ({
    ...extra,
    remove() { const i = rows.children.indexOf(this); if (i >= 0) rows.children.splice(i, 1); },
  });
  const document = {
    // buildGhostSep 建分隔行：只用到 className / tabIndex / innerHTML
    createElement: () => mkNode({ tagName: 'tr', className: '', tabIndex: 0, innerHTML: '', dataset: {} }),
  };
  const rowNodes = new Map();
  const api = makeWith(
    'main.js',
    [
      'parseQuery', 'searchFields', 'matchesQuery', 'histKey',
      'day24Key', 'buildDay24', 'day24Of', 'ghostProcesses', 'sortGhosts', 'capGhosts',
      'visibleProcesses', 'rowKey', 'buildGhostSep', 'renderTable',
    ],
    {
      window: ctx,
      document,
      sortAccessors,
      DEFAULT_SORT,
      GHOST_LIMIT: 40,
      iconOf: () => '',
      query: '',
      viewMode: 'process',
      sortKey: '',
      sortDir: -1,
      rowNodes,
      day24Tables: { byKey: new Map(), byName: new Map(), ready: false },
      UNATTR,
      els: { rows, pidLabel: { textContent: '' } },
      buildRow: (key) => { built.push(key); return mkNode({ dataset: { key }, refs: {} }); },
      updateRow: (tr) => updatedLive.push(tr.dataset.key),
      updateGhostRow: (tr, g) => { updatedGhost.push(tr.dataset.key); tr.__g = g; },
      ...state,
    },
  );
  return { ...api, built, updatedLive, updatedGhost, rows, rowNodes };
}

// 构建一张 ready 的 day24 表：两个实时身份 + 两个已退出身份。
function tablesWith(buildDay24) {
  return buildDay24([
    { name: 'live-a', pid: 1, startTs: 1700000000, down: 10, up: 1 },
    { name: 'live-b', pid: 2, startTs: 1700000000, down: 20, up: 2 },
    { name: 'dead-x', pid: 91, startTs: 1699000000, down: 900, up: 90 }, // 已退出
    { name: 'dead-y', pid: 92, startTs: 1699000001, down: 500, up: 50 }, // 已退出
  ]);
}

section('renderTable：实时行之后接分隔行 + 幽灵行');
{
  const t = makeRT();
  const tables = tablesWith(t.buildDay24);
  const t2 = makeRT({ day24Tables: tables });
  // 两个实时进程，身份与 live-a / live-b 对上
  t2.renderTable({
    Processes: [
      proc({ Pid: 1, Name: 'live-a', StartTimeUnixMs: 1700000000000, DownloadBytes: 300 }),
      proc({ Pid: 2, Name: 'live-b', StartTimeUnixMs: 1700000000000, DownloadBytes: 100 }),
    ],
  });
  // 顺序：live ×2 → sep → ghost ×2 = 5 个节点
  eq(t2.rows.children.length, 5, '两实时 + 分隔 + 两幽灵 = 5 行');
  eq(t2.updatedLive.length, 2, '两条实时行走 updateRow');
  eq(t2.updatedGhost.length, 2, '两条幽灵行走 updateGhostRow');
  // 第 3 个是分隔行（无 dataset.key），后两个是幽灵行
  const sep = t2.rows.children[2];
  eq(sep.className, 'row-group-sep', '第三行是分组分隔行');
  ok(sep.innerHTML.includes('现已退出'), '分隔行文案');
  eq(sep.tabIndex, -1, '分隔行不可 Tab 聚焦');
  const ghostKeys = t2.rows.children.slice(3).map((n) => n.dataset.key);
  ok(ghostKeys.every((k) => k.startsWith('ghost:process:')), '幽灵行 key 带 ghost 前缀');
  // 幽灵行按历史合计降序：dead-x(990) 在 dead-y(550) 前
  eq(t2.rows.children[3].__g.name, 'dead-x', '幽灵行按历史合计降序');
}

section('renderTable：没有幽灵时不建分隔行');
{
  const t = makeRT();
  const tables = t.buildDay24([
    { name: 'live-a', pid: 1, startTs: 1700000000, down: 10, up: 1 },
  ]);
  const t2 = makeRT({ day24Tables: tables });
  t2.renderTable({
    Processes: [proc({ Pid: 1, Name: 'live-a', StartTimeUnixMs: 1700000000000, DownloadBytes: 5 })],
  });
  eq(t2.rows.children.length, 1, '只有一条实时行，无分隔、无幽灵');
  ok(!t2.rows.children.some((n) => n.className === 'row-group-sep'), '没有分隔行');
}

section('renderTable：实时为空但有幽灵 → 只出幽灵段，不落空态');
{
  const t = makeRT();
  const tables = t.buildDay24([
    { name: 'dead-x', pid: 91, startTs: 1699000000, down: 900, up: 90 },
  ]);
  const t2 = makeRT({ day24Tables: tables });
  t2.renderTable({ Processes: [] });
  // 分隔行 + 一条幽灵行
  eq(t2.rows.children.length, 2, '实时为空时仍渲染分隔 + 幽灵');
  eq(t2.updatedLive.length, 0, '没有实时行');
  eq(t2.updatedGhost.length, 1, '一条幽灵行');
}

process.exit(report('ghost-render.test'));
