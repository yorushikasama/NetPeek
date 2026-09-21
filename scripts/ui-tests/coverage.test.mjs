// 归因覆盖率单元格（coverageCell）的单测。
//
// 为什么单独测它：这个读数的三种"零"看着一样、含义完全不同 ——
// 没测到 / 真的没流量 / 全部归因成功。写混了就会报一个好看但与事实相反的读数
// （§9 要求差额如实单列，不摊回各应用）。
//
// 背景（2026-09-21）：原实现在进程列表里统计"名字非空的占比"，那个口径
// 永远接近 100% —— 它只能看到已经在列表里的进程，而真正没归因上的那部分
// （受保护进程、短命连接、协议头、回环）压根不进列表。
// 现在改用「接口计数 − 进程合计」，由采集端下发 Unattributed* 字段。

import { makeWith, eq, ok, section, report } from './_harness.mjs';

function api() {
  return makeWith('main.js', ['coverageCell'], {
    // 用真实现：断言里的串就是界面上会出现的串
    fmtBytes: (v) => `${(v / 1e6).toFixed(1)} MB`,
  });
}

section('coverageCell：没拿到接口计数时给破折号，不给 0%');
{
  const { coverageCell } = api();
  // 这一条最关键：把"没测到"显示成"0% 已归因"或"100% 已归因"都是编读数。
  const miss = coverageCell({
    UnattributedKnown: false,
    UnattributedDownloadBytes: 0,
    TotalDownloadBytes: 5000,
    TotalUploadBytes: 300,
  });
  eq(miss.text, '—', '不可信时给破折号');
  ok(miss.title.includes('接口计数'), '说明为什么不可用');
}

section('coverageCell：接口与进程都没动时是「暂无流量」，不是 0%');
{
  const { coverageCell } = api();
  const idle = coverageCell({
    UnattributedKnown: true, TotalDownloadBytes: 0, TotalUploadBytes: 0,
    UnattributedDownloadBytes: 0, UnattributedUploadBytes: 0,
  });
  eq(idle.text, '暂无流量', '真没流量与没测到要分开');
  eq(idle.title, '', '没流量不需要悬浮说明');
}

section('coverageCell：按接口总量算百分比，差额单独列出');
{
  const { coverageCell } = api();
  // 归因 900万，未归因 100万 → 总 1000万 → 90.0% 已归因
  const c = coverageCell({
    UnattributedKnown: true,
    TotalDownloadBytes: 8_000_000,
    TotalUploadBytes: 1_000_000,
    UnattributedDownloadBytes: 800_000,
    UnattributedUploadBytes: 200_000,
  });
  eq(c.text, '90.0% 已归因', '分母是「已归因 + 未归因」，不是只拿进程合计');
  ok(c.title.includes('9.0 MB'), '悬浮里给出已归因的绝对量');
  ok(c.title.includes('1.0 MB'), '悬浮里给出未归因的绝对量');
}

section('coverageCell：未归因为 0 时是 100%，那是真的全归因上了');
{
  const { coverageCell } = api();
  const c = coverageCell({
    UnattributedKnown: true,
    TotalDownloadBytes: 1000,
    TotalUploadBytes: 0,
    UnattributedDownloadBytes: 0,
    UnattributedUploadBytes: 0,
  });
  eq(c.text, '100.0% 已归因', '已知且差额为 0 → 100%');
}

section('coverageCell：旧采集端不发字段时按「可信的 0」处理（保持旧行为）');
{
  const { coverageCell } = api();
  // UnattributedKnown 缺省 true 是刻意的兼容：升级错位时不该整片破折号。
  const legacy = coverageCell({ TotalDownloadBytes: 2000, TotalUploadBytes: 500 });
  eq(legacy.text, '100.0% 已归因', '缺字段 → 当作已归因，不会整片破折号');
}

section('coverageCell：字段缺失 / 异常值不产生 NaN');
{
  const { coverageCell } = api();
  eq(coverageCell({}).text, '暂无流量', '空快照');
  const weird = coverageCell({
    UnattributedKnown: true, TotalDownloadBytes: null, TotalUploadBytes: undefined,
    UnattributedDownloadBytes: null, UnattributedUploadBytes: undefined,
  });
  eq(weird.text, '暂无流量', 'null / undefined 当 0，不出现 NaN');
  ok(!coverageCell({ TotalDownloadBytes: 5 }).text.includes('NaN'), '不出现 NaN');
}

process.exit(report('coverage.test'));
