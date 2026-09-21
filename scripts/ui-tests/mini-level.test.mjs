// 能量球水位映射（levelOf）的单测：单调、连续、可读。
//
// 为什么单独测这个：水位是球上**唯一**的图形化读数（两个数字是精确值，
// 水位是"一眼看出量级"的那一维）。它现在是一个分段对数映射，
// 三处容易出错且都不会报错、只会让球看起来"怪"：
//   ① 不单调 —— 速率涨了水位反而跌（第一版固定档位就是这样，跳幅 0.87–0.92）；
//   ② 不连续 —— 档位边界上水位断一截（视觉上是"闪一下"）；
//   ③ 常数写歪 —— TIERS 与 ANCHORS 对不上长度，映射塌掉。
//
// 历史（2026-09-21 用户提出「另一个也实现」即指此）：
//   峰值做分母 → 浮动刻度，量出来的数没意义；
//   固定档位做分母 → 跨档水位掉 90%；
//   现在 → 档位当锚点、档内对数插值。

import { readUi, eq, ok, section, report } from './_harness.mjs';

const src = readUi('mini.js');

// 从源码里取真实常量，而不是在测试里抄一份 —— 抄一份的话，
// 改了源码而忘了改测试，测的还是旧刻度（这条自己也成了"哑失败"）。
function constArray(name) {
  const m = src.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]+)\\]`));
  if (!m) throw new Error(`未找到常量 ${name} —— 改名后请同步更新测试`);
  return m[1].split(',').map((x) => Number(x.trim()));
}
const TIERS = constArray('TIERS');
const ANCHORS = constArray('ANCHORS');

// 把 levelOf 的源码抽出来，用真实常量在干净上下文里跑
const levelFn = new Function('TIERS', 'ANCHORS',
  `${src.slice(src.indexOf('function levelOf('), src.indexOf('\n  }', src.indexOf('function levelOf(')) + 4)}
   return levelOf;`);
const levelOf = levelFn(TIERS, ANCHORS);

// ---------- 常量本身 ----------

section('刻度常量：档位与锚点一一对应');
{
  eq(ANCHORS.length, TIERS.length, '每个档位都要有一个锚点水位');
  eq(ANCHORS[ANCHORS.length - 1], 1, '最末档对应满格');
  ok(ANCHORS.every((a, i) => i === 0 || a > ANCHORS[i - 1]), '锚点严格递增');
  ok(ANCHORS.every((a) => a > 0 && a <= 1), '锚点都落在 0–1');
  ok(TIERS.every((t, i) => i === 0 || t > TIERS[i - 1]), '档位严格递增');
}

// ---------- 单调 ----------

section('levelOf：速率涨，水位只涨不跌（单调）');
{
  // 跨 8 个量级扫一遍：任何一处回落都是"跨档掉水"那类 bug 的复活
  let prev = -1;
  let worst = null;
  for (let e = 2; e <= 9.4; e += 0.01) {
    const bps = Math.pow(10, e);
    const v = levelOf(bps);
    if (v < prev - 1e-12) { worst = { bps, v, prev }; break; }
    prev = v;
  }
  ok(worst === null,
    worst ? `水位在 ${worst.bps.toExponential(2)} 处回落：${worst.prev} → ${worst.v}` : '全量程单调');

  // 最刺眼的那一处：旧版刚过 1 MB/s 会从 1.000 掉到 0.080
  ok(levelOf(1.0001e6) >= levelOf(0.9999e6) - 1e-9,
    '跨过 1 MB/s 时水位不回落（旧版在这里掉 0.92 个满量程）');
}

// ---------- 连续 ----------

section('levelOf：档位边界处连续（无跳变）');
{
  for (const t of TIERS) {
    const below = levelOf(t * 0.9999);
    const above = levelOf(t * 1.0001);
    ok(Math.abs(above - below) < 0.002,
      `过 ${t} 时水位连续（${below.toFixed(4)} → ${above.toFixed(4)}）`);
  }
}

// ---------- 锚点确实被命中 ----------

section('levelOf：档位处正好落在对应锚点');
{
  TIERS.forEach((t, i) => {
    eq(Number(levelOf(t).toFixed(6)), Number(ANCHORS[i].toFixed(6)),
      `${t} 处水位 = 第 ${i + 1} 个锚点 ${ANCHORS[i]}`);
  });
  eq(levelOf(TIERS[TIERS.length - 1] * 10), 1, '超过最末档：满格而不是溢出');
}

// ---------- 边界 ----------

section('levelOf：零与负值给 0，极低速不抖');
{
  eq(levelOf(0), 0, '速率为 0 → 空球');
  eq(levelOf(-1), 0, '负值（不该出现）也当 0，不给 NaN');
  eq(levelOf(NaN), 0, 'NaN 不传染');

  // 极低速段（后台心跳那一档）必须是温和的：不做对数，避免几 KB/s 的抖动
  // 让水位乱跳。这里验斜率有界。
  const a = levelOf(2e3);
  const b = levelOf(4e3);
  ok(b - a > 0 && b - a < 0.01,
    `几 KB/s 的变化只带来很小的水位变化（${a.toFixed(4)} → ${b.toFixed(4)}）`);
  ok(levelOf(64e3) < 0.06, '64 KB/s 仍在球底附近（低于第一档）');
}

// ---------- 可读性：水位要能反推量级 ----------

section('levelOf：关键量级的水位落在可区分的档位上');
{
  // 这些是"带宽量级"的锚点，水位要一眼能分辨，不能糊成一片
  const pts = [
    [128e3, 0.10], [1e6, 0.28], [12.5e6, 0.52], [125e6, 0.76],
  ];
  for (const [bps, want] of pts) {
    eq(Number(levelOf(bps).toFixed(2)), want, `${bps} → ${want}`);
  }
  // 日常最关心的 1–100 MB/s 区间要占到球腔的一半以上，否则读不出差别
  ok(levelOf(100e6) - levelOf(1e6) > 0.4,
    `1 MB/s → 100 MB/s 跨过 ${(levelOf(100e6) - levelOf(1e6)).toFixed(2)} 个水位高度`);
}

process.exit(report('mini-level.test'));
