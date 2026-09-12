// common.js 单测：debounce（设置写盘防抖用的就是它）。
//
// 这类计时器工具最容易错在两个地方：一是「防抖」被写成「节流」把中间值吃掉，
// 二是 flush 之后旧的定时器又补一枪（表现为落盘两次）。两条都钉住。

import { loadBrowserScript, eq, section, report } from './_harness.mjs';

const C = loadBrowserScript('common.js').NetPeekCommon;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

section('escapeHtml');
eq(C.escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;', '五类字符全转义');
eq(C.escapeHtml(7), '7', '非字符串先转成串');

section('debounce 合并连续调用');
{
  let calls = 0;
  const d = C.debounce(() => { calls += 1; }, 30);

  d.schedule(); d.schedule(); d.schedule();
  eq(calls, 0, '未到时间不执行');
  eq(d.pending, true, '有挂起的写入');

  await sleep(70);
  eq(calls, 1, '三次 schedule 只落一次');
  eq(d.pending, false, '执行后挂起标记清空');
}

section('debounce flush 立即执行');
{
  let calls = 0;
  const d = C.debounce(() => { calls += 1; }, 30);

  d.schedule();
  await d.flush();
  eq(calls, 1, 'flush 不等定时器');
  await sleep(70);
  eq(calls, 1, 'flush 之后旧定时器不再补一枪');
}

section('debounce 空 flush 与复用');
{
  let calls = 0;
  const d = C.debounce(() => { calls += 1; }, 30);

  await d.flush();
  eq(calls, 0, '无挂起时 flush 不调用');

  d.schedule();
  await sleep(70);
  eq(calls, 1, 'flush 之后防抖仍正常工作');
}

section('debounce 保留最后一次的参数性');
{
  // 用闭包变量模拟「最后一次改动必须落进去」
  let value = '';
  const d = C.debounce(() => { value = latest; }, 30);
  let latest = 'a';
  d.schedule();
  latest = 'b';
  d.schedule();
  latest = 'c';
  d.schedule();
  await sleep(70);
  eq(value, 'c', '写进去的是最后一次的值，不是第一次的');
}

process.exit(report('common.test'));
