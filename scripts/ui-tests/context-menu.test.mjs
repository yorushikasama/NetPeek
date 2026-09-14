// 右键菜单与「可复制的值」的单测（context-menu.js 的纯逻辑部分）。
//
// 为什么值得测：这个模块的失败方式全都是「看起来成功了」——
//   · 路径里的零宽空格没抹掉 → 复制成功、粘出来一模一样、粘进命令行报「找不到路径」
//   · 数值与单位之间的空格没补回 → 复制成功、粘出来是「1.23MB/s」这种连在一起的串
//   · 值里的制表符没抹掉 → 复制成功、粘进 Excel 整行错列，看着像数据错乱而不像复制失败
//   · 「—」被当成值 → 菜单里多出一个「复制空内容」的入口
// 四条都不会抛异常，所以只能靠断言钉住。

import { makeWith, eq, ok, section, report } from './_harness.mjs';

function api() {
  return makeWith(
    'context-menu.js',
    ['stripInvisible', 'isEditableTarget', 'joinUnit', 'cellText', 'tsvRow',
      'clampPos', 'preview', 'menuModel', 'fieldValue', 'copyLabel'],
    {},
  );
}

const C = api();

/** 只实现 fieldValue / copyLabel 用到的那几处的最小元素替身。 */
function fakeEl(attrs, text, prev) {
  return {
    textContent: text == null ? '' : text,
    previousElementSibling: prev || null,
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
  };
}

section('stripInvisible 抹掉零宽字符');
{
  eq(C.stripInvisible('C:\\app\\\u200bnetpeek.exe'), 'C:\\app\\netpeek.exe', '零宽空格（检查栏路径的断行符）');
  eq(C.stripInvisible('\ufeff1.2.3.4'), '1.2.3.4', 'BOM');
  eq(C.stripInvisible('a\u200eb\u200fc'), 'abc', 'LRM / RLM');
  eq(C.stripInvisible('  1.2.3.4  '), '  1.2.3.4  ', '普通空白不动（该由调用方 trim）');
  eq(C.stripInvisible(null), '', 'null 不抛');
  eq(C.stripInvisible(undefined), '', 'undefined 不抛');
  eq(C.stripInvisible(0), '0', '数字也吃');
}

section('isEditableTarget 只豁免文本输入');
{
  eq(C.isEditableTarget('INPUT', false, 'text'), true, '文本输入');
  eq(C.isEditableTarget('input', false, null), true, '没写 type 默认 text');
  eq(C.isEditableTarget('input', false, 'TEXT'), true, 'type 大小写');
  eq(C.isEditableTarget('INPUT', false, 'search'), true, '搜索框（有剪切粘贴需求）');
  eq(C.isEditableTarget('INPUT', false, 'password'), true, 'API Key');
  eq(C.isEditableTarget('INPUT', false, 'number'), true, '数字输入');
  eq(C.isEditableTarget('INPUT', false, 'date'), true, '日期输入');
  eq(C.isEditableTarget('TEXTAREA', false, null), true, '多行输入');
  eq(C.isEditableTarget('DIV', true, null), true, 'contenteditable');
  eq(C.isEditableTarget('INPUT', false, 'checkbox'), false, '勾选框：系统菜单只有噪音');
  eq(C.isEditableTarget('INPUT', false, 'range'), false, '滑杆');
  eq(C.isEditableTarget('INPUT', false, 'color'), false, '取色器');
  eq(C.isEditableTarget('DIV', false, null), false, '普通元素');
  eq(C.isEditableTarget('BUTTON', false, null), false, '按钮');
  eq(C.isEditableTarget(null, false, null), false, '空标签名不抛');
}

section('joinUnit / cellText 补回数值与单位之间的空格');
{
  eq(C.joinUnit('1.23', 'MB/s'), '1.23 MB/s', '速率');
  eq(C.joinUnit('3.2', 'GB'), '3.2 GB', '总量');
  eq(C.joinUnit('12', ''), '12', '没有单位时不补空格');
  eq(C.joinUnit(' 1.2 ', '  GB  '), '1.2 GB', '两侧空白先 trim');

  eq(C.cellText('1.23MB/s', 'MB/s'), '1.23 MB/s', '速率格子');
  eq(C.cellText('500B/s', 'B/s'), '500 B/s', '不足 1KB 的档');
  eq(C.cellText('3.2GB', 'GB'), '3.2 GB', '近 24 小时格子');
  eq(C.cellText('msedge×3', ''), 'msedge×3', '纯文本列原样');
  eq(C.cellText('—', ''), '—', '空值原样');
  eq(C.cellText('1.2GB', 'MB/s'), '1.2GB', '单位对不上时不硬拼（不许出现「1.2GB MB/s」）');
}

