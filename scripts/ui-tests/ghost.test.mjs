// 幽灵行的单测：把"近 24 小时活跃、现已退出"的进程从历史表里捞出来、排序、截断。
//
// 为什么值得测：这段是"让近24小时列加起来对得上真实用量"的核心。三处一旦错：
// - covered 漏掉某个实时身份 → 那个进程会既显示在实时行、又冒出一条幽灵行，翻倍；
// - covered 多算 → 已退出进程被误当在跑，那几个 G 又消失了；
// - 折叠尾的合计算错 → 整列求和不再等于库内真实总量，而这正是功能承诺的那件事。
// 都不会报错，只会让总量安静地对不上。

import { makeWith, loadScripts, eq, ok, section, report } from './_harness.mjs';

loadScripts(['flags.js', 'services.js', 'common.js']);
const UNATTR = '(系统/未归因)';

function api(limit = 40) {
  return makeWith(
    'main.js',
    ['day24Key', 'buildDay24', 'ghostProcesses', 'sortGhosts', 'capGhosts'],
    { UNATTR, GHOST_LIMIT: limit },
  );
}

const proc = (over) => Object.assign({ Pid: 1, Name: 'a.exe', StartTimeUnixMs: 0 }, over);

// ---------- ghostProcesses：捞出未被实时行认领的历史条目 ----------

section('ghostProcesses：进程视图取实时行没认领的实例');
{
  const { buildDay24, ghostProcesses } = api();
  const t = buildDay24([
    { name: 'live.exe', pid: 10, startTs: 5, down: 100, up: 10 },
    { name: 'dead.exe', pid: 11, startTs: 6, down: 900, up: 90 },
  ]);
  // 只有 pid=10 还在跑（启动时刻 5000ms → 5s，与库里的 startTs=5 对上）
  const live = [proc({ Pid: 10, Name: 'live.exe', StartTimeUnixMs: 5000 })];
  const g = ghostProcesses(t, live, 'process');
  eq(g.length, 1, '在跑的不算幽灵，只剩已退出的一条');
  eq(g[0].key, '11:6', '幽灵行带历史身份键');
  eq(g[0].name, 'dead.exe', '幽灵行带历史名');
  eq(g[0].down + g[0].up, 990, '幽灵行带历史合计');
}

section('ghostProcesses：实时行缺启动时间时认领 pid:0 老行，不再当幽灵');
{
  const { buildDay24, ghostProcesses } = api();
  const t = buildDay24([
    { name: 'orphan', pid: 20, startTs: 0, down: 500, up: 5 }, // 老行：start_ts=0
    { name: 'other', pid: 21, startTs: 7, down: 30, up: 0 },
  ]);
  // 实时行 pid=20 也没有启动时间 → 它按 pid:0 认领了那条老行，故不该再冒幽灵行
  const live = [proc({ Pid: 20, Name: 'orphan', StartTimeUnixMs: 0 })];
  const g = ghostProcesses(t, live, 'process');
  eq(g.length, 1, 'pid:0 老行被实时行认领，不重复；只剩另一条');
  eq(g[0].key, '21:7', '剩下的是没被认领的那条');
}

section('ghostProcesses：应用视图只补完全退出的应用');
{
  const { buildDay24, ghostProcesses } = api();
  const t = buildDay24([
    { name: 'chrome', pid: 1, startTs: 1, down: 100, up: 0 },
    { name: 'chrome', pid: 2, startTs: 2, down: 200, up: 0 }, // 同应用多实例
    { name: 'gone', pid: 3, startTs: 3, down: 40, up: 4 },
  ]);
  // chrome 还有一个实例在跑 → 它的近24小时经 byName 已含全部实例，不需要幽灵
  const live = [proc({ Pid: 2, Name: 'chrome', StartTimeUnixMs: 2000 })];
  const g = ghostProcesses(t, live, 'app');
  eq(g.length, 1, '有实时实例的应用不补，只剩完全退出的');
  eq(g[0].name, 'gone', '完全退出的应用才成幽灵');
  eq(g[0].down + g[0].up, 44, '按应用名的合计');
}

