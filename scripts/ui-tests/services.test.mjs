// services.js 单测：端口→服务名、国家码→图标键、bogon（保留地址）判定、对端描述组装。
//
// bogon 判定的边界值全部覆盖：网段上下界内外、IPv6 各种前缀、非法输入不得抛异常。
// 这类逻辑出错的表现是「内网 IP 被当成国外主机」或「渲染出一串乱码」，属于静默错误，
// 必须靠断言守住。网段表依据 IANA 特殊用途地址登记（与 Sniffnet bogon.rs 同源）。
//
// 旗帜从 emoji 换成图标键是被迫的：Windows 的 Segoe UI Emoji 不含国旗字形，
// emoji 方案在本平台恒渲染成两个字母。见 services.js 顶部注释。

import { loadBrowserScript, eq, section, report } from './_harness.mjs';

const { NetPeekServices: S } = loadBrowserScript('services.js');

section('服务名映射');
eq(S.serviceName(443), 'HTTPS', '443 → HTTPS');
eq(S.serviceName(53), 'DNS', '53 → DNS');
eq(S.serviceName(3389), 'RDP', '3389 → RDP');
eq(S.serviceName(31337), 'BackOrifice', '31337 → BackOrifice');
eq(S.serviceName(9999), '', '未登记端口返回空串');
eq(S.serviceName(0), '', '端口 0 返回空串');
eq(S.serviceName(undefined), '', 'undefined 不抛异常');

section('国家码 → 图标键');
eq(S.flagKey('JP'), 'jp', 'JP → jp');
eq(S.flagKey('us'), 'us', '小写输入归一');
eq(S.flagKey(' Us '), 'us', '空白与大小写归一');
eq(S.flagKey('xyz'), '', '三位码非法');
eq(S.flagKey('U1'), '', '含数字非法');
eq(S.flagKey(''), '', '空串');
eq(S.flagKey(undefined), '', 'undefined 不抛异常');
eq(S.flagKey(null), '', 'null 不抛异常');

section('IPv4 私网与边界');
eq(S.bogonLabel('10.0.0.1'), '局域网', '10.0.0.1');
eq(S.bogonLabel('9.255.255.255'), '', '10/8 下界外');
eq(S.bogonLabel('11.0.0.0'), '', '10/8 上界外');
eq(S.bogonLabel('172.16.0.1'), '局域网', '172.16.0.1');
eq(S.bogonLabel('172.31.255.255'), '局域网', '172.16/12 上界');
eq(S.bogonLabel('172.32.0.0'), '', '172.16/12 上界外');
eq(S.bogonLabel('192.168.1.1'), '局域网', '192.168.1.1');

section('IPv4 回环 / CGNAT / 链路本地');
eq(S.bogonLabel('127.0.0.1'), '本机', '127.0.0.1');
eq(S.bogonLabel('100.64.0.0'), '运营商NAT', '100.64/10 下界');
eq(S.bogonLabel('100.127.255.255'), '运营商NAT', '100.64/10 上界');
eq(S.bogonLabel('100.63.255.255'), '', '100.64/10 下界外');
eq(S.bogonLabel('169.254.1.1'), '链路本地', '169.254/16');

section('IPv4 组播 / 保留 / 测试网段');
eq(S.bogonLabel('224.0.0.1'), '组播', '224/4 下界');
eq(S.bogonLabel('239.255.255.255'), '组播', '224/4 上界');
eq(S.bogonLabel('223.255.255.255'), '', '224/4 下界外');
eq(S.bogonLabel('255.255.255.255'), '保留', '广播地址');
eq(S.bogonLabel('192.0.2.5'), '测试', 'TEST-NET-1');
eq(S.bogonLabel('198.51.100.1'), '测试', 'TEST-NET-2');
eq(S.bogonLabel('203.0.113.9'), '测试', 'TEST-NET-3');
eq(S.bogonLabel('198.18.0.1'), '测试', '198.18/15 基准测试');
eq(S.bogonLabel('198.20.0.0'), '', '198.18/15 上界外');

section('IPv4 真实公网必须放行');
for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.196.100', '20.205.243.166', '104.16.0.1']) {
  eq(S.bogonLabel(ip), '', `公网 ${ip}`);
}