section('tsvRow 抹掉会破坏列结构的字符');
{
  eq(C.tsvRow(['a', 'b', 'c']), 'a\tb\tc', '常规一行');
  eq(C.tsvRow(['a\tb', 'c']), 'a b\tc', '值里的制表符变空格（否则整行错列）');
  eq(C.tsvRow(['a\nb', 'c']), 'a b\tc', '值里的换行变空格');
  eq(C.tsvRow(['a\r\nb', 'c']), 'a b\tc', 'CRLF 一起处理');
  eq(C.tsvRow([' 1 ', ' — ']), '1\t—', '每格各自 trim');
  eq(C.tsvRow(['C:\\a\\\u200bb.exe', 'x']), 'C:\\a\\b.exe\tx', '顺手抹零宽字符');
  eq(C.tsvRow([]), '', '空数组');
  eq(C.tsvRow(null), '', 'null 不抛');
  eq(C.tsvRow(['', '', '', '', '', '']).split('\t').length, 6, '六列全空也保持六列');
}

section('clampPos 把菜单收回视口');
{
  const o = { x: 10, y: 10, w: 200, h: 100 };
  eq(JSON.stringify(C.clampPos(10, 10, o.w, o.h, 1280, 800)), JSON.stringify({ x: 10, y: 10 }), '常规位置不动');
  eq(JSON.stringify(C.clampPos(1270, 790, o.w, o.h, 1280, 800)), JSON.stringify({ x: 1072, y: 692 }), '右下角回收（留 8px）');
  eq(JSON.stringify(C.clampPos(-50, -50, o.w, o.h, 1280, 800)), JSON.stringify({ x: 8, y: 8 }), '左上角回收（留 8px）');
  eq(JSON.stringify(C.clampPos(9999, 9999, 2000, 2000, 1280, 800)), JSON.stringify({ x: 8, y: 8 }), '菜单比视口大时收到 pad 上');
  eq(JSON.stringify(C.clampPos(100, 100, 200, 100, 1280, 800, 0)), JSON.stringify({ x: 100, y: 100 }), 'pad 可传 0');
  eq(JSON.stringify(C.clampPos(0, 0, 10, 10, 0, 0)), JSON.stringify({ x: 8, y: 8 }), '视口为 0 也不出负数');
  eq(C.clampPos(10.6, 10.4, 10, 10, 800, 600).x, 11, '取整');
}

section('preview 折叠与截断');
{
  eq(C.preview('1.2.3.4:443'), '1.2.3.4:443', '短文本原样');
  eq(C.preview('a\nb'), 'a b', '换行折成空格');
  eq(C.preview('  多  空白  '), '多 空白', '连续空白折成一个');
  eq(C.preview('abcdefghij', 5), 'abcd…', '截断长度含省略号');
  eq(C.preview('abcde', 5), 'abcde', '正好等长不截');
  eq(C.preview('a\u200bb', 10), 'ab', '零宽字符先抹');
  eq(C.preview(null), '', 'null 不抛');
}

section('menuModel · 选中内容置顶');
{
  const m = C.menuModel({ selection: '  1.2.3.4  ' });
  eq(m.length, 1, '只有选中内容时一项');
  eq(m[0].id, 'selection', 'id');
  eq(m[0].label, '复制选中内容', '文案');
  eq(m[0].value, '1.2.3.4', '值已 trim');
  eq(m[0].sub, '1.2.3.4', '右列预览');
}

section('menuModel · 命中具体字段');
{
  const m = C.menuModel({ fields: [{ id: 'field', label: '对端地址', value: '23.4.5.6:443（HTTPS）' }] });
  eq(m.length, 1, '一项');
  eq(m[0].label, '复制对端地址', '标签拼在「复制」后面');
  eq(m[0].value, '23.4.5.6:443（HTTPS）', '完整值（不是格子里的省略形态）');

  const blank = C.menuModel({ fields: [{ label: '对端地址', value: '—' }] });
  eq(blank.length, 0, '「—」不提供复制入口');

  const empty = C.menuModel({ fields: [{ label: '路径', value: '' }] });
  eq(empty.length, 0, '空值同上');

  const noLabel = C.menuModel({ fields: [{ value: 'x' }] });
  eq(noLabel[0].label, '复制', '没标签时就两个字，不出现「复制undefined」');
}

