// 临时探针（数值定案用）：自适应透镜（auto-levels）在「近黑、低内对比」壁纸上到底
// 把面板身后的底图拉出多少可见度，以及会不会把可读性地板顶起来。
// 只跑数值、不写断言；定案后把结论写进 theme.test.mjs。
//
// 口径与 theme.lensFromImage 严格对齐：
//   透镜输入 = lensApply( veil( image ) )，veil 用 scrimTint(bg, lightSkin)、浓度用
//   effectiveScrim 的方向化值（CSS 里 --backdrop-dim 就是它）。
//   文字踩的面 = mix(panel, 透镜输出, 不透明度)。
import { loadScripts } from './_harness.mjs';

const S = loadScripts(['vendor/chroma.min.js', 'theme.js']);
const T = S.NetPeekTheme;
const r3 = (v) => Math.round(v * 1000) / 1000;

const coreLight = {
  bg: '#f5e4df', panel: '#f8eeeb', text: '#2a2c30',
  down: '#8d5621', up: '#39668f', ok: '#1f6f44', warn: '#8a6608',
  error: '#b3352b', accent: '#2a2c30',
};
const L = T.expandTokens(coreLight, { tightRamp: true });

const scrimL = T.effectiveScrim(0.3, true);
const veilCh = T.lumToChannel(T.luminance(T.scrimTint(L.bg, true))) / 255;
console.log(`浅色派生：scrim(滑杆 0.3 → 有效 ${scrimL})，纱色通道 ${r3(veilCh)}，`
  + `panel=${L.panel} panel2=${L.panel2}`);
console.log(`固定透镜 light c=${T.LENS.light.contrast} b=${T.LENS.light.brightness}`
  + ` 输出带=${JSON.stringify(T.lensBand(T.LENS.light).map(r3))}`);

const grayPx = (v) => { const c = Math.round(255 * Math.max(0, Math.min(1, v))); return { r: c, g: c, b: c }; };
const channels = (hex) => {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const linOf = (v) => T.luminance(grayPx(v)); // 守卫入参口径：通道 → 线性亮度

// 面板身后「背景」本身（已铺纱 + 已过透镜）的等效灰通道，0..1
function behindCh(lens, v, scrim) {
  const veiled = v + (veilCh - v) * scrim;
  return T.lensApply(grayPx(veiled), lens).r / 255;
}

// 文字实际踩的那块面（面板与身后背景按不透明度合成）
function facePx(tokens, lens, v, scrim, op) {
  const b = behindCh(lens, v, scrim) * 255;
  const p = channels(tokens.panel);
  const mix = (pc) => Math.round(op * pc + (1 - op) * b);
  return { r: mix(p[0]), g: mix(p[1]), b: mix(p[2]) };
}

const OP = 0.45;
const CASES = [
  ['用户近黑星空', 0.059, 0.130],
  ['纯色近黑', 0.020, 0.035],
  ['暗调照片', 0.030, 0.420],
  ['中间调低对比', 0.400, 0.560],
  ['正常照片', 0.050, 0.900],
  ['高对比', 0.010, 0.990],
];

for (const tag of ['固定透镜', '自适应透镜']) {
  console.log(`\n===== ${tag}（面板不透明度 ${OP}）=====`);
  for (const [name, lo, hi] of CASES) {
    let lens = T.LENS.light;
    if (tag === '自适应透镜') {
      lens = T.lensFromImage(lo, hi, L, scrimL, 1);
      if (!lens) {
        console.log(`${name.padEnd(12)} lens=null（回落固定透镜）`);
        continue;
      }
    }
    const bLo = behindCh(lens, lo, scrimL);
    const bHi = behindCh(lens, hi, scrimL);
    const mod = Math.abs(bHi - bLo) * (1 - OP) * 255; // 面板上肉眼可见的调制幅度
    const face = facePx(L, lens, lo, scrimL, OP);     // 最暗的那块面 = APCA 最坏情况
    const lc = [L.text, L.text2, L.text3].map((c) => Math.round(Math.abs(T.apcaLc(c, face))));
    const floor = T.backdropFloor(L, linOf(lo), scrimL, T.MIN_PANEL_OP, lens);
    const guard = T.backdropGuard(L, linOf(lo), scrimL, OP, lens);
    console.log(
      `${name.padEnd(12)} c=${r3(lens.contrast)} b=${r3(lens.brightness)}`
      + ` 身后=[${r3(bLo)},${r3(bHi)}] 幅度=${Math.round((bHi - bLo) * 255)}/255`
      + ` 面板调制=${r3(mod)}/255 lc=${lc.join('/')} floor=${floor} guard=${guard.floor}`,
    );
  }
}
