// 端口 → 服务名映射 + 对端地址的语义描述。
// 服务名取自 IANA 端口登记（Sniffnet 同源数据，MIT），这里只挑桌面流量里
// 高频出现的约 150 条：查得到的显示熟名（HTTPS/DNS/QUIC），查不到的显示 :端口。
// 国家码只做校验和转键，真正的旗帜由 flags.js + flags.png（雪碧图）渲染；
// 保留地址另走语义图标，见 bogonLabel / peerParts。

(function () {
  'use strict';

  // 常用 TCP/UDP 端口（IANA 登记 + 桌面软件事实标准 + 少量恶意端口警示名）。
  const PORTS = {
    20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
    53: 'DNS', 67: 'DHCP', 68: 'DHCP', 69: 'TFTP', 80: 'HTTP',
    88: 'Kerberos', 110: 'POP3', 111: 'RPCBind', 113: 'Ident', 119: 'NNTP',
    123: 'NTP', 135: 'RPC', 137: 'NetBIOS-NS', 138: 'NetBIOS-DGM', 139: 'NetBIOS',
    143: 'IMAP', 161: 'SNMP', 162: 'SNMP-Trap', 179: 'BGP', 389: 'LDAP',
    443: 'HTTPS', 444: 'SNPP', 445: 'SMB', 465: 'SMTPS', 500: 'IKE',
    514: 'Syslog', 515: 'LPD', 522: 'MLP', 540: 'UUCP', 548: 'AFP',
    554: 'RTSP', 587: 'SMTP-MSA', 593: 'RPC-HTTP', 623: 'IPMI', 631: 'IPP',
    636: 'LDAPS', 646: 'LDP', 873: 'rsync', 853: 'DoT', 993: 'IMAPS',
    995: 'POP3S', 1080: 'SOCKS', 1143: 'IMAP-ALT', 1194: 'OpenVPN', 1433: 'MSSQL',
    1521: 'Oracle', 1645: 'RADIUS', 1701: 'L2TP', 1723: 'PPTP', 1812: 'RADIUS',
    1863: 'MSN', 1900: 'SSDP', 1935: 'RTMP', 2082: 'cPanel', 2083: 'cPanel-S',
    2181: 'ZooKeeper', 2222: 'SSH-ALT', 2375: 'Docker', 2376: 'Docker-TLS',
    2483: 'Oracle-TNS', 3000: 'Node/Dev', 3128: 'Squid', 3268: 'LDAP-GC',
    3306: 'MySQL', 3389: 'RDP', 3478: 'STUN', 3479: 'STUN', 3690: 'SVN',
    4500: 'IKE-NAT', 5060: 'SIP', 5061: 'SIPS', 5222: 'XMPP', 5223: 'XMPP-TLS',
    5228: 'GCM/FCM', 5353: 'mDNS', 5432: 'PostgreSQL', 5555: 'ADB', 5672: 'AMQP',
    5900: 'VNC', 5938: 'TeamViewer', 6379: 'Redis', 6443: 'K8s-API', 6566: 'SANE',
    6667: 'IRC', 7070: 'RealServer', 8080: 'HTTP-Alt', 8081: 'HTTP-Alt',
    8443: 'HTTPS-Alt', 8888: 'HTTP-Alt', 9000: 'SonarQube', 9042: 'Cassandra',
    9100: 'JetPRN', 9200: 'Elasticsearch', 9418: 'Git', 9443: 'HTTPS-Alt',
    11211: 'Memcached', 27017: 'MongoDB', 27036: 'Steam', 27037: 'Steam',
    31337: 'BackOrifice', 25565: 'Minecraft', 12345: 'NetBus',
    49152: 'RPC-Dyn', 49153: 'RPC-Dyn', 49154: 'RPC-Dyn', 49155: 'RPC-Dyn',
    // QUIC / HTTP3 走 UDP 443，与 TCP 同号不同协议，映射表按端口号不分支足够用
    5355: 'LLMNR', 5357: 'WSD', 5358: 'WSD-S', 6881: 'BT', 6882: 'BT',
    6883: 'BT', 6884: 'BT', 6885: 'BT', 6886: 'BT', 6887: 'BT', 6888: 'BT',
    6889: 'BT', 17500: 'Dropbox', 27015: 'Valve', 27016: 'Valve',
    3074: 'Xbox-Live', 7777: 'Unreal', 11434: 'Ollama', 7890: 'Proxy',
    10809: 'Proxy', 20171: 'Proxy', 23456: 'Proxy',
  };

  // 已知协议名，端口号查不到时按 443→HTTPS 这类兜底已覆盖，不需要额外逻辑。

  function serviceName(port) {
    const p = Number(port) || 0;
    if (p <= 0) return '';
    return PORTS[p] || '';
  }

  // ISO 二字码 → 旗帜**图标键**（小写码），交给 flags.png 雪碧图渲染。
  // 曾经这里返回的是区域指示符 emoji——在 Windows 上是死路：Segoe UI Emoji 故意
  // 不含国旗字形（微软为规避政治争议），U+1F1E6–U+1F1FF 恒渲染成两个字母，
  // 浏览器 / WebView2 / Electron 一律如此，换字体也不可靠。所以旗帜必须自带图片资源。
  function flagKey(cc) {
    if (typeof cc !== 'string') return '';
    const code = cc.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code.toLowerCase() : '';
  }

  // ---- bogon（保留地址）判定 ----
  // 网段表依据 IANA「特殊用途地址登记」，与 Sniffnet 的 bogon.rs 同源（MIT）。
  // 解决的具体问题：对端是内网/回环/组播时，DB-IP 国家库查不出结果，
  // 前端过去只能显示一个光秃秃的 IP；其实信息是充分的——它就是局域网内部流量。
  // 给出语义标签比「未知」有用得多，成本只有一张常量表。
  // 区间用 [起始, 结束] 的 uint32 表示，IPv4 只有 15 段，线性扫描足够快。

  const V4_RANGES = [
    [0x00000000, 0x00ffffff, '保留'],      // 0.0.0.0/8      当前网络
    [0x0a000000, 0x0affffff, '局域网'],    // 10.0.0.0/8
    [0x64400000, 0x647fffff, '运营商NAT'], // 100.64.0.0/10  CGNAT（Tailscale 也用）
    [0x7f000000, 0x7fffffff, '本机'],      // 127.0.0.0/8    回环
    [0xa9fe0000, 0xa9feffff, '链路本地'],  // 169.254.0.0/16 APIPA
    [0xac100000, 0xac1fffff, '局域网'],    // 172.16.0.0/12
    [0xc0000000, 0xc00000ff, '保留'],      // 192.0.0.0/24   IETF 协议分配
    [0xc0000200, 0xc00002ff, '测试'],      // 192.0.2.0/24   TEST-NET-1
    [0xc0586300, 0xc05863ff, '保留'],      // 192.88.99.0/24 6to4 中继（已弃用）
    [0xc0a80000, 0xc0a8ffff, '局域网'],    // 192.168.0.0/16
    [0xc6120000, 0xc613ffff, '测试'],      // 198.18.0.0/15  基准测试
    [0xc6336400, 0xc63364ff, '测试'],      // 198.51.100.0/24 TEST-NET-2
    [0xcb007100, 0xcb0071ff, '测试'],      // 203.0.113.0/24 TEST-NET-3
    [0xe0000000, 0xefffffff, '组播'],      // 224.0.0.0/4
    [0xf0000000, 0xffffffff, '保留'],      // 240.0.0.0/4    （含 255.255.255.255）
  ];

  // IPv6 按「展开成 32 位 hex 后的前缀」匹配，前缀长度一律取 4 的倍数
  // （/7 与 /10 两个非整字节段单独在 classifyV6 里处理）。
  const V6_PREFIXES = [
    ['0'.repeat(20) + 'ffff', 'IPv4映射'], // ::ffff:0:0/96
    ['0064ff9b' + '0'.repeat(16), '隧道'], // 64:ff9b::/96   NAT64
    ['0100' + '0'.repeat(12), '保留'],     // 100::/64       丢弃前缀
    ['20010000', '隧道'],                  // 2001::/32      Teredo
    ['20010db8', '测试'],                  // 2001:db8::/32  文档示例
    ['2002', '隧道'],                      // 2002::/16      6to4
    ['ff', '组播'],                        // ff00::/8
  ];

  function parseV4(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const v = Number(part);
      if (v > 255) return null;
      n = n * 256 + v;
    }
    return n;
  }

  // "fe80::1%12" → "fe80::1"（.NET 的 IPAddress.ToString() 会给链路本地地址带 scope id）
  function stripZone(ip) {
    const i = ip.indexOf('%');
    return i >= 0 ? ip.slice(0, i) : ip;
  }

  // 展开成 32 字符 hex，便于用前缀比较；非法格式返回 null。
  function expandV6(ip) {
    // 尾部写成 IPv4 的形式（::ffff:192.168.1.1）先折算成两组 hex，
    // 否则 '.' 会让后面的分组校验直接判为非法。
    if (ip.includes('.')) {
      const lastColon = ip.lastIndexOf(':');
      const v4 = parseV4(ip.slice(lastColon + 1));
      if (v4 === null) return null;
      ip = ip.slice(0, lastColon + 1)
        + (v4 >>> 16).toString(16).padStart(4, '0')
        + ':'
        + (v4 & 0xffff).toString(16).padStart(4, '0');
    }
    const halves = ip.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if (halves.length === 1 && head.length !== 8) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    const groups = head.concat(Array(fill).fill('0'), tail);
    if (groups.length !== 8) return null;
    if (groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return groups.map((g) => g.padStart(4, '0')).join('').toLowerCase();
  }

  function classifyV4(n) {
    for (const [start, end, label] of V4_RANGES) {
      if (n >= start && n <= end) return label;
    }
    return '';
  }

  function classifyV6(hex) {
    if (hex === '0'.repeat(32)) return '未指定';
    if (hex === '0'.repeat(31) + '1') return '本机';
    // fc00::/7 → 首字节 fc 或 fd；fe80::/10 → fe + 第三位 8~b；两者都不到整字节。
    if (hex.startsWith('fc') || hex.startsWith('fd')) return '局域网';
    if (hex.startsWith('fe') && '89ab'.includes(hex[2])) return '链路本地';
    for (const [prefix, label] of V6_PREFIXES) {
      if (hex.startsWith(prefix)) {
        // IPv4 映射地址（::ffff:192.168.1.1）按内层 IPv4 归类，否则会被当成公网 v6 漏判。
        if (label === 'IPv4映射') {
          const inner = classifyV4(parseInt(hex.slice(24), 16));
          return inner || '';
        }
        return label;
      }
    }
    return '';
  }

  /// 保留地址的语义标签；公网地址返回空串。
  function bogonLabel(ip) {
    if (typeof ip !== 'string' || !ip) return '';
    const addr = stripZone(ip);
    const v4 = parseV4(addr);
    if (v4 !== null) return classifyV4(v4);
    const hex = expandV6(addr);
    return hex ? classifyV6(hex) : '';
  }

  // 保留地址的语义标签 → 语义图标名。图标在 flags.js 里定义（内联 SVG，跟随主题色）。
  // 对应 Sniffnet country_utils 的降级链：loopback→COMPUTER、local→HOME、bogon→BOGON……
  const SEMANTIC_ICON = {
    '本机': 'loopback',
    '局域网': 'lan',
    '链路本地': 'lan',
    '组播': 'multicast',
  };

  /**
   * 对端展示的完整描述（纯函数，不碰 DOM，便于单测）。
   * 返回 { icon, text, title, detail }：
   *   icon   '' | 'sem:xxx' | 二字国家码小写 —— 由调用方翻译成图标节点；
   *   text   单元格里显示的文本，不含图标；
   *   detail 详情行用的紧凑形式 `IP:端口（服务名）`；
   *   title  悬浮提示，信息比可见文本更全。
   *
   * 保留地址不挂国旗（本来也没有国家），改挂语义图标，但**文字前缀仍然保留**
   * （「局域网 192.168.1.1 · SMB」）——图标分不出局域网和链路本地，文字不会丢信息。
   */
  function peerParts(ip, port, cc) {
    if (typeof ip !== 'string' || !ip) return { icon: '', text: '', title: '', detail: '' };
    const p = Number(port) || 0;
    const svc = serviceName(p);
    const tail = svc ? ` · ${svc}` : p > 0 ? ` :${p}` : '';
    const bogon = bogonLabel(ip);

    let icon;
    let text;
    if (bogon) {
      icon = `sem:${SEMANTIC_ICON[bogon] || 'bogon'}`;
      text = `${bogon} ${ip}${tail}`;
    } else {
      // 公网地址：能定位到国家就挂旗帜，定位不到（库缺记录 / 纯离线环境）挂「未知」地球。
      // 显式区分「不知道」和「没有」比留白诚实，也和 Sniffnet 的 Country::ZZ 一致。
      const key = flagKey(cc);
      icon = key ? key : 'sem:unknown';
      text = `${ip}${tail}`;
    }

    const code = flagKey(cc).toUpperCase();
    const detail = `${ip}${p > 0 ? `:${p}` : ''}${svc ? `（${svc}）` : ''}`;
    const title = `${ip}${p > 0 ? `:${p}` : ''}`
      + (svc ? `（${svc}）` : '')
      + (bogon ? ` · ${bogon}` : code ? ` · ${code}` : '');
    return { icon, text, title, detail };
  }

  window.NetPeekServices = { serviceName, flagKey, bogonLabel, peerParts };
})();
