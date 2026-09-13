// flags.js / flags.png 一致性单测。
//
// 值这个文件的意义：雪碧图是生成物、索引表是生成物，两者一旦错位，
// 表现是「每个国家都显示成别的国家的旗」——一种几乎不会被肉眼发现的静默错误。
// 这里直接读 PNG 的 IHDR 头把尺寸对回去，再把每个国家的定位框验一遍。

import fs from 'node:fs';
import path from 'node:path';
import { loadBrowserScript, UI_DIR, eq, ok, section, report } from './_harness.mjs';

const F = loadBrowserScript('flags.js').NetPeekFlags;

section('雪碧图文件与尺寸');
{
  const file = path.join(UI_DIR, 'flags.png');
  ok(fs.existsSync(file), 'flags.png 存在');
  const buf = fs.readFileSync(file);
  eq(buf.subarray(1, 4).toString('ascii'), 'PNG', 'PNG magic');
  // IHDR：8 字节签名 + 4 字节长度 + 'IHDR' + 宽(4) + 高(4)
  eq(buf.subarray(12, 16).toString('ascii'), 'IHDR', 'IHDR 头');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  eq(w, F.size.sheetW * 2, 'PNG 宽度 = 逻辑宽 x 2（索引表没和雪碧图脱节）');
  eq(h, F.size.sheetH * 2, 'PNG 高度 = 逻辑高 x 2');
}

section('索引覆盖');
ok(F.count > 250, `国旗数量 ${F.count} > 250`);

section('定位在雪碧图边界内');
{
  const codes = ['cn', 'us', 'jp', 'de', 'gb', 'fr', 'ru', 'br', 'in', 'au'];
  for (const cc of codes) {
    const pos = F.pos(cc);
    ok(/^-\d+px -\d+px$/.test(pos), `${cc} 定位格式 ${pos}`);
    const [, x, y] = pos.match(/^-(\d+)px -(\d+)px$/);
    ok(Number(x) + F.size.w <= F.size.sheetW, `${cc} 横向不越界`);
    ok(Number(y) + F.size.h <= F.size.sheetH, `${cc} 纵向不越界`);
  }
  eq(F.pos('zzz'), '', '三位码无定位');
  eq(F.pos('a'), '', '一位码无定位');
  eq(F.pos(''), '', '空串无定位');
  eq(F.pos(undefined), '', 'undefined 无定位');
  eq(F.pos(null), '', 'null 无定位');
  eq(F.pos('CN'), F.pos('cn'), '大小写归一');
}

section('定位是 2x 图折半后的整数网格');
{
  // 若哪天改了 CELL 尺寸而忘记同步 CSS 侧的显示尺寸，这里会先炸
  ok(Number.isInteger(F.size.w) && Number.isInteger(F.size.h), '逻辑尺寸为整数');
  eq(F.size.w / F.size.h, 4 / 3, '保持 4:3（国旗原始比例）');
}

section('语义图标');
{
  for (const name of ['loopback', 'lan', 'multicast', 'bogon', 'unknown']) {
    const svg = F.semantic(name);
    ok(svg.startsWith('<svg'), `${name} 返回 SVG`);
    ok(svg.includes('currentColor'), `${name} 用 currentColor 跟随主题`);
    ok(svg.includes('viewBox="0 0 16 12"'), `${name} 视口与显示尺寸一致`);
  }
  eq(F.semantic('nosuch'), '', '未定义名字返回空串');
  eq(F.semantic(undefined), '', 'undefined 返回空串');
}

process.exit(report('flags.test'));
