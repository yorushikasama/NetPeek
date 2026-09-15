// 临时探针：找出「薄面板（op 0.30/0.45）在原地达标」需要动哪个杠杆。
// 上一版探针已证明明度带不是瓶颈（合成面已经很亮），真正的瓶颈是弱字阶 text3：
// 它在纯面板上刚好卡在 APCA 40，面板一被稀释就先失守，于是地板被抬到 0.86。
// 这里扫两件事：① text3 往黑里再压多少；② 透镜亮度再抬多少。都不改被测代码。
import { loadScripts } from './_harness.mjs';

const T = loadScripts(['vendor/chroma.min.js', 'theme.js']).NetPeekTheme;
const r3 = (v) => Math.round(v * 1000) / 1000;
const hex = (c) => '#' + ['r', 'g', 'b'].map((k) => Math.round(c[k]).toString(16).padStart(2, '0')).join('');
const darken = (h, k) => {
  const c = T.hexToRgb(h);
  return hex({ r: c.r * (1 - k), g: c.g * (1 - k), b: c.b * (1 - k) });
};

// 用户那张近黑壁纸派生出来的浅色皮肤（审计里实测的那套值）
const core = {
  bg: '#f5e4df', panel: '#f8eeeb', text: '#2a2c30',
  down: '#8d5621', up: '#39668f', ok: '#1f6f44', warn: '#8a6608',
  error: '#b3352b', accent: '#2a2c30',
};
const base = T.expandTokens(core, { tightRamp: true });
console.log('tokens=' + JSON.stringify(base));
console.log('panelLum=' + r3(T.luminance(T.hexToRgb(base.panel)))
  + ' text2=' + base.text2 + ' text3=' + base.text3);

const scrim = 0.09;
console.log('--- ① text3 再压暗一点：地板与三档 Lc ---');
for (const k of [0, 0.06, 0.12, 0.18, 0.24, 0.3, 0.4]) {
  const tok = { ...base, text3: darken(base.text3, k) };
  const f0 = T.backdropFloor(tok, 0.0, scrim);
  const f14 = T.backdropFloor(tok, 0.0014, scrim);
  const cells = [0.3, 0.45].map((op) => {
    const eff = T.effectivePanel(tok, 0.0014, scrim, op);
    return `op${op}[${[tok.text, tok.text2, tok.text3].map((f) => Math.round(Math.abs(T.apcaLc(f, eff)))).join('/')}]`;
  });
  console.log(`k=${k} text3=${tok.text3} floor0=${f0} floor0014=${f14} ${cells.join(' ')}`);
}

console.log('--- ② 透镜更亮一档（c 按「斜率 0.2 固定」同步缩小）---');
const orig = T.LENS.light;
for (const [c, b] of [[orig.contrast, orig.brightness], [0.105, 1.90], [0.095, 2.10], [0.088, 2.30]]) {
  T.LENS.light.contrast = c; T.LENS.light.brightness = b;
  const f = (v) => T.luminance(T.lensApply({ r: v * 255, g: v * 255, b: v * 255 }, T.LENS.light));
  const f0 = T.backdropFloor(base, 0.0, scrim);
  const eff = T.effectivePanel(base, 0.0014, scrim, 0.3);
  console.log(`c=${c} b=${b} band=[${r3(f(0))},${r3(f(1))}] floor0=${f0} `
    + `lc@0.3=${[base.text, base.text2, base.text3].map((x) => Math.round(Math.abs(T.apcaLc(x, eff)))).join('/')}`);
}
T.LENS.light.contrast = orig.contrast;
T.LENS.light.brightness = orig.brightness;

console.log('--- ③ 只把弱字阶档位下调到 35/30 会怎样（仅看数，不改档）---');
for (const min of [40, 35, 30]) {
  const eff = T.effectivePanel(base, 0.0014, scrim, 0.3);
  const lc = Math.abs(T.apcaLc(base.text3, eff));
  console.log(`text3 档 ${min}: 实测 ${r3(lc)} ${lc >= min ? '过' : '不过'} → 地板 ${T.backdropFloor(base, 0.0014, scrim)}`);
  break;
}
