// settings-ui.js 单测：国家/地区库状态文案。
//
// 值这个文件的意义：这段文案是用户判断「我的国家数据是不是过时了」的唯一依据。
// 内嵌库「发版即冻结」这个事实必须写出来，否则用户只会觉得识别不准，不知道该换库。
// 另外「用回内置库」按钮的可用态是跟着实际模式走的，点错会让人以为没生效。

import { loadScripts, eq, section, report } from './_harness.mjs';

// settings-ui.js 顶层就要摸 document.getElementById，给个空桩即可（不触发任何交互）。
const stub = { getElementById: () => null };
const UI = loadScripts(['settings-ui.js'], { document: stub }).NetPeekSettingsUI;

section('geoDbLabel 内嵌库');
{
  const v = UI.geoDbLabel({ mode: 'builtin', database_type: 'DBIP-Country-Lite', build_date: '2026-09-01' });
  eq(v.text, '内嵌 DB-IP 库 · 构建于 2026-09-01', '写明是内嵌库与构建日期');
  eq(v.className, 'note', '内嵌库不是异常态');
  eq(v.canReset, false, '本来就在用内置库，不该给「用回内置库」入口');
}

section('geoDbLabel 自定义库');
{
  const v = UI.geoDbLabel({
    mode: 'custom', database_type: 'GeoLite2-Country', build_date: '2026-08-15', path: 'D:\\geo\\x.mmdb',
  });
  eq(v.text, '自定义库：GeoLite2-Country · 构建于 2026-08-15', '写明库类型与日期');
  eq(v.className, 'note is-ok', '成功切换是正常态');
  eq(v.title, 'D:\\geo\\x.mmdb', '悬浮显示完整路径');
  eq(v.canReset, true, '自定义库才允许切回内置');
}

section('geoDbLabel 内嵌库损坏');
{
  const v = UI.geoDbLabel({ mode: 'broken', database_type: '', build_date: '', node_count: 0 });
  eq(v.text, '内嵌国家库不可用，对端国家将全部显示为未知', '坏掉时要说清后果');
  eq(v.className, 'note is-error', '按错误态显示');
  eq(v.canReset, false, '没有可用库，切回内置没有意义');
}

section('geoDbLabel 缺字段与非法输入');
{
  // 缺 build_date：不该印出「构建于 」这种半截话
  const v = UI.geoDbLabel({ mode: 'builtin' });
  eq(v.text, '内嵌 DB-IP 库', '缺日期时不补空话');
  okType(UI.geoDbLabel({ mode: 'custom' }).text, 'string', '缺 database_type 不抛异常');
  eq(UI.geoDbLabel(null).className, 'note is-warn', 'null → 降级态');
  eq(UI.geoDbLabel(undefined).canReset, false, 'undefined → 不允许重置');
  eq(UI.geoDbLabel('nonsense').className, 'note is-warn', '字符串输入不当对象用');
}

function okType(value, type, label) {
  eq(typeof value, type, label);
}

process.exit(report('settings.test'));
