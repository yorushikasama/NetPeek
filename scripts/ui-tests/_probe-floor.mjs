// 临时探针（数值定案用）：透镜定案后，用「真实的派生 light 皮肤」（tokensFromImage
// 那条 pipeline 的产物，不是手写出厂 light 皮肤）扫全亮度带，确认地板是否退到下限。
import { loadScripts } from './_harness.mjs';

const T = loadScripts(['vendor/chroma.min.js', 'theme.js']).NetPeekTheme;
const r3 = (v) => Math.round(v * 1000) / 1000;

const coreLight = {
  bg: '#f5e4df', panel: '#f8eeeb', text: '#2a2c30',
  down: '#8d5621', up: '#39668f', ok: '#1f6f44', warn: '#8a6608',
  error: '#b3352b', accent: '#2a2c30',
};
const coreDark = {
  bg: '#161418', panel: '#1c191d', text: '#f2ecea',
  down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567',
  error: '#e57373', accent: '#f2ecea',
};
const L = T.expandTokens(coreLight, { tightRamp: true });
const D = T.expandTokens(coreDark, { tightRamp: true });

console.log('light tokens=' + JSON.stringify(L));
console.log('dark  tokens=' + JSON.stringify(D));

const fl = (v) => T.luminance(T.lensApply({ r: v * 255, g: v * 255, b: v * 255 }, T.LENS.light));
const fd = (v) => T.luminance(T.lensApply({ r: v * 255, g: v * 255, b: v * 255 }, T.LENS.dark));
console.log(`lens light band=[${r3(fl(0))},${r3(fl(1))}] span=${r3(fl(1) - fl(0))}`);
console.log(`lens dark  band=[${r3(fd(0))},${r3(fd(1))}] span=${r3(fd(1) - fd(0))}`);

const LS = [0, 0.0014, 0.02, 0.06, 0.12, 0.3, 0.6, 0.92, 1.0];
console.log('--- 派生浅色皮肤（真实路径）：floor @ scrim 0.09 ---');
for (const x of LS) {
  const f = T.backdropFloor(L, x, 0.09);
  const g = T.backdropGuard(L, x, 0.09, 0.30);
  const row = [0.30, 0.40, 0.45, 0.62].map((op) => {
    const eff = T.effectivePanel(L, x, 0.09, op);
    return `${op}:[${[L.text, L.text2, L.text3].map((c) => Math.round(Math.abs(T.apcaLc(c, eff)))).join('/')}]`;
  });
  console.log(`L=${x} floor=${f} guard=${g.floor}/a${g.autoDim} ${row.join(' ')}`);
}
console.log('--- 派生深色皮肤：floor @ scrim 0.30 ---');
for (const x of LS) {
  const f = T.backdropFloor(D, x, 0.30);
  const g = T.backdropGuard(D, x, 0.30, 0.30);
  const eff = T.effectivePanel(D, x, 0.30, 0.40);
  console.log(`L=${x} floor=${f} guard=${g.floor}/a${g.autoDim} lc@0.4=[`
    + `${[D.text, D.text2, D.text3].map((c) => Math.round(Math.abs(T.apcaLc(c, eff)))).join('/')}]`);
}
console.log('--- panel-2 档的分量（为什么它是瓶颈）---');
console.log(`light panel=${L.panel} panel2=${L.panel2}`);
