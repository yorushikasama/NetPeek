// main.js 单测：字节/速率格式化（clampUnit 截断）与对端列的渲染逻辑。
//
// 重点是 clampUnit：单位非 B 时数值不得超过 999。修复前的 bug 是
// 999_999 字节 / 1000 = 999.999 → toFixed(1) → "1000.0 KB"，数字跨出了自己的单位。
//
// updatePeerCell 现在会建真实节点（旗帜=背景图方块，语义图标=内联 SVG），
// 用 harness 里那份最小 DOM 直接跑，验证图标与文本都接到了对端列上
// （headless 浏览器在本机已不可用，这条链路改由单测覆盖）。

import { makeWith, loadScripts, makeDocument, eq, ok, section, report } from './_harness.mjs';

const ctx = loadScripts(['flags.js', 'services.js']);
const S = ctx.NetPeekServices;

// ---------- 格式化 ----------
for (const unit of ['auto', 'kb', 'mb', 'gb']) {
  const { fmtBytes, fmtRate } = makeWith('main.js', ['clampUnit', 'fmtBytes', 'fmtRate'], { rateUnit: unit });

  section(`fmtBytes（rateUnit=${unit}）`);
  switch (unit) {
    case 'auto':
      eq(fmtBytes(0), '0 B', '0 字节');
      eq(fmtBytes(999), '999 B', '千字节以下不进位');
      eq(fmtBytes(1000), '1.0 KB', '1e3 进位');
      // 核心修复点：不做截断时这里是 "1000.0 KB"
      eq(fmtBytes(999999), '999.0 KB', '999_999 不得显示成 1000.0 KB');
      eq(fmtBytes(1000000), '1.0 MB', '1e6 进位');
      eq(fmtBytes(999999999), '999.0 MB', '999_999_999 不得显示成 1000.0 MB');
      eq(fmtBytes(1000000000), '1.00 GB', '1e9 进位');
      eq(fmtBytes(999500000000), '999.00 GB', '999.5 GB 压到上限');
      eq(fmtBytes(1e12), '999.00 GB', '超出 GB 量级压到上限');
      break;
    case 'kb':
      eq(fmtBytes(999), '1.0 KB', '强制 KB：小于 1KB 也按 KB 显示');
      eq(fmtBytes(5e9), '999.0 KB', '强制 KB：超上限压到 999');
      break;
    case 'mb':
      eq(fmtBytes(1500000), '1.5 MB', '强制 MB');
      eq(fmtBytes(5e9), '999.0 MB', '强制 MB：超上限压到 999');
      break;
    case 'gb':
      eq(fmtBytes(5e9), '5.00 GB', '强制 GB 保留两位');
      eq(fmtBytes(5e12), '999.00 GB', '强制 GB：超上限压到 999');
      break;
  }

  section(`fmtRate（rateUnit=${unit}）`);
  switch (unit) {
    case 'auto':
      eq(fmtRate(999), '999 B/s', '1e3 以下按字节');
      eq(fmtRate(1000), '1.0 KB/s', '1e3 进位');
      eq(fmtRate(999999), '999.0 KB/s', '不得显示成 1000.0 KB/s');
      eq(fmtRate(1000000), '1.00 MB/s', '1e6 进位');
      eq(fmtRate(1e9), '1.00 GB/s', '1e9 进位');
      eq(fmtRate(1e12), '999.00 GB/s', '超上限压到 999');
      break;
    case 'kb':
      eq(fmtRate(1e9), '999.0 KB/s', '强制 KB：超上限压到 999');
      break;
    case 'mb':
      eq(fmtRate(1e9), '999.0 MB/s', '强制 MB：超上限压到 999');
      break;
    case 'gb':
      eq(fmtRate(1e9), '1.00 GB/s', '强制 GB');
      break;
  }
}

// ---------- 对端列 ----------
const doc = makeDocument();
const { peerIconNode, updatePeerCell } = makeWith(
  'main.js',
  ['peerIconNode', 'updatePeerCell'],
  { window: ctx, document: doc },
);