section('ghostProcesses：表未就绪返回空');
{
  const { ghostProcesses } = api();
  eq(ghostProcesses({ ready: false, byKey: new Map(), byName: new Map() }, [], 'process').length, 0,
    '首帧还没读到库 → 不冒任何幽灵行');
  eq(ghostProcesses(null, [], 'process').length, 0, 'null 也不炸');
}

// ---------- sortGhosts：实时速率恒 0，排序落到历史量 ----------

section('sortGhosts：按当前排序键落到历史量上');
{
  const { sortGhosts } = api();
  const list = [
    { key: 'a', name: 'b-app', down: 100, up: 900 },
    { key: 'c', name: 'a-app', down: 800, up: 50 },
  ];
  eq(sortGhosts(list, 'download', -1)[0].key, 'c', '按下载降序：下载大的在前');
  eq(sortGhosts(list, 'upload', -1)[0].key, 'a', '按上传降序：上传大的在前');
  // a 合计 100+900=1000，c 合计 800+50=850 → 合计降序 a 在前
  eq(sortGhosts(list, 'total', -1)[0].key, 'a', '合计降序：合计大的（a=1000）在前');
  eq(sortGhosts(list, 'name', 1)[0].name, 'a-app', '名字升序：A→Z');
  // 默认（未识别键）按合计
  eq(sortGhosts(list, 'pid', -1)[0].key, 'a', 'PID 列对幽灵无意义 → 退到合计');
}

// ---------- capGhosts：头部单列 + 长尾折叠，求和守恒 ----------

section('capGhosts：不超上限时原样（按显示排序）');
{
  const { capGhosts } = api(40);
  const list = [
    { key: 'a', name: 'a', down: 10, up: 0 },
    { key: 'b', name: 'b', down: 30, up: 0 },
  ];
  const out = capGhosts(list, 'total', -1);
  eq(out.length, 2, '两条都在，没有折叠行');
  eq(out[0].key, 'b', '按合计降序');
  ok(!out.some((r) => r.tail), '没有折叠尾');
}

section('capGhosts：超上限时长尾折叠成一行，求和守恒');
{
  const { capGhosts } = api(2); // 强制上限为 2 触发折叠
  const list = [
    { key: 'a', name: 'a', down: 100, up: 0 },
    { key: 'b', name: 'b', down: 80, up: 0 },
    { key: 'c', name: 'c', down: 5, up: 1 },
    { key: 'd', name: 'd', down: 3, up: 2 },
  ];
  const out = capGhosts(list, 'total', -1);
  eq(out.length, 3, '头部 2 行 + 1 行折叠尾');
  const tail = out[out.length - 1];
  ok(tail.tail, '折叠行恒在末尾');
  ok(tail.name.includes('其它已退出进程'), '折叠行有说明文案');
  ok(tail.name.includes('2'), '文案带被折叠的条数');
  eq(tail.down, 8, '折叠尾累加长尾下载（5+3）');
  eq(tail.up, 3, '折叠尾累加长尾上传（1+2）');
  // 求和守恒：这一列加起来必须仍等于原始总量
  const before = list.reduce((s, g) => s + g.down + g.up, 0);
  const after = out.reduce((s, g) => s + g.down + g.up, 0);
  eq(after, before, '折叠前后总量守恒（列求和 = 库内真实 24h 总量）');
}

section('capGhosts：头部按历史合计取，折叠的永远是长尾');
{
  const { capGhosts } = api(2);
  const list = [
    { key: 'small1', name: 's1', down: 1, up: 0 },
    { key: 'big1', name: 'B1', down: 900, up: 0 },
    { key: 'small2', name: 's2', down: 2, up: 0 },
    { key: 'big2', name: 'B2', down: 800, up: 0 },
  ];
  const out = capGhosts(list, 'name', 1); // 按名字排显示，但截断仍按量
  const keptKeys = out.filter((r) => !r.tail).map((r) => r.key).sort();
  eq(keptKeys.join(','), 'big1,big2', '留下的是量最大的两个，与显示排序无关');
  eq(out[out.length - 1].down, 3, '长尾（两个 small）被折叠');
}

process.exit(report('ghost.test'));
