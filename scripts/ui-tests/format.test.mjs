// 格式化与对端列渲染的单测。
//
// 格式化实现在 common.js（原来 main.js 一份、mini.js 一份、history-ui.js 借一份，
// 三处档位迟早漂移）。这里直接测那一份，主界面的 fmtRate/fmtBytes 只是把当前
// rateUnit 绑上去的薄包装，没有独立逻辑可测。
//
// 重点是 clampUnit：单位非 B 时数值不得超过 999。修复前的 bug 是
// 999_999 字节 / 1000 = 999.999 → toFixed(1) → "1000.0 KB"，数字跨出了自己的单位。
//
// updatePeerCell 现在会建真实节点（旗帜=背景图方块，语义图标=内联 SVG），
// 用 harness 里那份最小 DOM 直接跑，验证图标与文本都接到了对端列上
// （headless 浏览器在本机已不可用，这条链路改由单测覆盖）。

import { makeWith, loadScripts, makeDocument, eq, ok, section, report } from './_harness.mjs';

const ctx = loadScripts(['flags.js', 'services.js', 'common.js']);
const S = ctx.NetPeekServices;
const K = ctx.NetPeekCommon;

// ---------- 格式化 ----------
for (const unit of ['auto', 'kb', 'mb', 'gb']) {
  // 绑定当前单位档，签名与主界面里那两个包装函数一致
  const fmtBytes = (n) => K.fmtBytes(n, unit);
  const fmtRate = (n) => K.fmtRate(n, unit);

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

// ---------- 档位边界与异常输入 ----------
// 上面按单位档跑的是「典型值」。真正会出事的是档位切换那一个字节的两侧，
// 以及采集端偶发的 null / 负数（进程退出那一帧算出来的速率可能是负的）。
section('fmtBytes / fmtRate 档位边界');
{
  // 每个进位点的前后一字节都要落在正确的档里
  eq(K.fmtBytes(999, 'auto'), '999 B', '1e3 前一档仍是 B');
  eq(K.fmtBytes(1000, 'auto'), '1.0 KB', '1e3 整点进 KB');
  eq(K.fmtBytes(999999, 'auto'), '999.0 KB', '1e6 前一字节仍是 KB');
  eq(K.fmtBytes(1000000, 'auto'), '1.0 MB', '1e6 整点进 MB');
  eq(K.fmtBytes(999999999, 'auto'), '999.0 MB', '1e9 前一字节仍是 MB');
  eq(K.fmtBytes(1000000000, 'auto'), '1.00 GB', '1e9 整点进 GB');

  // 速率的 MB 档比字节多一位小数（带宽读数要看得出百 KB 级的变化）
  eq(K.fmtRate(1000000, 'auto'), '1.00 MB/s', '速率 MB 档两位小数');
  eq(K.fmtBytes(1000000, 'auto'), '1.0 MB', '总量 MB 档一位小数');

  // clampUnit 的边界：999.9xx 必须压回 999，不能进位成 1000
  eq(K.clampUnit(999), 999, '999 不动');
  eq(K.clampUnit(999.4), 999, '超过 999 一律压到 999');
  eq(K.clampUnit(1000), 999, '1000 压到 999');
}

section('fmtBytes / fmtRate 异常输入不得渲染出 NaN');
{
  // 界面上出现 "NaN B/s" 比出现 "0 B/s" 严重得多：后者是读数为零，
  // 前者让人以为整个采集链路坏了。
  eq(K.fmtBytes(0, 'auto'), '0 B', '0');
  eq(K.fmtRate(0, 'auto'), '0 B/s', '速率 0');
  eq(K.fmtBytes(-1, 'auto'), '-1 B', '负数按原样显示，不伪装成 0');
  ok(!/NaN/.test(K.fmtBytes(null, 'auto')), 'null 不产出 NaN');
  ok(!/NaN/.test(K.fmtBytes(undefined, 'auto')), 'undefined 不产出 NaN');
  ok(!/NaN/.test(K.fmtRate(null, 'auto')), '速率 null 不产出 NaN');
  ok(!/NaN/.test(K.fmtBytes('abc', 'auto')), '非数字字符串不产出 NaN');
}

section('splitUnit：数值与单位分离');
{
  eq(K.splitUnit('1.23 MB/s').value, '1.23', '数值段');
  eq(K.splitUnit('1.23 MB/s').unit, 'MB/s', '单位段');
  eq(K.splitUnit('999 B').unit, 'B', '单字母单位');
  // 没有空格时整串算数值：这样调用方不会拿到 undefined 去 textContent
  eq(K.splitUnit('—').value, '—', '无空格时整串为数值段');
  eq(K.splitUnit('—').unit, '', '无空格时单位为空串');
}

section('fmtDuration：HH:MM:SS');
{
  eq(K.fmtDuration(0), '00:00:00', '零');
  eq(K.fmtDuration(59), '00:00:59', '分钟前一秒');
  eq(K.fmtDuration(60), '00:01:00', '整分');
  eq(K.fmtDuration(3599), '00:59:59', '小时前一秒');
  eq(K.fmtDuration(3600), '01:00:00', '整时');
  eq(K.fmtDuration(4513), '01:15:13', '常规组合');
  eq(K.fmtDuration(360000), '100:00:00', '超过两位数的小时不截断');
  // 负数会出现在「会话时长」上：进程启动时刻比本机时钟新（改过系统时间）
  eq(K.fmtDuration(-5), '00:00:00', '负数夹到零，不显示 -1:59:55');
  eq(K.fmtDuration(1.9), '00:00:01', '小数向下取整');
  eq(K.fmtDuration(null), '00:00:00', 'null 不产出 NaN:NaN:NaN');
}

section('initialOf：首字母占位');
{
  eq(K.initialOf('msedge', 1), 'M', '常规名取首字母大写');
  eq(K.initialOf('msedge', 2), 'MS', 'len=2 取两位');
  // 未归因流量名以半角括号开头，直接切首字符会画出一个孤零零的括号
  eq(K.initialOf(K.UNATTR, 1), '系', '跳过前导括号，取第一个文字');
  eq(K.initialOf('(系统/未归因)', 2), '系统', '跳过括号后取两字');
  eq(K.initialOf('', 1), '·', '空名回落中点');
  eq(K.initialOf(null, 1), '·', 'null 回落中点');
  eq(K.initialOf('...', 1), '·', '全是标点时回落中点');
  eq(K.initialOf('7zip', 1), '7', '数字开头保留数字');
  eq(K.initialOf('中文名', 1), '中', '中文名取首字');
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