section('IPv6 前缀');
eq(S.bogonLabel('::'), '未指定', '::');
eq(S.bogonLabel('::1'), '本机', '::1');
eq(S.bogonLabel('fe80::1'), '链路本地', 'fe80::1');
eq(S.bogonLabel('fe80::1%12'), '链路本地', '带 scope id');
eq(S.bogonLabel('febf::1'), '链路本地', 'fe80::/10 上界');
eq(S.bogonLabel('fec0::1'), '', 'fe80::/10 上界外');
eq(S.bogonLabel('fc00::1'), '局域网', 'ULA fc00::/7 下界');
eq(S.bogonLabel('fd12:3456:789a::1'), '局域网', 'ULA fd 段');
eq(S.bogonLabel('fb00::1'), '', 'ULA 下界外');
eq(S.bogonLabel('ff02::1'), '组播', 'ff00::/8');
eq(S.bogonLabel('2001:db8::1'), '测试', '2001:db8::/32');
eq(S.bogonLabel('2002::1'), '隧道', '6to4');
eq(S.bogonLabel('2001::1'), '隧道', 'Teredo');
eq(S.bogonLabel('64:ff9b::1'), '隧道', 'NAT64');
eq(S.bogonLabel('100::1'), '保留', '100::/64');
eq(S.bogonLabel('2606:4700:4700::1111'), '', 'Cloudflare 公网');
eq(S.bogonLabel('2404:6800:4003::1'), '', 'Google 公网');

section('IPv4 映射地址按内层 IPv4 归类');
eq(S.bogonLabel('::ffff:192.168.1.1'), '局域网', '点分写法');
eq(S.bogonLabel('::ffff:c0a8:0101'), '局域网', 'hex 写法');
eq(S.bogonLabel('::ffff:8.8.8.8'), '', '内层是公网');

section('非法输入不得抛异常');
for (const bad of ['', 'not-an-ip', '999.1.1.1', '1.2.3', '192.168.1', null, undefined, 42, '::gggg']) {
  eq(S.bogonLabel(bad), '', `非法输入 ${JSON.stringify(bad)}`);
}

section('peerParts 组装（图标键 / 文本 / 悬浮提示 / 详情形式）');
{
  const pub = S.peerParts('142.250.196.100', 443, 'JP');
  eq(pub.icon, 'jp', '公网有国家码 → 国旗键');
  eq(pub.text, '142.250.196.100 · HTTPS', '文本不含图标');
  eq(pub.detail, '142.250.196.100:443（HTTPS）', '详情形式带端口与服务名');
  eq(pub.title, '142.250.196.100:443（HTTPS） · JP', '悬浮提示含国家码');

  const lan = S.peerParts('192.168.1.5', 445, '');
  eq(lan.icon, 'sem:lan', '私网 → 局域网语义图标');
  eq(lan.text, '局域网 192.168.1.5 · SMB', '私网保留文字前缀（图标分不出局域网与链路本地）');
  eq(lan.title, '192.168.1.5:445（SMB） · 局域网', '悬浮提示含语义标签');

  eq(S.peerParts('127.0.0.1', 0, '').icon, 'sem:loopback', '回环 → 本机图标');
  eq(S.peerParts('127.0.0.1', 0, '').text, '本机 127.0.0.1', '无端口时不追加后缀');
  eq(S.peerParts('169.254.1.1', 0, '').icon, 'sem:lan', '链路本地复用局域网图标');
  eq(S.peerParts('224.0.0.1', 0, '').icon, 'sem:multicast', '组播图标');
  eq(S.peerParts('192.0.2.5', 0, '').icon, 'sem:bogon', '测试网段 → 保留图标');
  eq(S.peerParts('100.64.0.1', 0, '').icon, 'sem:bogon', 'CGNAT → 保留图标');

  // 公网但定位不到：显式给「未知」图标，与「没有对端」区分开
  eq(S.peerParts('8.8.8.8', 53, '').icon, 'sem:unknown', '公网无国家码 → 未知图标');
  eq(S.peerParts('8.8.8.8', 53, '').text, '8.8.8.8 · DNS', '公网无国家码文本照常');
  // ZZ 形状合法（是二字码），所以这里给出的就是 'zz'；雪碧图里没有它，
  // 由 main.js 的 peerIconNode 兜底成「未知」地球——那一层有单独的断言。
  eq(S.peerParts('1.2.3.4', 0, 'ZZ').icon, 'zz', 'ZZ 形状合法，按国家码透传');
  // 私网即使带了国家码也不挂国旗：那种国家码本身就是错的
  eq(S.peerParts('10.1.2.3', 443, 'US').icon, 'sem:lan', '私网优先于国家码');

  eq(S.peerParts('8.8.8.8', 9999, '').text, '8.8.8.8 :9999', '未登记端口回落到 :端口');
  eq(S.peerParts('', 443, 'JP').text, '', '空 IP 返回空文本');
  eq(S.peerParts('', 443, 'JP').icon, '', '空 IP 无图标');
  eq(S.peerParts(null, 443, 'JP').text, '', 'null IP 不抛异常');
}

process.exit(report('services.test'));