section('updatePeerCell 公网：图标 + 文本');
{
  const c = doc.createElement('td');
  updatePeerCell(c, { TopRemoteIp: '142.250.196.100', TopRemotePort: 443, TopRemoteCountry: 'JP' });

  eq(c.textContent, '142.250.196.100 · HTTPS', '文本不含图标');
  eq(c.children.length, 2, '图标节点 + 文本节点');
  eq(c.children[0].className, 'peer-flag', '公网挂旗帜方块');
  eq(c.children[0].style.backgroundPosition, ctx.NetPeekFlags.pos('jp'), '定位取自 flags.js');
  ok(/url\(flags\.png\)/.test(c.children[0].style.backgroundImage), '背景图指向雪碧图');
  eq(c.children[0].style.width, '16px', '图标宽度按 2 倍图折半');
  eq(c.title, '142.250.196.100:443（HTTPS） · JP', 'tooltip 含国家码');
  eq(c.classList.has('has-peer'), true, '有对端时带 has-peer 类');
}

section('updatePeerCell 私网：语义图标 + 文字前缀');
{
  const c = doc.createElement('td');
  updatePeerCell(c, { TopRemoteIp: '192.168.1.50', TopRemotePort: 445, TopRemoteCountry: '' });
  eq(c.textContent, '局域网 192.168.1.50 · SMB', '私网文本带语义前缀');
  eq(c.children[0].className, 'peer-icon', '语义图标走内联 SVG');
  ok(/<svg/.test(c.children[0].innerHTML), '内联 SVG 已注入');
  eq(c.children[0].style.backgroundPosition, undefined, '语义图标不用雪碧图定位');
  eq(c.title.includes('局域网'), true, 'tooltip 也带上语义');

  const loop = doc.createElement('td');
  updatePeerCell(loop, { TopRemoteIp: '127.0.0.1', TopRemotePort: 0, TopRemoteCountry: '' });
  eq(loop.textContent, '本机 127.0.0.1', '回环文本');
}

section('updatePeerCell 图标复用');
{
  const c = doc.createElement('td');
  updatePeerCell(c, { TopRemoteIp: '142.250.196.100', TopRemotePort: 443, TopRemoteCountry: 'JP' });
  const icon = c.children[0];
  const text = c.children[1];

  // 同一对端、同一图标：节点全部复用，只改文本值（1 Hz 下的常态）
  updatePeerCell(c, { TopRemoteIp: '142.250.196.100', TopRemotePort: 8080, TopRemoteCountry: 'JP' });
  eq(c.children[0] === icon, true, '图标键未变则不重建节点');
  eq(c.children[1] === text, true, '文本节点就地改值，不重建');
  eq(c.textContent, '142.250.196.100 · HTTP-Alt', '文本内容已更新');

  // 换国家：图标必须换新
  updatePeerCell(c, { TopRemoteIp: '142.250.196.100', TopRemotePort: 8080, TopRemoteCountry: 'US' });
  eq(c.children[0] === icon, false, '国家变了则重建图标');
  eq(c.children[0].style.backgroundPosition, ctx.NetPeekFlags.pos('us'), '换成 US 的定位');
  eq(c.textContent, '142.250.196.100 · HTTP-Alt', '文本内容不变');

  // 公网 → 私网：图标从雪碧图方块换成内联 SVG
  updatePeerCell(c, { TopRemoteIp: '192.168.1.9', TopRemotePort: 445, TopRemoteCountry: '' });
  eq(c.children[0].className, 'peer-icon', '切到私网后换成语义图标');
  eq(c.textContent, '局域网 192.168.1.9 · SMB', '私网文本');
}

