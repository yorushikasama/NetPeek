// 监控屏「近 24 小时」列的单测：取数键、两张表的整理、单元格文案。
//
// 为什么值得测：这一列的数来自历史库，而历史库是按「进程实例 × 分钟」存的。
// 前端要把它折成两种视图的行身份（进程视图按 pid:启动时刻、应用视图按名字），
// 中间任何一处键写错都不会报错 —— 只会让整列安静地显示破折号或错数，
// 看起来像「历史库没数据」，而不是像 bug。
//
// 另一件必须钉死的事：查不到记录时要显示破折号。写成 0 就是编了一个读数出来
// （进程刚启动、这一分钟还没落库时我们根本没测到），与顶栏断连时的破折号同一条规矩。

import { makeWith, loadScripts, eq, ok, section, report } from './_harness.mjs';

const ctx = loadScripts(['flags.js', 'services.js', 'common.js']);
const UNATTR = '(系统/未归因)';

function api() {
  return makeWith(
    'main.js',
    ['day24Key', 'buildDay24', 'day24Of', 'day24Cell'],
    {
      UNATTR,
      // 用 common.js 的真实现：断言里的单位串就是界面上会出现的串
      fmtBytes: (v) => ctx.NetPeekCommon.fmtBytes(v, 'auto'),
    },
  );
}

const proc = (over) => Object.assign({ Pid: 1, Name: 'a.exe', StartTimeUnixMs: 0 }, over);

// ---------- 身份键 ----------

section('day24Key：与历史库的 (pid, start_ts) 对齐，start_ts 是秒');
{
  const { day24Key } = api();
  // 历史库 record() 是 StartTimeUnixMs / 1000 之后再落库的（Rust 整数除法 = 向下取整）。
  // 这里若写成毫秒，整张表都会查不到 —— 而且不报错。
  eq(day24Key(proc({ Pid: 7, StartTimeUnixMs: 1_700_000_000_999 })),
    '7:1700000000', '毫秒截成秒，不是原样带上毫秒');
  eq(day24Key(proc({ Pid: 7, StartTimeUnixMs: 0 })), '7:0', '启动时刻未知时退化成 pid:0');
  eq(day24Key({ Pid: 7 }), '7:0', '字段缺失也走 0，不产生 pid:NaN');
  // 与表格行 key（histKey，毫秒）必须是两套：混用就是整列查不到
  eq(day24Key(proc({ Pid: 7, StartTimeUnixMs: 1000 })) !== '7:1000', true, '不等于毫秒键');
}

// ---------- 两张表的整理 ----------

section('buildDay24：进程身份表与应用名表同时建');
{
  const { buildDay24 } = api();
  const t = buildDay24([
    { name: 'chrome.exe', pid: 7, startTs: 100, down: 900, up: 100 },
    { name: 'steam', pid: 8, startTs: 200, down: 50, up: 5 },
  ]);
  eq(t.ready, true, '建表后标记为可用');
  eq(t.byKey.get('7:100').down, 900, '按身份键取下载');
  eq(t.byKey.get('7:100').up, 100, '按身份键取上传');
  eq(t.byName.get('chrome.exe').down, 900, '按应用名取下载');
  eq(t.byName.get('steam').up, 5, '第二个应用也在表里');
}

section('buildDay24：空名字归一成未归因');
{
  const { buildDay24, day24Of } = api();
  // 历史库里未归因进程的 name 是空串（Rust 侧 unwrap_or("")），而表格把它显示成
  // 「(系统/未归因)」。不归一，那一行的近 24 小时永远是破折号 —— 还查不出原因。
  const t = buildDay24([{ name: '', pid: 0, startTs: 0, down: 12, up: 3 }]);
  eq(t.byName.get(UNATTR.toLowerCase()).down, 12, '空串归到未归因名下');
  eq(day24Of(t, { Name: UNATTR, Pid: 0, StartTimeUnixMs: 0 }, 'app').up, 3,
    '表格里的未归因行能取到');
}

section('buildDay24：应用名大小写归一，同一身份的多行相加');
{
  const { buildDay24 } = api();
  const t = buildDay24([
    { name: 'MsEdge', pid: 10, startTs: 5, down: 100, up: 1 },
    { name: 'msedge', pid: 10, startTs: 5, down: 40, up: 2 },   // 改名后同名同键再来一行
    { name: 'MSEDGE', pid: 11, startTs: 6, down: 7, up: 8 },
  ]);
  eq(t.byKey.get('10:5').down, 140, '同身份多行累加（不是覆盖）');
  eq(t.byName.get('msedge').down, 147, '大小写不同也归到一个应用');
  eq(t.byName.get('msedge').up, 11, '上传同样累加');
  eq(t.byName.size, 1, '只留一个小写键');
}

section('buildDay24：空输入不炸');
{
  const { buildDay24 } = api();
  eq(buildDay24([]).byKey.size, 0, '空数组');
  eq(buildDay24(null).ready, true, 'null 也给一张可用的空表');
  eq(buildDay24(undefined).byName.size, 0, 'undefined 同样');
}

// ---------- 取数 ----------

