// 生成 ui/flags.png（国旗雪碧图）+ ui/flags.js（索引与语义图标）。
//
// 为什么不用 emoji：Windows 的 Segoe UI Emoji 故意不含国旗字形（微软为规避政治争议），
// 区域指示符对（U+1F1E6–U+1F1FF）在 Windows 上恒渲染成两个字母——浏览器、WebView2、
// Electron 一律如此。所以要真正显示出旗帜，只能自己带图片资源。
//
// 为什么是栅格图而不是内嵌 SVG：flag-icons 的 4x3 SVG 合计 2.0 MB（塞尔维亚一面就 184 KB，
// 全是国徽路径数据），而我们的显示尺寸只有 16x12 逻辑像素——那些细节一个像素都落不下去。
// 栅格化成 32x24 后整包只有几十 KB，且运行时零解析开销。
//
// 用法：node scripts/gen-flags.mjs
// 依赖：@resvg/resvg-js（仅构建期）、系统 tar。产物已入库，日常构建不需要跑这个脚本。
// 图标来源：flag-icons（MIT），https://github.com/lipis/flag-icons

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const UI = path.join(REPO, 'src/NetPeek.App/ui');
const CACHE = path.join(REPO, '.workbuddy/tmp');

const FLAG_ICONS_VERSION = '7.2.3';
const TARBALL_URL = `https://registry.npmjs.org/flag-icons/-/flag-icons-${FLAG_ICONS_VERSION}.tgz`;

// 单元格 32x24 = 显示尺寸 16x12 的 2 倍图，够 200% 缩放清晰。
const CELL_W = 32;
const CELL_H = 24;
const COLS = 16;

// 语义图标（非国家）：与国旗不同，它们必须跟随主题文字色，所以用内联 SVG + currentColor。
// 对应 Sniffnet countries 模块里 loopback / local / multicast / bogon / unknown 那一组降级链。
const SEMANTIC = {
  loopback: '<rect x="2" y="1.5" width="12" height="7.2" rx="1.2"/><path d="M8 8.7v1.6M5.8 10.6h4.4"/>',
  lan: '<path d="M2.3 5.7 8 1.4l5.7 4.3v4.9a.7.7 0 0 1-.7.7H3a.7.7 0 0 1-.7-.7z"/><path d="M6.4 10.9V7.6h3.2v3.3"/>',
  multicast: '<circle cx="8" cy="10" r="1.15" fill="currentColor" stroke="none"/><path d="M5.3 7.3a3.9 3.9 0 0 1 5.4 0M3.1 5a7 7 0 0 1 9.8 0"/>',
  bogon: '<ellipse cx="8" cy="6" rx="5" ry="4.4"/><path d="M4.5 9.5 11.5 2.5"/>',
  unknown: '<ellipse cx="8" cy="6" rx="5" ry="4.4"/><ellipse cx="8" cy="6" rx="2.2" ry="4.4"/><path d="M3.2 6h9.6"/>',
};

function fetchTarball() {
  fs.mkdirSync(CACHE, { recursive: true });
  const tgz = path.join(CACHE, `flag-icons-${FLAG_ICONS_VERSION}.tgz`);
  if (fs.existsSync(tgz) && fs.statSync(tgz).size > 100_000) {
    console.log(`复用已下载的 ${path.relative(REPO, tgz)}`);
    return tgz;
  }
  console.log(`下载 flag-icons ${FLAG_ICONS_VERSION} ...`);
  execFileSync('curl', ['-sL', '--max-time', '180', '-o', tgz, TARBALL_URL], { stdio: 'inherit' });
  if (!fs.existsSync(tgz) || fs.statSync(tgz).size < 100_000) {
    throw new Error(`下载失败：${TARBALL_URL}`);
  }
  return tgz;
}

function extract(tgz) {
  const out = path.join(CACHE, 'flag-icons');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // 一律用相对路径 + cwd：git-bash 的 GNU tar 对 `D:\...` 这种 Windows 反斜杠路径
  // 会当成转义序列解析，传绝对路径会直接 fatal（exit 2）。
  execFileSync('tar', ['-xzf', path.basename(tgz), '-C', 'flag-icons', 'package/flags/4x3'], {
    cwd: CACHE,
    stdio: 'inherit',
  });
  const dir = path.join(out, 'package/flags/4x3');
  const n = fs.readdirSync(dir).filter((f) => f.endsWith('.svg')).length;
  if (n < 200) throw new Error(`解包结果异常：只拿到 ${n} 个 SVG`);
  return dir;
}