section('menuModel · 表格行');
{
  const row = {
    cells: [
      { key: 'name', label: '应用', value: 'msedge×3' },
      { key: 'peer', label: '对端', value: '—' },
      { key: 'pid', label: 'PID', value: '1204' },
    ],
    tsv: C.tsvRow(['msedge×3', '—', '1204']),
  };
  const m = C.menuModel({ row });
  const labels = m.map((i) => i.label);
  eq(labels.length, 4, '两项有值 + 分隔线 + 整行');
  eq(labels[0], '复制应用');
  eq(labels[1], '复制PID', '表头文案直接进标签（不加空格）');
  eq(labels[2], undefined, '第三项是分隔线，没有文案');
  eq(labels[3], '复制整行（制表符分隔）');
  ok(m[2].sep === true, '第三个位置是分隔线');
  eq(m.filter((i) => i.sep).length, 1, '分隔线只有一根');
  eq(m[3].value, 'msedge×3\t—\t1204', '整行含全部列，空值也占位');
}

section('menuModel · 字段与整行并存');
{
  const row = { cells: [{ key: 'name', label: '应用', value: 'chrome' }], tsv: 'chrome' };
  const m = C.menuModel({ fields: [{ label: '对端地址', value: '1.1.1.1:443' }], row });
  eq(m.length, 3, '字段一项 + 分隔线 + 整行');
  eq(m[0].label, '复制对端地址');
  ok(m[1].sep === true, '中间是分隔线');
  eq(m[2].id, 'row', '整行在最后');
}

section('menuModel · 逐列项只在没命中字段时展开');
{
  const row = {
    cells: [
      { key: 'name', label: '应用', value: 'chrome' },
      { key: 'peer', label: '对端', value: '1.1.1.1' },
    ],
    tsv: 'chrome\t1.1.1.1',
  };
  const withField = C.menuModel({ fields: [{ label: '对端地址', value: '1.1.1.1' }], row });
  eq(withField.filter((i) => String(i.id).startsWith('cell:')).length, 0, '命中字段时不铺六列');

  const noField = C.menuModel({ row });
  eq(noField.filter((i) => String(i.id).startsWith('cell:')).length, 2, '落在行上才铺开各列');
  eq(noField[1].id, 'cell:peer', 'id 带列键');
}

section('menuModel · 行里没有可复制值');
{
  const row = { cells: [{ key: 'peer', label: '对端', value: '—' }], tsv: '—' };
  const m = C.menuModel({ row });
  eq(m.length, 1, '只剩整行，不出现空值项');
  eq(m[0].id, 'row', '就是整行');
  ok(!m.some((i) => i.sep), '前面没有东西时不留一根光秃秃的分隔线');
}

section('menuModel · 空输入');
{
  eq(C.menuModel({}).length, 0, '什么都没命中 → 空菜单（调用方据此不弹）');
  eq(C.menuModel(null).length, 0, 'null 不抛');
  eq(C.menuModel({ fields: [], row: null }).length, 0, '空字段空行');
}

section('fieldValue 取值优先级');
{
  eq(C.fieldValue(fakeEl({ 'data-copy': '23.4.5.6:443（HTTPS）' }, '23.4.5.6 · HTTPS')), '23.4.5.6:443（HTTPS）', 'data-copy 优先于 textContent');
  eq(C.fieldValue(fakeEl({ 'data-copy': '' }, '  C:\\a\\b.exe  ')), 'C:\\a\\b.exe', 'data-copy 为空串时退回 textContent');
  eq(C.fieldValue(fakeEl({}, 'C:\\a\\\u200bb.exe')), 'C:\\a\\b.exe', '退回路径也抹零宽字符');
  eq(C.fieldValue(fakeEl({ 'data-copy': '\u200b' }, 'x')), 'x', 'data-copy 全是零宽字符时同样退回');
}

section('copyLabel 取名规则');
{
  eq(C.copyLabel(fakeEl({ 'data-copy-label': '对端地址' }, 'x')), '对端地址', '显式标签优先');
  eq(C.copyLabel(fakeEl({}, '1.2.3.4', { tagName: 'DT', textContent: '采集服务' })), '采集服务', '检查栏字段取左邻 dt');
  eq(C.copyLabel(fakeEl({}, 'x', { tagName: 'DIV', textContent: '不是 dt' })), '', '左邻不是 dt 就不猜');
  eq(C.copyLabel(fakeEl({}, 'x', null)), '', '没有左邻');
}

process.exit(report('context-menu.test'));