section('updatePeerCell 空态与回落');
{
  const c = doc.createElement('td');
  updatePeerCell(c, { TopRemoteIp: '', TopRemotePort: 0 });
  eq(c.textContent, '—', '无对端显示破折号');
  eq(c.children.length, 1, '空态只剩一个文本节点，不留图标');
  eq(c.classList.has('has-peer'), false, '无对端不带 has-peer');

  const c2 = doc.createElement('td');
  updatePeerCell(c2, { TopRemoteIp: '8.8.8.8', TopRemotePort: 9999, TopRemoteCountry: '' });
  eq(c2.textContent, '8.8.8.8 :9999', '未登记端口回落到 :端口');
  eq(c2.children[0].className, 'peer-icon', '公网无国家码退化成语义图标');

  // 形状合法但雪碧图没收录的码：必须退化成地球，不能一片空白
  const c3 = doc.createElement('td');
  updatePeerCell(c3, { TopRemoteIp: '1.2.3.4', TopRemotePort: 443, TopRemoteCountry: 'ZZ' });
  eq(c3.children[0].className, 'peer-icon', '雪碧图未收录的码退化为语义图标');
  ok(/<svg/.test(c3.children[0].innerHTML), '退化为内联 SVG');

  // 空态之后再来对端：状态要能恢复
  updatePeerCell(c, { TopRemoteIp: '8.8.8.8', TopRemotePort: 53, TopRemoteCountry: 'US' });
  eq(c.children[0].className, 'peer-flag', '从空态恢复时重新建图标');
  eq(c.textContent, '8.8.8.8 · DNS', '文本恢复');
  eq(c.classList.has('has-peer'), true, 'has-peer 类恢复');
}

section('peerIconNode 边界');
{
  eq(peerIconNode(''), null, '空键返回 null');
  eq(peerIconNode('sem:nosuch'), null, '未定义语义图标返回 null');
  eq(peerIconNode('zz').className, 'peer-icon', '雪碧图未收录的码退化为语义图标');
  eq(peerIconNode('cn').className, 'peer-flag', '雪碧图里有的码返回旗帜方块');
}

// ---------- 详情行混排 ----------
// setInspMeta 要把字符串片段和有图标的片段用同一个分隔符串起来，
// 图标是节点、文本是文本节点，拼接顺序错了就会出现「图标跑到行尾」这种错位。
const meta = doc.createElement('div');
const { setInspMeta } = makeWith('main.js', ['peerIconNode', 'setInspMeta'], {
  window: ctx, document: doc, els: { inspMeta: meta },
});

section('setInspMeta 字符串片段');
{
  setInspMeta(['PID 100', '会话 5 分钟']);
  eq(meta.textContent, 'PID 100 · 会话 5 分钟', '片段之间用 · 连接');
  eq(meta.children.length, 3, '两个文本 + 一个分隔符');
}

section('setInspMeta 混排图标片段');
{
  setInspMeta([
    'PID 100',
    { lead: '对端 ', icon: 'jp', text: '142.250.196.100:443（HTTPS）' },
  ]);
  eq(meta.textContent, 'PID 100 · 对端 142.250.196.100:443（HTTPS）', '文字顺序正确');
  eq(meta.children[0].nodeValue, 'PID 100', '首段');
  eq(meta.children[1].nodeValue, ' · ', '分隔符');
  eq(meta.children[2].nodeValue, '对端 ', '图标前的引导词');
  eq(meta.children[3].className, 'peer-flag', '图标插在引导词之后');
  eq(meta.children[4].nodeValue, '142.250.196.100:443（HTTPS）', '图标之后是地址');
}

section('setInspMeta 无色标 / 空片段');
{
  setInspMeta([{ icon: 'sem:lan', text: '局域网 192.168.1.5:445（SMB）' }]);
  eq(meta.children[0].className, 'peer-icon', '语义图标在最前');
  eq(meta.textContent, '局域网 192.168.1.5:445（SMB）', '无引导词');
  setInspMeta([]);
  eq(meta.textContent, '', '空数组清空内容');
}

process.exit(report('format.test'));