/** 取 <svg ...> 的属性串与内部内容；顺带剥掉注释、title 和 xml 声明。 */
function splitSvg(text) {
  const clean = text
    .replace(/<\?xml[^>]*\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<title>[\s\S]*?<\/title>/g, '');
  const open = clean.match(/<svg\b([^>]*)>/i);
  if (!open) throw new Error('不是 SVG 文件');
  const viewBox = (open[1].match(/viewBox="([^"]+)"/) || [])[1] || '0 0 640 480';
  const start = clean.indexOf('>', clean.indexOf('<svg')) + 1;
  const end = clean.lastIndexOf('</svg>');
  return { viewBox, inner: clean.slice(start, end).trim() };
}

function build() {
  // resvg 是构建期依赖，不进仓库：先按常规解析，再兜底到受管 node 工作目录
  // （WorkBuddy 的隔离工作区，包不允许装进项目）。
  let Resvg;
  const roots = [import.meta.url];
  if (process.env.NETPEEK_NODE_WORKSPACE) {
    roots.push(path.join(process.env.NETPEEK_NODE_WORKSPACE, 'noop.cjs'));
  }
  for (const root of roots) {
    try {
      ({ Resvg } = createRequire(root)('@resvg/resvg-js'));
      break;
    } catch { /* 换下一个解析根 */ }
  }
  if (!Resvg) {
    console.error('缺少 @resvg/resvg-js。安装到受管工作区后重跑：');
    console.error('  cd "%USERPROFILE%\\.workbuddy\\binaries\\node\\workspace" && npm i @resvg/resvg-js');
    console.error('  NETPEEK_NODE_WORKSPACE="%USERPROFILE%\\.workbuddy\\binaries\\node\\workspace" node scripts/gen-flags.mjs');
    process.exit(1);
  }

  const dir = extract(fetchTarball());
  const codes = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.replace(/\.svg$/, ''))
    .sort();

  const rows = Math.ceil(codes.length / COLS);
  // 每个国旗作为嵌套 <svg> 贴进同一张画布：resvg 支持嵌套视口，
  // 一次渲染就得到雪碧图，免去自己写 PNG 合成。
  const parts = codes.map((cc, i) => {
    const { viewBox, inner } = splitSvg(fs.readFileSync(path.join(dir, `${cc}.svg`), 'utf8'));
    const x = (i % COLS) * CELL_W;
    const y = Math.floor(i / COLS) * CELL_H;
    return `<svg x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" viewBox="${viewBox}">${inner}</svg>`;
  });

  const W = COLS * CELL_W;
  const H = rows * CELL_H;
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`;

  const png = new Resvg(sheet, { fitTo: { mode: 'width', value: W } }).render().asPng();
  fs.writeFileSync(path.join(UI, 'flags.png'), png);

  const index = Object.fromEntries(codes.map((cc, i) => [cc, i]));
  const js = `// 本文件由 scripts/gen-flags.mjs 生成，请勿手改。
// 国旗：flags.png 雪碧图（flag-icons ${FLAG_ICONS_VERSION}，MIT），${codes.length} 个 ${CELL_W}x${CELL_H} 单元，
//       按 CSS 背景图定位显示为 ${CELL_W / 2}x${CELL_H / 2} 逻辑像素。
// 语义图标：内联 SVG，走 currentColor 跟随主题。

(function () {
  'use strict';

  const CELL = { w: ${CELL_W}, h: ${CELL_H}, cols: ${COLS}, rows: ${rows}, imgW: ${W}, imgH: ${H} };
  const INDEX = ${JSON.stringify(index)};

  const SEMANTIC = {
${Object.entries(SEMANTIC)
  .map(([k, v]) => `    ${k}: '<svg viewBox="0 0 16 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${v}</svg>',`)
  .join('\n')}
  };

  /** 国家码 → 背景图定位（显示像素，已按 2 倍图折半）；未知国家返回空串。 */
  function pos(cc) {
    const i = INDEX[String(cc || '').toLowerCase()];
    if (i === undefined) return '';
    const x = (i % CELL.cols) * (CELL.w / 2);
    const y = Math.floor(i / CELL.cols) * (CELL.h / 2);
    return \`-\${x}px -\${y}px\`;
  }

  /** 语义图标名 → 内联 SVG 串；名字非法返回空串。 */
  function semantic(name) {
    return SEMANTIC[name] || '';
  }

  window.NetPeekFlags = { pos, semantic, size: { w: CELL.w / 2, h: CELL.h / 2, sheetW: CELL.imgW / 2, sheetH: CELL.imgH / 2 }, count: ${codes.length} };
})();
`;
  fs.writeFileSync(path.join(UI, 'flags.js'), js);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`国旗 ${codes.length} 个 → ${COLS}x${rows} 网格`);
  console.log(`  flags.png ${kb(png.length)}（${W}x${H}）`);
  console.log(`  flags.js  ${kb(Buffer.byteLength(js))}`);
}

build();
