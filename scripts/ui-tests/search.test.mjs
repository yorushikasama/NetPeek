// main.js 搜索操作符单测。
//
// 搜索从「三个字段 includes」升级成统一前缀语义（=精确 / !=不等于 / !不含 / 默认含），
// 这类解析器最容易在边界上出错：`!` 与 `!=` 的前缀谁先匹配、`=` 后面是空串、
// 用户只敲了一个 `!`。这些都必须有断言，否则表现是「搜索框突然什么都不匹配」。

import { makeWith, loadScripts, eq, section, report } from './_harness.mjs';

const ctx = loadScripts(['flags.js', 'services.js']);
const { parseQuery, matchesQuery, searchFields } = makeWith(
  'main.js',
  ['parseQuery', 'searchFields', 'matchesQuery'],
  { window: ctx },
);

section('parseQuery 前缀解析');
eq(parseQuery(''), null, '空串 → 不过滤');
eq(parseQuery('   '), null, '纯空白 → 不过滤');
eq(parseQuery('!'), null, '只有一个 ! → 不过滤（残输入不该清空列表）');
eq(parseQuery('='), null, '只有一个 = → 不过滤');
eq(parseQuery('!='), null, '只有 != → 不过滤');
eq(parseQuery('!   '), null, '! 后只剩空白 → 不过滤');

eq(parseQuery('chrome').op, 'has', '默认包含');
eq(parseQuery('chrome').body, 'chrome');
eq(parseQuery('=chrome.exe').op, 'eq', '= 精确');
eq(parseQuery('=chrome.exe').body, 'chrome.exe');
eq(parseQuery('!=chrome.exe').op, 'ne', '!= 不等于（必须先于 ! 匹配）');
eq(parseQuery('!=chrome.exe').body, 'chrome.exe');
eq(parseQuery('!chrome').op, 'not', '! 不包含');
eq(parseQuery('!chrome').body, 'chrome');
eq(parseQuery('CHROME').body, 'chrome', '大小写归一');
eq(parseQuery('  =  chrome  ').body, 'chrome', '两侧空白剥掉');
// 只认最前面一个操作符：避免搜索框变成需要背规则的查询语言
eq(parseQuery('!a=b').op, 'not', '`!a=b` 按「不含 a=b」处理');
eq(parseQuery('!a=b').body, 'a=b');
eq(parseQuery('!=a=b').op, 'ne', '`!=a=b` 按「不等于 a=b」处理');

section('维度覆盖');
{
  const p = {
    Name: 'chrome.exe', Path: 'C:\\Program Files\\Google\\chrome.exe', Pid: 4321,
    TopRemoteIp: '142.250.196.100', TopRemotePort: 443, TopRemoteCountry: 'JP',
  };
  const fields = searchFields(p).map((v) => v.toLowerCase());
  eq(fields.includes('chrome.exe'), true, '应用名');
  eq(fields.includes('c:\\program files\\google\\chrome.exe'), true, '完整路径');
  eq(fields.includes('4321'), true, 'PID');
  eq(fields.includes('142.250.196.100'), true, '对端 IP');
  eq(fields.includes('443'), true, '端口');
  eq(fields.includes('https'), true, '服务名（端口反查）');
  eq(fields.includes('jp'), true, '国家码');

  const lan = searchFields({ Name: '', Pid: 9, TopRemoteIp: '192.168.1.5', TopRemotePort: 445 });
  eq(lan.includes('局域网'), true, '保留地址的语义标签也参与搜索');
}

section('matchesQuery 语义');
{
  const chrome = {
    Name: 'chrome.exe', Path: 'C:\\chrome.exe', Pid: 100,
    TopRemoteIp: '142.250.196.100', TopRemotePort: 443, TopRemoteCountry: 'JP',
  };
  const code = {
    Name: 'Code.exe', Path: 'D:\\Code.exe', Pid: 200,
    TopRemoteIp: '20.205.243.166', TopRemotePort: 443, TopRemoteCountry: 'US',
  };

  eq(matchesQuery(chrome, parseQuery('chrome')), true, '包含：命中');
  eq(matchesQuery(code, parseQuery('chrome')), false, '包含：未命中');
  eq(matchesQuery(chrome, parseQuery('https')), true, '按服务名搜');
  eq(matchesQuery(code, parseQuery('https')), true, '服务名维度与进程无关');
  eq(matchesQuery(chrome, parseQuery('jp')), true, '按国家码搜');

  eq(matchesQuery(chrome, parseQuery('=chrome.exe')), true, '精确：完全相等才算');
  eq(matchesQuery(chrome, parseQuery('=hrome')), false, '精确：子串不算');
  eq(matchesQuery(code, parseQuery('=code.exe')), true, '精确：大小写不敏感');

  eq(matchesQuery(code, parseQuery('!chrome')), true, '不含：另一个进程通过');
  eq(matchesQuery(chrome, parseQuery('!chrome')), false, '不含：自己排除');

  eq(matchesQuery(code, parseQuery('!=chrome.exe')), true, '不等于：名字不同');
  eq(matchesQuery(chrome, parseQuery('!=chrome.exe')), false, '不等于：名字相同被排除');
  // 关键区别：≠ 是「没有任一维度等于」，! 是「没有任何维度包含」
  eq(matchesQuery(chrome, parseQuery('!=443')), false, '不等于：端口维度的值不等于 443');

  eq(matchesQuery(chrome, null), true, '空查询放行全部');
}

process.exit(report('search.test'));
