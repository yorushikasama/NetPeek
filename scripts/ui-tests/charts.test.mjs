// 图表坐标标注格式化（charts.js 的 axisBytes / axisRate）。
//
// 为什么值得单测：这两个函数只出现在 canvas 里，DOM 断言够不着，而它们出错的
// 表现是「看着有点怪」而不是崩 —— 历史上就真出过两回：
//   1) 单位缩写成 K/M/G，实时图轴标注写「6.0M/s」，与顶栏的「5.12 MB/s」两套写法；
//   2) 空态占位量程取 1 字节，interval=0.5，0.5 和 1 都格式化成同一个字符串，
//      坐标轴上出现两个一模一样的刻度。
// 两条都在这里钉住。

import { loadScripts, eq, ok, section, report } from './_harness.mjs';

const ctx = loadScripts(['charts.js']);
const C = ctx.NetPeekCharts;

if (!C) {
  console.log('FAIL charts.test —— charts.js 没有挂上 window.NetPeekCharts');
  process.exit(1);
}

const { axisBytes, axisRate } = C;

section('字节量程（柱图 y 轴）');
eq(axisBytes(0), '0', '0 不带单位');
eq(axisBytes(999), '999 B', '不足 1 KB 带 B');
eq(axisBytes(1e3), '1.0 KB', '1e3 进 KB');
eq(axisBytes(1.5e6), '1.5 MB', 'MB 一档一位小数');
eq(axisBytes(1e9), '1.0 GB', '1e9 进 GB');
eq(axisBytes(40e9), '40 GB', '≥10 不带小数');
eq(axisBytes(1e12), '1.0 TB', '1e12 进 TB');

section('速率量程（折线 y 轴）');
eq(axisRate(0), '0', '0 不带单位');
eq(axisRate(500), '500 B/s', '不足 1 KB 写 B/s');
eq(axisRate(6e6), '6.0 MB/s', '实时图上限');
eq(axisRate(6e6 / 2), '3.0 MB/s', '实时图中位档');
eq(axisRate(1e12), '1.0 TB/s', '极大值进 TB/s');

section('单位必须与界面其它地方同源');
// fmtBytes / fmtRate 写的是「1.00 MB/s」「999.0 MB」；轴上不许再出现 K/M/G 这种
// 只说量级不说单位的缩写 —— 「6.0M/s」会被读成米每秒。
for (const s of [axisBytes(40e9), axisBytes(1.5e6), axisBytes(1e3), axisBytes(1e12)]) {
  ok(/\d (B|KB|MB|GB|TB)$/.test(s), `字节标注带完整单位：${s}`);
}
for (const s of [axisRate(6e6), axisRate(500), axisRate(1e12)]) {
  ok(/\d (B|KB|MB|GB|TB)\/s$/.test(s), `速率标注带完整单位：${s}`);
}

section('空态占位量程不得叠字');
// 空态的 yMax 与它分出来的中位档必须是两个不同的字符串，否则坐标轴上
// 会出现两条文字相同的刻度线（旧实现的「1/s」配「1/s」）。
const IDLE_RATE = 1e6;
const IDLE_BYTES = 1e9;
ok(axisRate(IDLE_RATE) !== axisRate(IDLE_RATE / 2), `速率待机量程两档可区分：${axisRate(IDLE_RATE)} / ${axisRate(IDLE_RATE / 2)}`);
ok(axisBytes(IDLE_BYTES) !== axisBytes(IDLE_BYTES / 2), `字节待机量程两档可区分：${axisBytes(IDLE_BYTES)} / ${axisBytes(IDLE_BYTES / 2)}`);

process.exit(report('charts.test'));
