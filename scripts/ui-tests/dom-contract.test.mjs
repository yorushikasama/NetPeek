// DOM 契约单测：HTML 里的 id 与各脚本里的 byId 查找必须对得上。
//
// 为什么值一个测试文件：这份契约横跨 6 个 JS 和 2 个 HTML、共 120 处查找，
// 运行时没有任何一层校验它 —— byId 查不到只是返回 null，直到第一次
// `.textContent =` 才抛，而抛的位置离真正的原因（HTML 少了个节点）很远。
// 症状还常常是「某个读数永远不动」这种不报错的哑失败。
//
// 这次改主题 UI 时就踩了两回：opFloorNote / guardNote / themeEmpty / themeHint
// / wallGrid 在 JS 里写了、HTML 里没加，全靠人工 grep 才发现。
// 这类检查正是 React 那套 JSX 能在编译期给的保证 —— 而这里 60 行就够了，
// 不用引入构建链。
//
// 两个方向都查：
//   1. JS 查了但 HTML 没有 → 静默 null，运行时哑失败（严重）
//   2. HTML 有但没人用 → 死节点（不严重，但也是漂移信号；允许白名单）

import fs from 'node:fs';
import path from 'node:path';
import { UI_DIR, readUi, eq, ok, section, report } from './_harness.mjs';

// 哪些脚本挂在哪个 HTML 上。theme.js 两边都加载，但它自己不查 id（只摸
// documentElement），所以不在这张表里。
const PAGES = {
  'index.html': ['main.js', 'history-ui.js', 'settings-ui.js', 'theme-ui.js'],
  'mini.html': ['mini.js'],
};

/** 抽出 HTML 里所有 id="..."。 */
function htmlIds(file) {
  const src = fs.readFileSync(path.join(UI_DIR, file), 'utf8');
  const ids = new Set();
  for (const m of src.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);
  return ids;
}

/**
 * 抽出脚本里的 id 查找。覆盖三种写法：
 *   $('x')                       —— 各脚本统一的短别名
 *   byId('x', 'owner')           —— common.js 里那份带登记的实现
 *   getElementById('x')          —— 漏网的直接调用
 * 以及选择器里的 #id（querySelector('#skinCards .skin-card') 这类）。
 */
function jsIds(file) {
  const src = readUi(file);
  const ids = new Set();
  for (const m of src.matchAll(/\$\(\s*'([A-Za-z][\w-]*)'\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/byId\(\s*'([A-Za-z][\w-]*)'/g)) ids.add(m[1]);
  for (const m of src.matchAll(/getElementById\(\s*'([A-Za-z][\w-]*)'\s*\)/g)) ids.add(m[1]);
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*'#([A-Za-z][\w-]*)/g)) ids.add(m[1]);
  return ids;
}

// HTML 里存在但 JS 不直接查的 id，逐个说明理由 —— 白名单不写理由就会变成
// 「反正加进去就绿了」的垃圾桶。
const UNREFERENCED_OK = {
  topbar: 'CSS 与截图探针用（styles.css 的 .topbar 规则、preview 脚本定位顶栏）',
  searchBox: 'CSS 布局锚点',
  followSystemNote: '跟随系统的说明文案，静态显示，无交互',
  histCustomApply: '通过表单 submit 触发，不按 id 取',
  ringDownG: 'SVG 渐变，mini.html 的环描边用 url(#ringDownG) 引用',
  ringUpG: 'SVG 渐变，url(#ringUpG) 引用',
  trackG: 'SVG 渐变，url(#trackG) 引用',
};

section('每个 JS 查找的 id 都在对应 HTML 里存在');
{
  for (const [page, scripts] of Object.entries(PAGES)) {
    const have = htmlIds(page);
    for (const js of scripts) {
      const want = jsIds(js);
      const missing = [...want].filter((id) => !have.has(id));
      eq(missing.join(', '), '', `${js} → ${page} 无缺失节点`);
    }
  }
}

section('HTML 里没有未被引用的死 id');
{
  for (const [page, scripts] of Object.entries(PAGES)) {
    const have = htmlIds(page);
    const used = new Set(scripts.flatMap((js) => [...jsIds(js)]));
    // 色板 id（cBg / cPanel / …）是 theme-ui.js 里的常量数组，不是字面量查找，
    // 上面的正则抓不到；它们确实在用，从 SWATCH_IDS 里取。
    const swatch = new Set(
      (readUi('theme-ui.js').match(/SWATCH_IDS\s*=\s*\[([^\]]+)\]/) || [, ''])[1]
        .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    );
    const dead = [...have].filter(
      (id) => !used.has(id) && !swatch.has(id) && !(id in UNREFERENCED_OK),
    );
    eq(dead.join(', '), '', `${page} 无死 id`);
  }
}

section('白名单本身没有过期项');
{
  // 白名单里的 id 如果已经从 HTML 删了，或者反过来 JS 开始查它了，
  // 这条豁免就该拿掉 —— 不然白名单会慢慢变成一份没人敢动的化石。
  const all = new Set([...htmlIds('index.html'), ...htmlIds('mini.html')]);
  for (const id of Object.keys(UNREFERENCED_OK)) {
    ok(all.has(id), `白名单项 ${id} 仍存在于 HTML（否则该删掉这条豁免）`);
  }
}

section('byId 带上了模块名');
{
  // 缺失报告里「谁少了这个节点」全靠第二个参数。漏写不会报错，
  // 只会让日志退化成一串光秃秃的 id。
  for (const js of ['main.js', 'history-ui.js', 'settings-ui.js', 'theme-ui.js', 'mini.js']) {
    const src = readUi(js);
    ok(/byId\(id,\s*'[\w-]+'\)/.test(src), `${js} 的 $() 传了模块名`);
  }
}

section('格式化实现只有一份');
{
  // 收敛到 common.js 之后，其他脚本不该再出现自己的档位表。
  // 这条断言防的是「下次改速率单位时又在某个文件里另写一份」。
  for (const js of ['main.js', 'mini.js', 'history-ui.js']) {
    const src = readUi(js);
    const own = (src.match(/^\s*(?:function\s+)?(?:clampUnit|fmtBytes)\s*\(/gm) || [])
      .filter((s) => !/=>/.test(s));
    // main.js 里 fmtBytes 是薄包装（一行 return _K.fmtBytes），允许；
    // 但不能出现 clampUnit 或多行档位表。
    ok(!/999\s*\?\s*999/.test(src), `${js} 里没有自己的 clampUnit 实现`);
    ok(!/toFixed\(1\)\}\s*KB/.test(src), `${js} 里没有自己的档位表`);
    void own;
  }
}

section('vendor 库必须随页加载');
{
  // theme.js 的色度学与取色委托给 vendor 里的 UMD 构建。加载顺序断在契约里：
  // 标签缺失、或排在 theme.js 之后（用到时还没挂到 window）都会在运行时炸。
  for (const [page, needs] of [
    ['index.html', ['vendor/echarts.min.js', 'vendor/chroma.min.js', 'vendor/color-thief.min.js']],
    ['mini.html', ['vendor/chroma.min.js', 'vendor/color-thief.min.js']],
  ]) {
    const src = fs.readFileSync(path.join(UI_DIR, page), 'utf8');
    for (const v of needs) {
      ok(src.includes(`src="${v}"`), `${page} 引入了 ${v}`);
    }
    const themeAt = src.indexOf('<script src="theme.js">');
    for (const v of needs) {
      ok(src.indexOf(`src="${v}"`) < themeAt, `${page}：${v} 先于 theme.js 加载`);
    }
  }
}

process.exit(report('dom-contract.test'));