section('day24Of：两种视图各按各的行身份取');
{
  const { buildDay24, day24Of } = api();
  const t = buildDay24([
    { name: 'msedge', pid: 10, startTs: 5, down: 100, up: 10 },
    { name: 'msedge', pid: 11, startTs: 3, down: 400, up: 20 },
  ]);
  eq(day24Of(t, proc({ Pid: 10, Name: 'msedge', StartTimeUnixMs: 5000 }), 'process').down, 100,
    '进程视图只取本实例的量');
  eq(day24Of(t, { Name: 'msedge' }, 'app').down, 500, '应用视图取该应用的合计');
  eq(day24Of(t, { Name: 'MSEDGE' }, 'app').down, 500, '应用名大小写不敏感');
}

section('day24Of：没这个身份 / 表还没建好都返回 null');
{
  const { buildDay24, day24Of } = api();
  const t = buildDay24([{ name: 'a.exe', pid: 1, startTs: 0, down: 1, up: 1 }]);
  eq(day24Of(t, proc({ Pid: 2, Name: 'b.exe' }), 'process'), null, '库里没这个进程实例');
  eq(day24Of(t, { Name: 'b.exe' }, 'app'), null, '库里没这个应用');
  // 首帧：还没读到库。这时整列都该是破折号，而不是全 0
  const empty = { byKey: new Map(), byName: new Map(), ready: false };
  eq(day24Of(empty, { Name: 'a.exe' }, 'app'), null, '未就绪时一律 null');
}

// ---------- start_ts=0 的老行：按 PID 兜底认领 ----------

section('day24Of：实时行没有启动时间时，认领 start_ts=0 的老行');
{
  const { buildDay24, day24Of } = api();
  // 采集端 2026-09-21 之前会在拿不到启动时间时写 start_ts=0
  //（句柄开不出来但名字拿得到：受保护进程、或刚好退出的短命进程）。
  // 用户库里这样的行有 2,387 条、约 5.7 GB，最近 24 小时窗口内 491 MB ——
  // 全都在这一列上显示破折号，数据等于消失。
  const t = buildDay24([
    { name: 'WorkBuddy', pid: 20768, startTs: 0, down: 500_000_000, up: 10 },
    { name: 'chrome', pid: 999, startTs: 1700000000, down: 700, up: 30 },
  ]);

  // ① 实时行自己也没拿到启动时间 → 按 PID 认领那条老行
  eq(day24Of(t, proc({ Pid: 20768, Name: 'WorkBuddy', StartTimeUnixMs: 0 }), 'process').down,
    500_000_000, '实时行缺启动时间时，按 PID 认领老行');
  eq(day24Of(t, { Pid: 20768, Name: 'WorkBuddy' }, 'process').down,
    500_000_000, '字段整个缺失（undefined）同样认领');

  // ② 实时行**有**启动时间时不许走兜底：PID 会被系统复用，
  //    否则「今天的 20768」会认领「上周那个 20768」的流量。
  eq(day24Of(t, proc({ Pid: 20768, Name: 'WorkBuddy', StartTimeUnixMs: 1700000000 }), 'process'),
    null, '实时行有启动时间时不认领老行（PID 复用会串数）');

  // ③ 正常身份键优先级高于兜底：库里同时有精确键就该用精确键
  const t2 = buildDay24([
    { name: 'x', pid: 5, startTs: 0, down: 111, up: 0 },
    { name: 'x', pid: 5, startTs: 4242, down: 222, up: 0 },
  ]);
  eq(day24Of(t2, proc({ Pid: 5, StartTimeUnixMs: 4242000 }), 'process').down,
    222, '有精确键时取精确键，不被兜底表盖掉');

  // ④ 老行表只收 start_ts=0 的行：有身份键的行不该出现在兜底表里
  eq(t.byPidOrphan.has('999'), false, '有正常启动时间的行不进兜底表');
  eq(t.byPidOrphan.get('20768').down, 500_000_000, 'start_ts=0 的行进兜底表');
}

// ---------- 单元格文案 ----------

section('day24Cell：命中给数值，未命中给破折号');
{
  const { day24Cell } = api();
  const hit = day24Cell({ down: 1e9, up: 5e8 });
  eq(hit.text, '1.50 GB', '显示下载 + 上传的合计');
  eq(hit.blank, false, '有数据不是空态');
  ok(hit.title.includes('下载 1.00 GB'), '悬浮说明里有下载明细');
  ok(hit.title.includes('上传 500.0 MB'), '悬浮说明里有上传明细');

  // 这一条是本列最容易被「顺手改好」的地方：改成 0 B 看着更整齐，
  // 但那是在陈述「记录到了零流量」，与事实（没记录）不符。
  const miss = day24Cell(null);
  eq(miss.text, '—', '没有记录给破折号');
  eq(miss.blank, true, '并标记为弱字阶');
  eq(miss.text.includes('0 B'), false, '绝不写成 0 B');
}

section('day24Cell：量级跨档都带完整单位');
{
  const { day24Cell } = api();
  eq(day24Cell({ down: 0, up: 512 }).text, '512 B', '不足 1KB 写 B');
  eq(day24Cell({ down: 1e6, up: 0 }).text, '1.0 MB', 'MB 档一位小数');
  eq(day24Cell({ down: 1e9, up: 0 }).text, '1.00 GB', 'GB 档两位小数');
}

process.exit(report('day24.test'));
