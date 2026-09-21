// theme.js 单测：皮肤解析、令牌派生、对比度守卫。
//
// 值这个文件的意义：皮肤是「一份 JSON 表覆写 CSS 变量」，中间没有任何一层会
// 告警。派生错一个键，表现是顶栏在浅色皮肤下还是黑的；解析漏一个来源，表现是
// 用户改的颜色重启就没了 —— 两种都不会报错、只会让人以为「这软件皮肤是坏的」。
// 主界面和小窗是两个 webview，唯一的一致性保证就是双方都走 resolveSkin，
// 所以这里重点锁三件事：resolveSkin 认得全部来源、派生键跟着核心键走、
// 上屏的颜色一定过对比度守卫。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScripts, eq, ok, section, report } from './_harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// theme.js 的色度学（luminance/contrast）委托给 vendor/chroma.min.js（UMD 在沙箱里
// 挂到 window 上），所以 vendor 必须和 theme.js 一起进沙箱 —— 这里测的就是真实链路。
const T = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js']).NetPeekTheme;

section('resolveSkin 认得全部皮肤来源');
{
  const base = { skin: 'plain', themes: {} };
  eq(T.resolveSkin(base).tokens.bg, T.SKINS.plain.tokens.bg, '内置 plain');
  eq(T.resolveSkin({ ...base, skin: 'light' }).tokens.bg, T.SKINS.light.tokens.bg, '内置 light');
  eq(T.resolveSkin({ ...base, skin: 'amber' }).tokens.bg, T.SKINS.amber.tokens.bg, '内置 amber');

  // 具名自定义皮肤
  const named = { skin: '我的', themes: { 我的: { name: '我的', tokens: { ...T.SKINS.plain.tokens, bg: '#010203' } } } };
  eq(T.resolveSkin(named).tokens.bg, '#010203', 'themes 里的具名皮肤');

  // 未知 id 回落到出厂皮肤，而不是返回 undefined 让 applyTokens 写进一串 "undefined"
  eq(T.resolveSkin({ ...base, skin: '不存在' }).tokens.bg, T.SKINS.plain.tokens.bg, '未知 id 回落 plain');
  eq(T.resolveSkin(null).tokens.bg, T.SKINS.plain.tokens.bg, 'null state 不抛异常');
}

section('resolveSkin 认得编辑器草稿（custom）');
{
  // 这是原来缺的一条分支：编辑器把改动写进 state.custom，但 resolveSkin 不读它，
  // 于是「改完重启就回到朴素」，而且小窗（启动走 resolveSkin）和主界面
  // （走 applyDraft 直接上屏）显示的是两套颜色。
  const st = {
    skin: 'custom',
    themes: {},
    custom: { tokens: { ...T.SKINS.plain.tokens, accent: '#ff0000' } },
  };
  eq(T.resolveSkin(st).tokens.accent, '#ff0000', '草稿颜色能被解析出来');

  // skin 指向 custom 但草稿是空的 → 回落，不能解析出 undefined
  eq(T.resolveSkin({ skin: 'custom', themes: {}, custom: null }).tokens.accent,
    T.SKINS.plain.tokens.accent, '空草稿回落 plain');
}

section('草稿颜色能穿过一次「保存 → 重启」');
{
  // 模拟真实链路：改色 → migrateState（重启时必经）→ resolveSkin
  const saved = JSON.parse(JSON.stringify({
    skin: 'custom',
    themes: {},
    custom: { tokens: { ...T.SKINS.plain.tokens, accent: '#ff0000' } },
  }));
  const revived = T.migrateState(saved);
  eq(revived.skin, 'custom', 'migrateState 不把 custom 判成非法 id');
  eq(T.resolveSkin(revived).tokens.accent, '#ff0000', '重启后仍是用户改的颜色');
}

section('deriveTokens：改核心键，派生键跟着走');
{
  // 原来的毛病：编辑器把单键写进一张「已展开」的 17 键表，派生键从此冻住。
  // 把「窗口底」改成浅色后 panel2（顶栏 / rail / 表头）还是深的，
  // 结果是浅色皮肤配一条黑顶栏。
  const dark = T.deriveTokens(T.SKINS.plain.tokens, {});
  ok(T.luminance(T.hexToRgb(dark.panel2)) < T.luminance(T.hexToRgb(dark.bg)),
    '深色皮肤：panel2 比 bg 更暗（凹陷一档）');

  const light = T.deriveTokens({ ...T.SKINS.plain.tokens, bg: '#f2f3f5', panel: '#ffffff', text: '#23272e' }, {});
  ok(T.luminance(T.hexToRgb(light.panel2)) > 0.5, '改成浅底后 panel2 也变浅，不再是黑顶栏');
  ok(T.luminance(T.hexToRgb(light.text2)) < T.luminance(T.hexToRgb(light.text)) + 1,
    '浅底下文字阶方向翻转');

  // accentInk 是「强调底上的字」，必须跟着 accent 走，否则主按钮会白底白字
  const red = T.deriveTokens({ ...T.SKINS.plain.tokens, accent: '#b3352b' }, {});
  ok(T.contrast(T.hexToRgb(red.accent), T.hexToRgb(red.accentInk)) >= 4.5,
    'accentInk 跟着 accent 重算，主按钮文字可读');
}

section('deriveTokens：用户显式改过的键不被重新派生冲掉');
{
  // 没有 overrides 就分不清「这是派生的、该更新」和「这是用户选的、别动」。
  const t = T.deriveTokens(
    { ...T.SKINS.plain.tokens, line: '#00ff00' },
    { line: true },
  );
  eq(t.line, '#00ff00', '标记为用户改过的 line 保持原值');

  const t2 = T.deriveTokens({ ...T.SKINS.plain.tokens, line: '#00ff00' }, {});
  ok(t2.line !== '#00ff00', '未标记的 line 会被重新派生');
}

section('guardTokens：上屏的颜色一定过对比度');
{
  // 原来 applyDraft 不校验，编辑器会照单全收 1.03 对比度的主文字（字直接看不见），
  // 而保存时 validateSkin 又会静默改写 —— 预览和存下来的不是一个东西。
  const bad = { ...T.SKINS.plain.tokens, text: '#232529' }; // 深底上的深字
  eq(T.contrast(T.hexToRgb(bad.text), T.hexToRgb(bad.panel)) < 4.5, true, '前提：这组确实不合格');

  const fixed = T.guardTokens(bad);
  ok(T.contrast(T.hexToRgb(fixed.tokens.text), T.hexToRgb(fixed.tokens.panel)) >= 4.5,
    '守卫后主文字达标');
  ok(fixed.adjusted.includes('text'), '被改过的键要报出来，好让 UI 告诉用户');

  const good = T.guardTokens({ ...T.SKINS.plain.tokens });
  eq(good.adjusted.length, 0, '出厂皮肤本来就合格，不该被动一个键');
}

section('glass lens：带 = 正文契约 + 中调护栏，带宽就是底图的形');
{
  // 这一节的判据在 2026-09-15 之后又换过一次，换的理由值得留在这里：
  //
  // 【第一代】带写死成浅色 [0.85, 1] 通道 —— 一条 0.15 宽、贴着纯白的窄带，底图的形
  //   在里面只剩几个灰阶（实测面板上 p2p 6/255）。用户两次报「不透明度拉到最低也
  //   透不出底图」。
  // 【第二代】带端改成按「GLASS_TIERS 每一档都达标」反解，并为了让深色那枚贴天花板的
  //   中灰有解，加了 GLASS_TIER_REL = 0.75 的自校准折扣。带宽拿回来了，但留下两个洞：
  //   ① 折扣实测**不是兜底而是无条件 25% 打折**（plain 的 text2 物理上限 50.3、声明
  //      45 明明可达，实际目标却被打到 37.7），而且目标随皮肤自身对比一起塌陷、没有
  //      下限 —— 构造一套低对比深色皮肤，目标会掉到 text 29.6 / text2 14.0 而系统
  //      认为完全达标；
  //   ② 契约只声明了 text / text2（深色）两档，text3 与全部语义色**不在里面**，实测
  //      在默认 plain 皮肤上 text3 只有 Lc 13.1、error 32.6 —— 渲染了但看不见。
  //   而把缺失档位塞回带里是死路：深色侧 text3@32 直接无解（带退化 → 透镜 null →
  //   地板顶到 1，原地重现 20:00 那个缺陷）、放宽到 25 带宽从 0.305 塌到 0.031。
  // 【第三代 = 现在】带**只**承载两条与「表面本身」有关的判据：正文契约（≥ LENS_BODY_LC）
  //   与中调护栏（合成面亮度留在本方向的表面区里）。其余字色改由 glassHardenTokens
  //   对着「带的最不利端上的合成面」逐键加固 —— 不花带宽。实测两个轴同时变好：
  //   带宽 plain 0.305 → 0.389、light 0.182 → 0.367，而全部字色首次真正达标。
  //
  // 所以这一节钉的是：带由那两条判据决定（而不是被某个字色偶然卡住）、带够宽、
  // 折扣不再存在、退化在结构上不可达。
  const light = T.expandTokens({
    bg: '#f5e4df', panel: '#f8eeeb', text: '#2a2c30', accent: '#2a2c30',
    down: '#8d5621', up: '#39668f', ok: '#1f6f44', warn: '#8a6608', error: '#b3352b',
  }, { tightRamp: true });
  const dark = T.expandTokens({
    bg: '#161418', panel: '#1c191d', text: '#f2ecea', accent: '#f2ecea',
    down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
  }, { tightRamp: true });

  // 判据直接走实现导出的那一份（glassContract / glassComposite），测试不重抄公式 ——
  // 两处口径一旦漂移，重抄的那份会假装通过（这条纪律从第二代沿用下来，它是对的）。
  const meetsAt = (tokens, t) => {
    const { bodyLc, midMax, midMin } = T.glassContract(tokens);
    const hex = T.glassComposite(tokens, t);
    const L = T.luminance(T.hexToRgb(hex));
    if (midMax != null && L > midMax + 1e-9) return false;
    if (midMin != null && L < midMin - 1e-9) return false;
    return Math.abs(T.apcaLc(tokens.text, hex)) >= bodyLc - 0.5;
  };
  const bodyAt = (tokens, t) => Math.abs(T.apcaLc(tokens.text, T.glassComposite(tokens, t)));
  const midAt = (tokens, t) => T.luminance(T.hexToRgb(T.glassComposite(tokens, t)));

  eq(T.LENS_DESIGN_OP, T.MIN_PANEL_OP, '带端按滑杆下限反解（契约在整个滑杆行程上成立）');
  eq(T.GLASS_TIER_REL, undefined, '自校准折扣已删除（它把契约变成了永不失败的判据）');
  eq(T.glassTierTargets, undefined, '折扣后的「实际目标」表随之下线');

  const [l0, l1] = T.lensBand(light);
  eq(l1, 0.99, '浅色带顶留一点白（不烧成纯色）');
  ok(meetsAt(light, l0), `浅色带底满足两条判据（正文 Lc ${bodyAt(light, l0).toFixed(0)}、合成面 L ${midAt(light, l0).toFixed(3)}）`);
  ok(!meetsAt(light, l0 - 0.02), '浅色带底不是白送的：再往下 0.02 就有判据不成立');
  ok(l1 - l0 >= 0.30,
    `浅色带够宽（${(l1 - l0).toFixed(3)} ≥ 0.30）—— 这是「底图的形」能用的空间`);
  // 第三代的带宽必须**明显高于**第二代（这套 token 上第二代实测 0.182）——
  // 换判据不是拿带宽换可读性，两个轴要同时变好，否则这次重构不值得做。
  // 门槛 0.33 对着本节这套派生浅皮肤的实测 0.341 留一点余量（≈1.9 倍于第二代）。
  // 注意别拿别的皮肤的实测值来定这里的门槛：内置 light 是 0.367、这套粉白派生皮肤
  // 是 0.341，带宽本来就随 panel/panel-2 与正文色一起变。
  ok(l1 - l0 >= 0.33, `浅色带宽远超第二代（${(l1 - l0).toFixed(3)} ≥ 0.33，同套 token 第二代实测 0.182）`);

  const [d0, d1] = T.lensBand(dark);
  eq(d0, 0.05, '深色带底留一点黑（暗部不压死、形还在）');
  ok(meetsAt(dark, d1), `深色带顶满足两条判据（正文 Lc ${bodyAt(dark, d1).toFixed(0)}、合成面 L ${midAt(dark, d1).toFixed(3)}）`);
  ok(!meetsAt(dark, d1 + 0.02), '深色带顶不是白送的：再往上 0.02 就有判据不成立');
  ok(d1 - d0 >= 0.30, `深色带够宽（${(d1 - d0).toFixed(3)} ≥ 0.30，旧实测 0.305）`);

  // 护栏是深色侧真正卡住带的那条判据（正文在这一带上余量很大）：合成面必须仍读作
  // 一块深色表面。护栏一旦形同虚设，带会一路推到中调灰 —— 实测那会让加固的位移
  // 从 ≤50 涨到 75–124/255，字阶被压平成 90/75/55（层级信息全没）。
  ok(midAt(dark, d1) <= T.GLASS_MID_MAX_DARK + 1e-9,
    `深色带顶由中调护栏定住（合成面 L ${midAt(dark, d1).toFixed(3)} ≤ ${T.GLASS_MID_MAX_DARK}）`);
  ok(bodyAt(dark, d1) > T.LENS_BODY_LC,
    `深色侧正文在带顶上仍有余量（Lc ${bodyAt(dark, d1).toFixed(0)} > ${T.LENS_BODY_LC}）—— 所以卡住带的是护栏`);
  ok(midAt(light, l0) >= T.GLASS_MID_MIN_LIGHT - 1e-9,
    `浅色带底仍读作浅色表面（合成面 L ${midAt(light, l0).toFixed(3)} ≥ ${T.GLASS_MID_MIN_LIGHT}）`);

  // bandOf 与 lensBand 同源（前者的通道端就是后者的亮度版），审计口径才不会漂
  ok(Math.abs(T.bandOf(light)[0] - T.luminance({ r: l0 * 255, g: l0 * 255, b: l0 * 255 })) < 1e-9,
    'bandOf 与 lensBand 同源（浅色带底）');
  ok(Math.abs(T.bandOf(dark)[1] - T.luminance({ r: d1 * 255, g: d1 * 255, b: d1 * 255 })) < 1e-9,
    'bandOf 与 lensBand 同源（深色带顶）');

  // 地板在这个契约下不再需要：任意底图亮度，深浅两侧的地板都退回滑杆下限
  // —— 这就是「滑杆不被系统拿走」的回归锁。
  for (const L of [0, 0.0014, 0.02, 0.12, 0.6, 1.0]) {
    const gl = T.backdropGuard(light, L, 0.09, T.MIN_PANEL_OP);
    eq(gl.floor, T.MIN_PANEL_OP, `浅色派生 + 底图亮度 ${L}：地板退回滑杆下限`);
    eq(gl.autoDim, 0, `浅色派生 + 底图亮度 ${L}：不铺自动纱`);
    const gd = T.backdropGuard(dark, L, 0.30, T.MIN_PANEL_OP);
    eq(gd.floor, T.MIN_PANEL_OP, `深色派生 + 底图亮度 ${L}：地板退回滑杆下限`);
    eq(gd.autoDim, 0, `深色派生 + 底图亮度 ${L}：不铺自动压暗（带顶已经压在护栏上）`);
  }

  // —— 2026-09-15 20:00 那个缺陷的回归锁（深色变全不透明） ——
  // 实测来源：用户壁纸（橙红火焰）派生出的深色皮肤，token 实测为
  //   panel #1e130f / panel2 #0e0604 / text #f0e5e2 / text2 #9b8f8b
  // 第一代实现里 text2 进了带的反解，而这枚中灰压在近黑底上 |Lc| 物理上限只有 ≈43、
  // 声明档位却是 45 —— 契约无解 → 带退化成 [0.05,0.05] → lensParams 斜率 0 返回 null
  // → lensOf 变 null → backdropGuard 走「无透镜」分支把地板顶到 1：面板全不透明，
  // 底图彻底消失（像素量尺实测 p2p 0/255，就是用户那句「现在深色也一样了」）。
  // 第三代从**结构上**免疫：text2 根本不在带的判据里（它归加固），而带的两条判据
  // 只涉及 text 与 panel/panel-2。下面每一条都必须成立。
  const userDark = {
    ...dark,
    bg: '#140906', panel: '#1e130f', panel2: '#0e0604',
    text: '#f0e5e2', text2: '#9b8f8b', text3: '#6a5e5a',
  };
  eq(T.isLightSkin(userDark), false, '实测深色皮肤：方向判为深色（亮字压暗底）');
  const [u0, u1] = T.lensBand(userDark);
  ok(u1 - u0 >= 0.30,
    `实测深色皮肤：带不退化成点（${u0.toFixed(3)} → ${u1.toFixed(3)}，宽 ${(u1 - u0).toFixed(3)}）`);
  const uLens = T.lensOf(userDark);
  ok(uLens !== null, '实测深色皮肤：透镜非空（否则守卫退回「无透镜」把面板顶成全不透明）');
  ok(uLens.contrast > 0 && uLens.brightness > 0, '实测深色皮肤：透镜参数有效');
  const ug = T.backdropGuard(userDark, 0.06, 0.2, T.MIN_PANEL_OP);
  eq(ug.floor, T.MIN_PANEL_OP, '实测深色皮肤：地板仍是滑杆下限（面板不会变成全不透明）');
  eq(ug.autoDim, 0, '实测深池皮肤：不铺自动补偿（滑杆不被拿走）');
  // 那枚中灰现在由加固接手：它在合成面上必须真的达标（第二代是「自校准松到 32」，
  // 也就是承认它不达标然后把标准降下来 —— 这次是把颜色推上去）。
  const uh = T.glassHardenTokens(userDark).tokens;
  const uBg = T.glassWorstComposite(userDark);
  ok(Math.abs(T.apcaLc(uh.text2, uBg)) >= T.GLASS_HARDEN_LC - 0.5,
    `实测深色皮肤：那枚中灰次要字被加固到 Lc ${Math.abs(T.apcaLc(uh.text2, uBg)).toFixed(1)} ≥ ${T.GLASS_HARDEN_LC}（旧实现是把档位降到 32）`);

  // —— 病态 token 的两条兜底 ——
  // ① 次要字与面板同色（物理对比 0）：它现在不参与带的反解，所以带完全不受影响，
  //    而加固仍要把它推到达标。
  const same = { ...userDark, text2: '#1e130f' };
  const sLens = T.lensOf(same);
  ok(sLens !== null && sLens.contrast > 0,
    '病态 token（次要字与面板同色）：仍是有效透镜，绝不返回 null');
  ok(Math.abs(T.lensBand(same)[1] - u1) < 1e-9,
    '病态 token：带与正常皮肤逐位相同（字色不再影响带 —— 这是第三代的结构性收益）');
  const sh = T.glassHardenTokens(same).tokens;
  ok(Math.abs(T.apcaLc(sh.text2, T.glassWorstComposite(same))) >= T.GLASS_HARDEN_LC - 0.5,
    '病态 token：同色次要字被加固层救回达标');
  // ② 正文本身病态（与面板同色 → 正文契约在任何 t 上都不可能满足）：必须退化成
  //    恒等透镜（整条带），而不是 null。「宁可不归一化，也不能没有透镜」。
  const badBody = { ...userDark, text: '#1e130f' };
  const bLens = T.lensOf(badBody);
  ok(bLens !== null && bLens.contrast > 0,
    '正文病态：兜底仍是有效透镜（退化成恒等透镜，不返回 null）');
  ok(T.lensBand(badBody)[1] - T.lensBand(badBody)[0] > 0, '正文病态：带仍有正宽度');
}

section('玻璃加固：合成面上的字色被推到达标，且不动带、不动层级');
{
  // 这一节是第三代方案的主体验收。加固解决的是一个实测缺陷：默认 plain 皮肤 + 任意
  // 底图，除 text 之外**所有**字色在合成面上都不达标（text3 Lc 13.1、error 32.6、
  // up 39.7），而单测过去发现不了 —— 因为契约里根本没有它们。
  const CASES = [
    ['plain（默认皮肤，深）', T.SKINS.plain.tokens],
    ['amber（深）', T.SKINS.amber.tokens],
    ['light（浅）', T.SKINS.light.tokens],
    ['派生暗红（深）', T.expandTokens({
      bg: '#140906', panel: '#1e130f', text: '#f0e5e2', accent: '#f0e5e2',
      down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
    }, { tightRamp: true })],
    ['派生亮（浅）', T.expandTokens({
      bg: '#f6f7f8', panel: '#fbfbfc', text: '#1b2027', accent: '#1b2027',
      down: '#b45a10', up: '#2d6ea8', ok: '#1f7a4d', warn: '#8a6410', error: '#a8352b',
    }, { tightRamp: true })],
  ];

  for (const [name, tokens] of CASES) {
    const bg = T.glassWorstComposite(tokens);
    const { tokens: hard } = T.glassHardenTokens(tokens);
    for (const k of T.GLASS_HARDEN_KEYS) {
      const min = k === 'text3' ? T.GLASS_HARDEN_WEAK_LC : T.GLASS_HARDEN_LC;
      const lc = Math.abs(T.apcaLc(hard[k], bg));
      ok(lc >= min - 0.5, `${name} · ${k}：合成面上 Lc ${lc.toFixed(1)} ≥ ${min}`);
    }
    // 正文由带的契约保证，加固不该动它（动了就是重复劳动 + 位移白付）
    eq(hard.text, tokens.text, `${name}：正文不被加固（它归带的正文契约）`);
    // 强调色只作背景（按钮底 / 开关 / 选区），不是压在玻璃上的文字 —— 加固它的后果
    // 实测是 amber 的品牌琥珀 #d98a3d 被洗成 #efc8a6，给一个不存在的场景做补偿。
    eq(hard.accent, tokens.accent, `${name}：强调色不被加固（它只作背景）`);
    // 字阶层级必须保住：加固是「把不可读的推到可读」，不是「把三档压成一档」
    const lc2 = Math.abs(T.apcaLc(hard.text2, bg));
    const lc3 = Math.abs(T.apcaLc(hard.text3, bg));
    ok(Math.abs(T.apcaLc(hard.text, bg)) > lc2 && lc2 > lc3,
      `${name}：字阶顺序仍是 text > text2 > text3（${Math.abs(T.apcaLc(hard.text, bg)).toFixed(0)}/${lc2.toFixed(0)}/${lc3.toFixed(0)}）`);
    // 位移上限：加固走 OKLab（保色相、主要动明度），语义色推完还得认得出是橙是蓝。
    // 实测最大位移 55/255（派生亮皮肤的 down）；门槛留到 70 给派生皮肤余量。
    let maxShift = 0;
    for (const k of T.GLASS_HARDEN_KEYS) {
      const a = T.hexToRgb(tokens[k]);
      const b = T.hexToRgb(hard[k]);
      maxShift = Math.max(maxShift, Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
    }
    ok(maxShift <= 70, `${name}：最大通道位移 ${maxShift}/255 ≤ 70（保住色相与可辨识度）`);
    // 幂等：加固后的表再加固一遍不该再动。这条同时证明「加固不移动带」——
    // 带只看 text + panel/panel-2，而加固只动 text2/text3/语义色，两边输入不相交。
    eq(T.glassHardenTokens(hard).adjusted.length, 0, `${name}：加固是幂等的（不存在迭代收敛问题）`);
    ok(Math.abs(T.lensBand(hard)[0] - T.lensBand(tokens)[0]) < 1e-9
      && Math.abs(T.lensBand(hard)[1] - T.lensBand(tokens)[1]) < 1e-9,
      `${name}：加固前后带逐位相同（加固不反过来移动带）`);
  }

  // 弱字阶的档位是**刻意**比其他键低的：它的设计意图就是「弱」（三套出厂皮肤在纯
  // 面板上只有 Lc 23–25）。把它一起推到 45 等于取消这个层级 —— 实测字阶会从
  // 88/48/23 压成 90/75/55。所以这里锁住「两档不同」这个设计决策本身。
  ok(T.GLASS_HARDEN_WEAK_LC < T.GLASS_HARDEN_LC,
    `弱字阶单独一档（${T.GLASS_HARDEN_WEAK_LC} < ${T.GLASS_HARDEN_LC}）：保住「弱」这个层级`);
  // 下限锚在 30，而 30 不是随手取的：它是 APCA 对「装饰性部件」的硬地板，也正是
  // preview-v2 像素审计那条 `below30 === 0` 用的同一个数。两处若不同源，模型层会
  // 判过、像素层会判不过（或反过来），而那种矛盾最难查 —— 两边都「有断言」。
  ok(T.GLASS_HARDEN_WEAK_LC >= 30,
    `弱字阶不低于 APCA 装饰线（${T.GLASS_HARDEN_WEAK_LC} ≥ 30，与像素审计的 below30 同源；旧实测 7.6–13.9）`);

  // 加固前的实测缺陷留档：这几个数就是这一节存在的理由，被修好之后也要能被读到。
  {
    const p = T.SKINS.plain.tokens;
    const bg = T.glassWorstComposite(p);
    ok(Math.abs(T.apcaLc(p.text3, bg)) < 25,
      `（缺陷留档）plain 未加固的 text3 在合成面上只有 Lc ${Math.abs(T.apcaLc(p.text3, bg)).toFixed(1)}`);
    ok(Math.abs(T.apcaLc(p.error, bg)) < 45,
      `（缺陷留档）plain 未加固的 error 只有 Lc ${Math.abs(T.apcaLc(p.error, bg)).toFixed(1)}`);
  }

  // ensureApca 的两条性质（加固的引擎）：
  // ① 已达标的不动 —— 位移一格都是白付的；
  // ② |Lc| 对混比**不单调**（前景起步在底色另一侧时会先降到 0 再升），所以实现走
  //    逐步扫描而不是二分。这条用「深底上比底还暗的弱字」验证：二分会收敛到错的一侧。
  const bg2 = '#58595b';
  eq(T.ensureApca('#ffffff', bg2, 45), '#ffffff', '已达标的前景色不动');
  const pushed = T.ensureApca('#4a4b4d', bg2, 45); // 比底色更暗一点 → 跨零点
  ok(Math.abs(T.apcaLc(pushed, bg2)) >= 44.5, `跨零点的前景也能推到达标（Lc ${Math.abs(T.apcaLc(pushed, bg2)).toFixed(1)}）`);
  eq(T.ensureApca('bad', bg2, 45), 'bad', '非法输入原样返回，不抛');
}

section('贴膜模式复用加固：贴膜地板面上的字色也达标（渲染路径覆盖）');
{
  // 加固的接线（theme-ui 的 glassHardenActive）曾经是「只在置底 + 有底图」，贴膜
  // 模式被整段跳过 —— 而贴膜的浓度地板（wrapFloor）只守 text/text2，弱字阶与语义色
  // 不在判据里，实测贴膜地板面上 text3 只有 Lc 20–23、error 40–42。
  // 这一节把「渲染路径」列清楚（置底 / 贴膜 / 无图 / 小窗各走哪份表），再逐面扫描
  // 贴膜地板，断言加固后的字色在其上全部达标 —— 它同时是覆盖性检查里「每个令牌都
  // 有负责人」那节的补位：那节只数令牌、不数路径，贴膜这个洞就是靠这条补出来的。
  // 贴膜 + 底图是唯一需要加固的贴膜路径：膜把面板稀释、text2 靠浓度地板兜住而
  // text3/语义色没有兜底（实测 text3 20–23、error 40–42）。无图贴膜（膜退场、表面
  // = 纯 panel 实底）与无图置底、小窗同属「实底」路径 —— 出厂皮肤手写的字阶就是
  // 设计意图，加固不该生效（theme-ui 的 glassHardenActive 收底图地址、无图为假）。
  // 无图这条**接线**锁不在模型层：它是 theme-ui 里一行 `!!bg`，这里只锁得住「扫描
  // 覆盖面比实底更狠」—— 实底不在扫描点集里，硬比会得到「面板更可读/更不可读」
  // 都有的矛盾结论（实测 lum=0.02 的地板面反而比 panel 好读 0.2）。若哪天有人把
  // 加固的开关按模式重新关回贴膜，这条扫描的贴膜面会当场全红 —— 那才是接线回归
  // 能被模型层抓住的形态。
  const CASES = [
    ['plain（默认皮肤，深）', T.SKINS.plain.tokens],
    ['amber（深）', T.SKINS.amber.tokens],
    ['light（浅）', T.SKINS.light.tokens],
    ['派生暗红（深）', T.expandTokens({
      bg: '#140906', panel: '#1e130f', text: '#f0e5e2', accent: '#f0e5e2',
      down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
    }, { tightRamp: true })],
    ['派生亮（浅）', T.expandTokens({
      bg: '#f6f7f8', panel: '#fbfbfc', text: '#1b2027', accent: '#1b2027',
      down: '#b45a10', up: '#2d6ea8', ok: '#1f7a4d', warn: '#8a6410', error: '#a8352b',
    }, { tightRamp: true })],
  ];

  for (const [name, tokens] of CASES) {
    const hard = T.glassHardenTokens(tokens).tokens;
    // 逐面扫描：膜亮度整段 [0,1]（步长 0.02），每档先取该图下的浓度地板，再在地板
    // 面上量字色。贴膜的地板判据只守 text2（深）或 text/text2（浅），硬化推亮后的
    // text2 只会更达标 —— 地板面是「浓度已按原表抬到 text2 达标」的面，正是字色
    // 实际落地的面。
    for (let i = 0; i <= 50; i++) {
      const lum = i / 50;
      const op = T.wrapFloor(tokens, lum, 0.4);
      const heff = T.effectivePanel(hard, lum, 0, op, undefined, null);
      for (const k of T.GLASS_HARDEN_KEYS) {
        const min = k === 'text3' ? T.GLASS_HARDEN_WEAK_LC : T.GLASS_HARDEN_LC;
        const lc = Math.abs(T.apcaLc(hard[k], heff));
        ok(lc >= min - 0.5, `${name} · lum=${lum.toFixed(2)} floor=${op.toFixed(2)}：加固后 ${k} 在地板面上 Lc ${lc.toFixed(1)} ≥ ${min}`);
      }
    }
  }
}

section('自适应透镜（auto-levels）：把底图自己的灰范围铺满明度带');
{
  // 回落透镜把底图**整条** [0,1] 映射进带 —— 对「自己只占一小段灰」的壁纸，那 0.07
  // 的内部对比只铺进带里的一小截、剩下的带宽空着（用户壁纸实测面板上的形只剩
  // 6/255）。自适应透镜按图自己的 [p2, p98] 反解 contrast / brightness，把这段灰
  // 拉张开铺满整条带；带端不动（那是可读性契约）。这一步是「不透明度拉到最低也
  // 看得见底图」落地的最后一环。
  const light = T.expandTokens({
    bg: '#f5e4df', panel: '#f8eeeb', text: '#2a2c30', accent: '#2a2c30',
    down: '#8d5621', up: '#39668f', ok: '#1f6f44', warn: '#8a6608', error: '#b3352b',
  }, { tightRamp: true });
  const dark = T.expandTokens({
    bg: '#161418', panel: '#1c191d', text: '#f2ecea', accent: '#f2ecea',
    down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
  }, { tightRamp: true });

  const gray = (v) => { const c = Math.round(255 * v); return { r: c, g: c, b: c }; };
  // 铺纱：与 theme.lensFromImage 内部那条完全同构 —— 纱色必须走 veilOf
  // （浅色是 scrimTint 的亮分支，深色是纯黑），自己拿 scrimTint 拼会差一个方向
  const mkVeiled = (tokens, scrim) => {
    const vc = T.lumToChannel(T.luminance(T.veilOf(tokens))) / 255;
    return (v) => v + (vc - v) * scrim;
  };
  const outCh = (lens, v) => T.lensApply(gray(v), lens).r / 255;

  const [t0, t1] = T.lensBand(light);
  const scrim = T.effectiveScrim(0.3, true);
  const veil = mkVeiled(light, scrim);
  const RANGES = [
    ['用户壁纸（近黑星空）', 0.059, 0.130],
    ['暗调照片', 0.030, 0.420],
    ['中间调低对比', 0.400, 0.560],
    ['正常照片', 0.050, 0.900],
    ['高对比', 0.010, 0.990],
  ];
  for (const [name, lo, hi] of RANGES) {
    const lens = T.lensFromImage(lo, hi, light, scrim, 1);
    ok(lens, `${name}：反解出透镜参数`);
    ok(lens.contrast > 0 && lens.brightness > 0, `${name}：参数为正（映射单调、不发散）`);
    // 端点口径（第三次返工后）：图的最亮端**正好**落到带顶（用满带宽），而最暗端
    // 落在带内 —— 带底留给「比 p2 更暗的像素」。旧版要求最暗端也压在带底上，那必然
    // 让更暗的像素掉出带（实测弱字阶 Lc 28.6）。
    ok(Math.abs(outCh(lens, veil(hi)) - t1) <= 0.03,
      `${name}：灰最亮端落到带顶（${outCh(lens, veil(hi)).toFixed(3)} vs ${t1.toFixed(3)}）`);
    ok(outCh(lens, veil(lo)) >= t0 - 0.01,
      `${name}：灰最暗端落在带内（${outCh(lens, veil(lo)).toFixed(3)} ≥ 带底 ${t0.toFixed(3)}）`);
    ok(Math.abs(outCh(lens, veil(0)) - t0) <= 0.02,
      `${name}：输入纯黑落到带底（${outCh(lens, veil(0)).toFixed(3)}）`);
  }

  // 验收口径：面板身后那张背景的可变幅度（0..255）。回落透镜在「只占一小段灰」的
  // 图上把带宽浪费掉，自适应透镜要把它抬到两位数，且乘完不透明度仍要够看。
  const amp = (lens, lo = 0.059, hi = 0.130) => Math.abs(outCh(lens, veil(hi)) - outCh(lens, veil(lo))) * 255;
  const near = T.lensFromImage(0.059, 0.130, light, scrim, 1);
  const fallback = T.lensOf(light);
  ok(amp(near) >= amp(fallback) * 8,
    `近黑壁纸：身后幅度 ${amp(fallback).toFixed(1)}/255 → ${amp(near).toFixed(1)}/255（≥8×）`);
  // 幅度门槛分两档，因为「锚点改到输入下限」之后幅度要乘一个折算系数
  // factor = (hiV−loV)/(hiV−zeroV)：图自己的范围只占带的一段，剩下那一段留给
  // 「比 p2 更暗的像素」（它们必须留在带内，这是契约对每个像素成立的前提）。
  //   · 用户真壁纸（等效灰 p2≈0.020、p98≈0.193）→ factor≈0.90，几乎不损失，仍 ≥40；
  //   · 下面这条合成用例 p2=0.059 离黑很远（比真图苛刻得多）→ factor≈0.55，
  //     门槛按 40×0.55≈22 折算后再留余量，取 30。
  const realRange = [0.020, 0.193];
  ok(amp(near, ...realRange) * 0.7 >= 40,
    `用户真壁纸那一档灰范围：0.30 面板上的调制 ${(amp(near, ...realRange) * 0.7).toFixed(1)}/255 ≥ 40`);
  ok(amp(near) * (1 - T.MIN_PANEL_OP) >= 30,
    `合成近黑档（比真图苛刻）：0.30 面板上的调制 ${(amp(near) * 0.7).toFixed(1)}/255 ≥ 30`);

  // 新不变量（第三次返工的验收）：透镜输出**不可能**越过带底。旧锚点是 veiled(p2)，
  // 于是所有比 p2 更暗的像素都掉到带底之下 —— 像素审计在用户真图上量到弱字阶
  // Lc 28.6（旧窄带时代是 60.3），就是壁纸里成片的近黑区（渲染在 .top-meta 后面）
  // 逃出带造成的。带是契约/守卫/审计三者的共同前提，输出一旦越界，三者的保证同时作废。
  for (const [name, lo, hi] of [
    ['近黑星空', 0.059, 0.130], ['暗调照片', 0.030, 0.420], ['中间调低对比', 0.400, 0.560],
  ]) {
    const l = T.lensFromImage(lo, hi, light, scrim, 1);
    ok(l, `${name}：反解成功`);
    let minOut = Infinity;
    for (let v = 0; v <= 1.0001; v += 0.005) minOut = Math.min(minOut, outCh(l, veil(v)));
    ok(minOut >= t0 - 0.01,
      `${name}：输出下界 ${minOut.toFixed(3)} ≥ 带底 ${t0.toFixed(3)}（不越过带）`);
  }

  // 彩度补偿必须跟着 c 走：旧版把 3.2 写死（那是给 c=0.105 配的），透镜改成自适应
  // 之后 c 变大、补偿过头 → 底图整幅发粉（用户截图里那层粉雾）。本轮的第二个坑。
  eq(near.saturate, T.chromaComp(near.contrast), '饱和补偿由 c 反解，不再写死');
  ok(near.saturate <= 2.6, `自适应透镜的饱和补偿落在钳位内（${near.saturate}）`);
  ok(near.contrast > fallback.contrast,
    `灰范围窄 → c 比回落透镜大（${near.contrast} > ${fallback.contrast}）`);

  // 反例留档：若用「未铺纱」的范围反解、却把参数用在铺纱后的输入上，最暗端会被顶到
  // 带顶之上全 clamp 成白 —— 底图反而彻底消失。这是本实现第一版的坑，必须被钉住。
  const noVeil = T.lensFromImage(0.059, 0.130, light, 0, 1);
  ok(outCh(noVeil, veil(0.059)) > t1,
    '（反例）用未铺纱范围反解 → 铺纱后的最暗端被顶过带顶');

  // 近乎纯色的图不给噪声送放大：参数退化时回落 lensOf
  eq(T.lensFromImage(0.020, 0.035, light, scrim, 1), null, '近纯色图：回落 lensOf');
  eq(T.lensFromImage(0.500, 0.505, light, scrim, 1), null, '平色图：回落 lensOf');
  ok(T.MIN_IMG_RANGE > 0 && T.MIN_IMG_RANGE < 0.05, `平坦门槛在合理区间（${T.MIN_IMG_RANGE}）`);

  // 深色侧镜像：亮底图的灰范围同样铺满深色带，且不越过带顶
  const dScrim = T.effectiveScrim(0.3, false);
  const dVeil = mkVeiled(dark, dScrim);
  const dLens = T.lensFromImage(0.020, 0.900, dark, dScrim, 1);
  ok(dLens, '深色皮肤：亮底图也能反解出参数');
  const [, dT1] = T.lensBand(dark);
  ok(outCh(dLens, dVeil(0.900)) <= dT1 + 0.03,
    `深色皮肤：灰最亮端不越过带顶（${outCh(dLens, dVeil(0.900)).toFixed(3)} vs ${dT1.toFixed(3)}）`);
}

section('弱字阶托底：派生 text3 不跌破设计带（≈3:1）');
{
  // 雪地 / 天空类亮图派生的浅色皮肤，线性混出来的 text3 只有 2.4 左右；半透面板
  // 再叠到图上最亮的区域，实测只剩 1.0–1.4 —— 字在渲染，人看不见。派生处托底后，
  // 无论核心键落在哪个亮度带，text3 都不能低于 2.9，且层级（text2 > text3）仍在。
  for (const [name, core] of [
    ['亮底·雪地类', { bg: '#f6f7f8', panel: '#fbfbfc', text: '#2a211b', down: '#b45a10', up: '#2e6f9e', ok: '#1f6f44', warn: '#8a6608', error: '#b3352b', accent: '#2a211b' }],
    ['亮底·天空类', { bg: '#cdd4da', panel: '#e9ecee', text: '#2a211b', down: '#b45a10', up: '#2e6f9e', ok: '#1f6f44', warn: '#8a6608', error: '#b3352b', accent: '#2a211b' }],
    ['暗底·晨雾类', { bg: '#131417', panel: '#151619', text: '#f2e6dc', down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373', accent: '#f2e6dc' }],
    ['中性灰·plain核心', { bg: '#1b1d21', panel: '#22252a', text: '#e3e5e9', down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373', accent: '#e3e5e9' }],
  ]) {
    const d = T.expandTokens(core);
    const c3 = T.contrast(T.hexToRgb(d.text3), T.hexToRgb(d.panel));
    ok(c3 >= 2.9, `${name}：派生 text3 相对面板 ${c3.toFixed(2)} ≥ 2.9`);
    const c2 = T.contrast(T.hexToRgb(d.text2), T.hexToRgb(d.panel));
    ok(c2 > c3, `${name}：text2（${c2.toFixed(2)}）层级仍高于 text3（${c3.toFixed(2)}）`);
  }

  // 手写出厂皮肤不经 expandTokens，托底不许惊动它们
  eq(T.SKINS.plain.tokens.text3, '#686e77', 'plain 的手写 text3 原样');
  eq(T.SKINS.light.tokens.text3, '#9098a4', 'light 的手写 text3 原样');
}

section('薄面板原地达标：滑杆拉到底仍达标');
{
  // 用户两次报的缺陷（「不透明度拉到最低还是透不出底图」）的直接验收。透镜把面板
  // 身后的背景按契约归一化之后，0.30 的漆层就够 —— 不再需要把地板抬到 0.9+
  // （那样底图就看不见了）。断言锁三件：地板不介入、自动补偿不介入、最不利那档
  // 面板上各档字阶仍站在玻璃档位之上（含此前被稀释到看不见的弱字阶）。
  const light = T.expandTokens({
    bg: '#f5e4df', panel: '#f8eeeb', text: '#2a2c30', accent: '#2a2c30',
    down: '#8d5621', up: '#39668f', ok: '#1f6f44', warn: '#8a6608', error: '#b3352b',
  }, { tightRamp: true });
  const scrim = 0.09; // 浅色侧的最小亮纱（effectiveScrim 的折算下限）
  // 最不利那档面板：浅色皮肤怕暗 → 两档里更暗的那档（顶栏 / rail 那档）
  const pCard = T.hexToRgb(light.panel);
  const pTop = T.hexToRgb(light.panel2);
  const worst = T.luminance(pCard) <= T.luminance(pTop)
    ? light : { ...light, panel: light.panel2 };
  const tiersOf = (op, L) => [worst.text, worst.text2, worst.text3]
    .map((c) => Math.abs(T.apcaLc(c, T.effectivePanel(worst, L, scrim, op))));
  for (const L of [0, 0.0014, 0.12, 0.6, 1.0]) {
    const g = T.backdropGuard(light, L, scrim, T.MIN_PANEL_OP);
    eq(g.floor, T.MIN_PANEL_OP, `底图亮度 ${L}：地板不介入（滑杆拉到底即最优）`);
    eq(g.autoDim, 0, `底图亮度 ${L}：浅色侧不铺自动亮纱（会连缝隙一起洗）`);
    const [a, b, c] = tiersOf(T.MIN_PANEL_OP, L);
    ok(a >= 60 && b >= 48 && c >= 32,
      `底图亮度 ${L} + 0.30 漆层：三档字阶 ${a.toFixed(0)}/${b.toFixed(0)}/${c.toFixed(0)} ≥ 60/48/32`);
  }
  // 契约在滑杆下限上反解 ⟹ 往上拖只会更好
  const [atMin] = tiersOf(T.MIN_PANEL_OP, 0.0014);
  const [at45] = tiersOf(0.45, 0.0014);
  ok(at45 > atMin, `拖高不透明度，正文更清楚（${atMin.toFixed(0)} → ${at45.toFixed(0)}）`);
  // 层级不能用「把弱字阶压黑」换来：text3 仍明显弱于 text2
  ok(T.luminance(T.hexToRgb(light.text3)) > T.luminance(T.hexToRgb(light.text2)),
    'text3 仍比 text2 弱（层级用的是收窄的派生带，不是把弱字阶压黑）');
  // 合成面落在 bandOf（= 透镜带端的亮度版）之内
  const l = T.luminance(T.hexToRgb(T.effectivePanel(light, 0.0014, scrim, T.MIN_PANEL_OP)));
  const [bLo, bHi] = T.bandOf(light);
  ok(l >= bLo && l <= bHi,
    `薄面板合成面落在玻璃带内（L ${l.toFixed(3)} ∈ [${bLo.toFixed(3)}, ${bHi.toFixed(3)}]）`);

  // —— 深色那一半（用户第二次报缺陷的另一半） ——
  // 用实测的深色 token。这一段的判据在第三代换了「由谁负责」：
  //   正文（近白 #f0e5e2）仍由**带的契约**保证 ≥60 —— 这是深色玻璃上用户真能感觉到
  //     的可读性，也是带宽这笔交易的下限；
  //   次要字（那枚中灰 #9b8f8b）不再由带负责。第二代是「承认它不达标、把档位松到
  //     32」，实测这仍然不够：底图亮度 1 时它在实际合成面上只有 Lc 30.0，连松过的
  //     32 都跌破 —— 也就是说自校准那条路连自己降低后的标准都守不住。第三代改成把
  //     颜色**推上去**（glassHardenTokens），推完实测 50.4–63.4，全程高于 45。
  // 所以下面量的是**加固后**的那张表：它才是真正上屏的令牌（theme-ui.applyCurrent
  // 在置底 + 有底图时写的就是它）。拿原始 token 量等于量了一张不会上屏的表。
  const duser = {
    ...light,
    bg: '#140906', panel: '#1e130f', panel2: '#0e0604',
    text: '#f0e5e2', text2: '#9b8f8b', text3: '#6a5e5a',
  };
  const dhard = T.glassHardenTokens(duser).tokens;
  eq(dhard.text, duser.text, '深色实测皮肤：正文不被加固（它归带的正文契约）');
  for (const L of [0, 0.0014, 0.06, 0.6, 1.0]) {
    const g = T.backdropGuard(duser, L, 0.2, T.MIN_PANEL_OP);
    eq(g.floor, T.MIN_PANEL_OP, `深色实测皮肤 + 底图亮度 ${L}：地板不介入（底图不会被面板吃掉）`);
    const eff = T.effectivePanel(duser, L, 0.2, T.MIN_PANEL_OP);
    const body = Math.abs(T.apcaLc(duser.text, eff));
    const secRaw = Math.abs(T.apcaLc(duser.text2, eff));
    const sec = Math.abs(T.apcaLc(dhard.text2, eff));
    ok(body >= 60, `深色实测皮肤 + 底图亮度 ${L} + 0.30 漆层：正文 Lc ${body.toFixed(0)} ≥ 60`);
    ok(sec >= T.GLASS_HARDEN_LC,
      `深色实测皮肤 + 底图亮度 ${L}：加固后的次要字 Lc ${sec.toFixed(0)} ≥ ${T.GLASS_HARDEN_LC}（原色只有 ${secRaw.toFixed(0)}）`);
  }
  // 加固确实是**必要**的，不是给已经达标的色做无用功：原色在最亮底图下跌破第二代
  // 那个已经放宽过的 32。这条断言钉住「这一层解决的是一个真实存在的缺陷」——
  // 哪天有人把加固摘掉，失败的会是它而不是某个含糊的整体指标。
  const effBright = T.effectivePanel(duser, 1.0, 0.2, T.MIN_PANEL_OP);
  ok(Math.abs(T.apcaLc(duser.text2, effBright)) < 32,
    `原色次要字在最亮底图上确实不达标（Lc ${Math.abs(T.apcaLc(duser.text2, effBright)).toFixed(1)} < 32，第二代放宽后的档位）`);
}

section('backdropGuard：透镜在，守卫退休；只有没有透镜才兜底');
{
  const dark = T.expandTokens({
    bg: '#161418', panel: '#1c191d', text: '#f2ecea', accent: '#f2ecea',
    down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
  }, { tightRamp: true });
  // 有透镜（置底模式 + 底图）：无论底图多亮多暗，地板与自动补偿都不介入 ——
  // 用户拖到多少就是多少。「滑杆被系统拿走」正是用户连着两次报的同一个缺陷，
  // 这个双层循环就是它的回归锁。
  for (const L of [0, 0.066, 0.5, 0.95, 1]) {
    for (const [name, tokens] of [
      ['浅色', T.SKINS.light.tokens],
      ['朴素', T.SKINS.plain.tokens],
      ['深色派生', dark],
    ]) {
      const g = T.backdropGuard(tokens, L, 0.3, T.MIN_PANEL_OP);
      eq(g.floor, T.MIN_PANEL_OP, `${name} + 底图亮度 ${L}：地板不介入`);
      eq(g.autoDim, 0, `${name} + 底图亮度 ${L}：不铺自动补偿`);
    }
  }
  // 没有透镜的路径（贴膜 / 无图）守卫照旧兜底：浅色皮肤 + 近黑底图 + 0.30 的漆层会
  // 滑进中调，这时地板必须抬起来 —— 这是「退休」没有越界的证据。
  const noLens = T.backdropFloor(T.SKINS.light.tokens, 0.0014, 0.09, T.MIN_PANEL_OP, null);
  ok(noLens > T.MIN_PANEL_OP, `没有透镜时地板仍会兜底（抬到 ${noLens}）`);
}

section('backdropFloor：不耦合全局界面不透明度');
{
  // 曾把 ui-opacity 折进 floor（按最坏亮桌面兜底），结果亮图皮肤下全局滑杆
  // 一拉低，floor 就被顶到 1，面板钳回全不透明 —— 全局滑杆形同虚设。
  // 正确分工：floor 只管「面板滑杆 vs 底图」，全局淡出作用于所有漆层。
  const toks = T.SKINS.plain.tokens;
  eq(T.backdropFloor.length, 3, 'backdropFloor 不再收 uiOpacity 参数');
  eq(T.effectivePanel(toks, 0.5, 0.3, 0.9), T.effectivePanel(toks, 0.5, 0.3, 0.9),
    'effectivePanel 是纯函数（同样的输入同样的漆）');
  // 贴膜模式没有面板级 backdrop-filter（膜就是表面），模型必须显式关掉透镜 ——
  // 忘了传 null 就会吃到默认透镜，判定比渲染乐观（wrapFloor 里就是传 null 的）。
  const withLens = T.effectivePanel(toks, 0.0, 0.3, 0.3);
  const noLens = T.effectivePanel(toks, 0.0, 0.3, 0.3, undefined, null);
  ok(withLens !== noLens, '贴膜（lens=null）与置底（带透镜）的合成面必须不同');
  eq(noLens, T.effectivePanel(toks, 0.0, 0.3, 0.3, undefined, null), '关掉透镜后仍是纯函数');
}

section('旧配置归位：地板时代留下的近实心面板不透明度');
{
  // 透镜上线前，面板不透明度被地板逼在 0.55–1.0 的近实心区间（最高 0.97），
  // 那个区间只剩「底图看不见」一个作用。迁到新版本时一次性落回 0.45，且只做一次。
  const old = T.migrateState({
    skin: 'image', backgroundImage: 'C:/x.jpg', panelOpacity: 0.93,
    imageMode: 'light', themes: {},
  });
  eq(old.panelOpacity, 0.45, '地板时代的 0.93 一次性归位到 0.45');
  eq(old.opRev, 1, '归位打上标记，之后不再重复');
  const keep = T.migrateState({
    skin: 'image', backgroundImage: 'C:/x.jpg', panelOpacity: 0.8,
    opRev: 1, imageMode: 'light', themes: {},
  });
  eq(keep.panelOpacity, 0.8, '已归位过的配置里，用户自己选的 0.8 不再被改');
  const thin = T.migrateState({
    skin: 'image', backgroundImage: 'C:/x.jpg', panelOpacity: 0.35,
    imageMode: 'light', themes: {},
  });
  eq(thin.panelOpacity, 0.35, '本来就薄的面板原样保留');
  eq(T.migrateState({ skin: 'image', backgroundImage: 'C:/x.jpg', themes: {} }).panelOpacity, 0.45,
    '没存过面板不透明度的 image 用户落到新默认 0.45');
}

section('壁纸取色：交互色与数据色不同色');
{
  // accent / down 原来都吃 colorful[0] —— 壁纸取色皮肤下主按钮与下载图表同色，
  // 违反「--accent 管交互、--down/--up 只管数据」的分工。现在 accent 取最饱和色，
  // down / up 依次取其余彩色，不够才退回固定橙 / 钢蓝。
  // （无 imgEl 时 ColorThief 抛错走平均色回落：单色板只剩一个彩色，
  //   accent 吃它，down 退回固定橙 —— 两者必须不同。）
  const w = 8, h = 8;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 200; data[i + 1] = 40; data[i + 2] = 40; data[i + 3] = 255; }
  const toks = T.tokensFromImage({ data, width: w, height: h }, null);
  ok(toks.accent.toLowerCase() !== toks.down.toLowerCase(),
    `accent(${toks.accent}) ≠ down(${toks.down})`);
  ok(toks.down.toLowerCase() !== toks.up.toLowerCase(),
    `down(${toks.down}) ≠ up(${toks.up})`);
}

section('内置皮肤自检：三套出厂皮肤都得过 4.5:1');
{
  for (const [id, skin] of Object.entries(T.SKINS)) {
    const t = skin.tokens;
    for (const k of ['text', 'text2', 'down', 'up', 'ok', 'warn', 'error', 'accent']) {
      const c = T.contrast(T.hexToRgb(t[k]), T.hexToRgb(t.panel));
      ok(c >= 4.5, `${id}.${k} 相对面板 ${c.toFixed(2)} ≥ 4.5`);
    }
    ok(T.contrast(T.hexToRgb(t.accent), T.hexToRgb(t.accentInk)) >= 4.5,
      `${id}: 强调底上的文字可读`);
  }
}

section('内置壁纸清单');
{
  // 三张壁纸此前躺在 wallpapers/ 里没有任何代码引用（253 KB 死资源，
  // 而「跟随背景图」皮肤却要求用户自己找图）。清单进代码，UI 才能列出来。
  ok(Array.isArray(T.WALLPAPERS) && T.WALLPAPERS.length > 0, '壁纸清单非空');
  for (const w of T.WALLPAPERS) {
    ok(/^wallpapers\/.+\.(jpg|png|webp)$/.test(w.src), `${w.src} 路径形如 wallpapers/*.jpg`);
    ok(typeof w.name === 'string' && w.name.length > 0, `${w.src} 有可读名字`);
  }
}

section('跟随系统深浅色（resolveSkin 出口映射）');
{
  // 沙箱没有 matchMedia → systemPrefersDark() 恒为深色。
  const base = { skin: 'plain', themes: {} };
  eq(T.resolveSkin({ ...base, followSystem: true }).tokens.bg, T.SKINS.plain.tokens.bg,
    '系统深色：plain 解析回 plain');
  eq(T.resolveSkin({ ...base, skin: 'light', followSystem: true }).tokens.bg, T.SKINS.plain.tokens.bg,
    '系统深色：light 的意图解析成 plain');
  eq(T.resolveSkin({ ...base, skin: 'light' }).tokens.bg, T.SKINS.light.tokens.bg,
    '开关关闭：light 原样解析');

  // 系统浅色的实例：注入 matchMedia 桩（matches=false → 浅色）
  const TL = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js'],
    { matchMedia: () => ({ matches: false }) }).NetPeekTheme;
  eq(TL.resolveSkin({ ...base, followSystem: true }).tokens.bg, T.SKINS.light.tokens.bg,
    '系统浅色：plain 的意图解析成 light');
  eq(TL.resolveSkin({ ...base, skin: 'amber', followSystem: true }).tokens.bg, T.SKINS.amber.tokens.bg,
    '琥珀是显式审美选择，不参与自动切换');
  eq(TL.resolveSkin({ ...base, skin: 'plain' }).tokens.bg, T.SKINS.plain.tokens.bg,
    '系统浅色但开关未开：plain 原样');
}

section('上一代 v2 配置（state.current）迁移到皮肤模型');
{
  // HEAD 时代的配置只有 state.current、没有 skin。不迁移的话 skin 为 undefined
  // 一路回落 plain —— 挑好的颜色无声丢失。
  const custom = { ...T.SKINS.plain.tokens, bg: '#101418' };
  const m = T.migrateState({
    version: 2,
    current: { tokens: custom, source: 'custom' },
    followSystem: true,
    advanced: false,
    themes: {},
  });
  eq(m.skin, 'custom', '非内置配色 → 草稿皮肤');
  eq(T.resolveSkin(m).tokens.bg, '#101418', '颜色经 resolveSkin 原样回来');
  eq(m.followSystem, true, '跟随系统开关保留');
  eq(m.current, undefined, '旧字段清除');
  eq(m.active, undefined, 'active 死字段不再写回');

  // 与内置皮肤完全一致的 current → 直接映射回内置 id，不留草稿
  const m2 = T.migrateState({ version: 2, current: { tokens: { ...T.SKINS.light.tokens } }, themes: {} });
  eq(m2.skin, 'light', '与出厂皮肤一致时映射回内置 id');
  eq(m2.custom, null, '不留多余草稿');
}

section('全局界面不透明度：迁移钳制');
{
  // 50% 是可读下限：配置里更低（手改/旧版本）要拉回区间，非法输入回落 100%
  eq(T.migrateState({ uiOpacity: 0.7 }).uiOpacity, 0.7, '区间内原样保留');
  eq(T.migrateState({ uiOpacity: 0.2 }).uiOpacity, 0.5, '低于下限拉回 50%');
  eq(T.migrateState({ uiOpacity: 3 }).uiOpacity, 1, '超过 1 拉回不透明');
  eq(T.migrateState({}).uiOpacity, 1, '缺省不透明');
  eq(T.migrateState({ uiOpacity: 'abc' }).uiOpacity, 1, '非法输入回落不透明');
  // 下限这个数在四个地方出现（index.html 的 range min、applyUiOpacity 的钳制、
  // migrateState 的钳制、uiPaintFloor 的层模型）。前三处是「用户能拖到哪」，
  // 第四处是「地板按多少漏光算」—— 第四处比前三处松就等于地板算少了。
  eq(T.UI_OPACITY_MIN, 0.5, 'UI_OPACITY_MIN 就是迁移钳制的那个下限');
}

section('漆层地板（uiPaintFloor）：透明窗上「面板 vs 桌面」的唯一守卫');
{
  // 这一节锁的是 2026-09-15 用户截图暴露的那条**完全没有守卫的旁路**：
  // 窗口 transparent:true，没设应用内底图时 --paint-op 直接等于 --ui-opacity，
  // 而透镜 / 明度带 / 加固 / backdropGuard 四层全都只在「有底图」的分支里工作。
  // 于是全局不透明度滑杆一拉低，桌面壁纸和别的窗口的正文就直接顶在面板文字后面。
  //
  // 桌面亮度在 webview 里采不到（这也是 preview-v2 / _probe-glass 结构上看不见这条
  // 路的原因：Playwright 无头页面背后是浏览器的合成底，不存在「桌面」这个图层），
  // 所以判据取「对本皮肤方向最不利」的那一端桌面。
  const ADV = {
    // 对抗性皮肤：低对比（字阶本来就窄，地板最容易被顶到 1）与高亮浅色
    lowcontrast: T.expandTokens({
      bg: '#2a2d33', panel: '#303338', text: '#b9bec6', accent: '#b9bec6',
      down: '#c98a4f', up: '#6f95bb', ok: '#6aa588', warn: '#b9a06a', error: '#bb7a7a',
    }),
    brightlight: T.expandTokens({
      bg: '#fdfdfe', panel: '#ffffff', text: '#2a2d33', accent: '#2a2d33',
      down: '#b5651d', up: '#1f6fb8', ok: '#1c7a52', warn: '#8a6a12', error: '#a83232',
    }),
  };
  const ALL = { ...Object.fromEntries(Object.entries(T.SKINS).map(([k, v]) => [k, v.tokens])), ...ADV };

  for (const [id, toks] of Object.entries(ALL)) {
    for (const solo of [false, true]) {
      const f = T.uiPaintFloor(toks, solo);
      const tag = `${id}${solo ? '（单层漆）' : '（两层漆）'}`;
      // 不退化到 1 是本节最重要的一条：判据无解 → 地板顶到 1 → 滑杆被系统拿走，
      // 那正是 b0c3db2 修掉的缺陷形状，也是用户连着两次报上来的同一件事。
      // 绝对档位（APCA 30/45）在深色皮肤上连 f=1 都解不出来（text3 本来就只有
      // Lc 23–25，那是字阶层级的设计意图），所以判据用的是**相对保留**。
      ok(f < 1, `${tag}：地板 ${f} < 1，滑杆还有行程（判据不退化）`);
      ok(f >= T.UI_OPACITY_MIN, `${tag}：地板 ${f} 不低于滑杆下限（低于就等于没垫）`);
      eq(f, Math.round(f * 100) / 100, `${tag}：地板落在 0.01 格上（与滑杆步长同格）`);

      // 保留判据在地板处真的成立 —— 只断言「地板存在」是没有内容的。
      const surfaces = [toks.panel, toks.panel2].filter((s) => /^#[0-9a-f]{6}$/i.test(s || ''));
      let worst = Infinity;
      let worstAt = '';
      for (const surf of surfaces) {
        for (const k of T.UI_PAINT_KEYS) {
          const base = Math.abs(T.apcaLc(toks[k], surf));
          if (base <= 0) continue;
          const eff = T.rgbToHex(T.uiComposite(toks, surf, f, solo));
          const got = Math.abs(T.apcaLc(toks[k], eff));
          if (got / base < worst) { worst = got / base; worstAt = `${k}@${surf}`; }
        }
      }
      ok(worst >= T.UI_PAINT_RETAIN - 1e-6,
        `${tag}：最差字色仍保住不透明基线的 ${(worst * 100).toFixed(1)}%（≥ ${T.UI_PAINT_RETAIN * 100}%，${worstAt}）`);

      // 再低一格就该失守 —— 否则地板是虚的（比需要的高，白拿走滑杆行程）。
      if (f > T.UI_OPACITY_MIN) {
        let held = true;
        for (const surf of surfaces) {
          for (const k of T.UI_PAINT_KEYS) {
            const base = Math.abs(T.apcaLc(toks[k], surf));
            if (base <= 0) continue;
            const eff = T.rgbToHex(T.uiComposite(toks, surf, f - 0.01, solo));
            if (Math.abs(T.apcaLc(toks[k], eff)) / base < T.UI_PAINT_RETAIN - 1e-9) held = false;
          }
        }
        ok(!held, `${tag}：再低一格（${(f - 0.01).toFixed(2)}）就失守，地板不比需要的高`);
      }
    }
    // 单层漆漏进来的桌面是两层的两倍（两层里 .frame 先用 --bg 挡掉 u=0.5 那一半），
    // 所以小窗 / 能量球的地板必须更高。拿主窗那份铺到小窗就是超支一倍。
    ok(T.uiPaintFloor(toks, true) > T.uiPaintFloor(toks, false),
      `${id}：单层漆的地板高于两层漆（小窗不能吃主窗那份预算）`);
  }

  // 最坏桌面按皮肤方向镜像：深色皮肤怕纯白桌面（亮字没地方落），浅色怕纯黑。
  eq(T.worstDesktop(T.SKINS.plain.tokens).r, 255, '深色皮肤按纯白桌面兜底');
  eq(T.worstDesktop(T.SKINS.light.tokens).r, 0, '浅色皮肤按纯黑桌面兜底');

  // 地板是**平的**：只依赖令牌，不随滑杆走。曾经试过让它跟着当前 u 走（把漏光
  // 预算算准），实测**非单调** —— plain 的地板在 u=0.68 触底 0.676、再回升到
  // u=0.50 处的 0.790，也就是「越往透明拖，面板越不透明」。那与「滑杆被系统拿走」
  // 是同一类缺陷，所以定义里把 u 钉死在下限。这条断言锁的是那个签名。
  eq(T.uiPaintFloor.length, 1, 'uiPaintFloor 只收 tokens（+ solo 默认参数），不收 uiOpacity');

  // 判据集合不许悄悄缩小：少一个键就是少守一档字色，而那正是三代玻璃契约每次
  // 返工的同一个根因。--accent 不在内是有据的（全仓库只作按钮底 / accent-color）。
  ok(T.UI_PAINT_KEYS.includes('text') && T.UI_PAINT_KEYS.includes('text3'),
    'UI_PAINT_KEYS 覆盖正文与弱字阶（弱字阶是最先糊的那一档）');
  ok(!T.UI_PAINT_KEYS.includes('accent'), 'accent 不进判据（它不作压在漆上的文字色）');
}

section('漆层地板的接线：只钳漆，不钳窗口底色 / 底图 / 滑杆');
{
  const UI = path.resolve(HERE, '../../src/NetPeek.App/ui');
  const tokensCss = fs.readFileSync(path.join(UI, 'tokens.css'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(UI, 'styles.css'), 'utf8');
  const miniCss = fs.readFileSync(path.join(UI, 'mini.css'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');

  // 无底图那条路上 --paint-op 必须过 max(滑杆, 地板)。这一行就是修复本体：
  // 原来它是裸的 var(--ui-opacity)，那条路上没有任何下界。
  ok(/--paint-op:\s*calc\(max\(var\(--ui-opacity\),\s*var\(--ui-paint-floor\)\)\)/.test(tokensCss),
    'tokens.css：--paint-op = max(--ui-opacity, --ui-paint-floor)');
  ok(/--ui-paint-floor:\s*0\b/.test(tokensCss),
    'tokens.css：--ui-paint-floor 缺省 0（令牌落地前不干预首帧）');

  // 「只钳漆」的另一半：窗口底色与底图仍按裸 --ui-opacity 一路淡到下限 ——
  // 桌面从缝隙、圆角外、底图后面透上来，那才是滑杆的主要观感。这两条一旦也吃了
  // 地板，滑杆就又被系统拿走了（用户连着两次报的就是这个）。
  ok(/\.frame\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--bg\)\s*calc\(var\(--ui-opacity\)\s*\*\s*100%\)/.test(stylesCss),
    'styles.css：.frame 的窗口底色仍按裸 --ui-opacity 淡出（不吃地板）');
  ok(/\.backdrop\s*\{[^}]*opacity:\s*var\(--ui-opacity\)/.test(stylesCss),
    'styles.css：.backdrop 底图仍按裸 --ui-opacity 淡出（不吃地板）');

  // has-bg 那条路的语义不许被这次改动带偏：它有自己的地板（--panel-op-floor），
  // 且全局不透明度在那条路上仍然作用于整体、不被地板钳住。
  ok(/body\.has-bg\s*\{\s*--paint-op:\s*calc\(max\(var\(--panel-op\),\s*var\(--panel-op-floor\)\)\s*\*\s*var\(--ui-opacity\)\)/.test(stylesCss),
    'styles.css：body.has-bg 的 --paint-op 语义不变（那条路有自己的地板）');

  // 滑杆本身不许被钳：min 必须还是 UI_OPACITY_MIN，不能被抬到地板上。
  const m = indexHtml.match(/id="uiOpacity"[^>]*\bmin="([\d.]+)"/);
  ok(m !== null, 'index.html 里能找到 uiOpacity 滑杆（改名了就同步这条断言）');
  if (m) {
    eq(Number(m[1]), T.UI_OPACITY_MIN,
      `滑杆 min ${m[1]} == UI_OPACITY_MIN（地板只垫漆层，不动滑杆行程）`);
  }

  // 小窗是单层漆，球漆 / 面板漆 / 内缘光照都必须走 --paint-op（含地板），
  // 而投影这类「投在桌面上的影子」仍按裸 --ui-opacity —— 影子不是压在字后面的漆。
  ok(/--o:\s*calc\(var\(--paint-op\)\s*\*\s*100%\)/.test(miniCss),
    'mini.css：能量球的 --o 走 --paint-op（含单层漆地板）');
  // 面板漆自 v3 起搬进 .panel::after：底图要垫在漆之下（.panel::before），
  // 而 blur 只能挂在只含底图的那一层上，写进 .panel 自己的 background 会连边线一起糊。
  ok(/\.panel::after\s*\{[^}]*background:\s*color-mix\(in srgb,\s*var\(--panel\)\s*calc\(var\(--paint-op\)\s*\*\s*100%\)/.test(miniCss),
    'mini.css：迷你窗面板漆走 --paint-op');
  // 球的窗口四周留 10px，offset 2 + blur 8 正好用满。
  ok(/box-shadow:\s*0 2px 8px rgb\(0 0 0 \/ calc\(0\.28 \* var\(--ui-opacity\)\)\)/.test(miniCss),
    'mini.css：能量球的落影仍按裸 --ui-opacity（投在桌面上的影子不是漆）');
}

section('能量球的几何：正圆 + 三处尺寸同源');
{
  // 「圆」是这个形态唯一的识别物，而它靠三处独立的数字凑出来：mini.css 的
  // .orb 宽高、mini.rs 的 ORB_SIZE/ORB_PAD、tauri.conf.json 的 mini 窗口尺寸。
  // 任何一处单独漂移都不报错，只是悄悄变形 —— 2026-09-19 用户两次否掉的正是
  // 「读起来是椭圆」，所以把这条契约钉死在回归里。
  const UI = path.resolve(HERE, '../../src/NetPeek.App/ui');
  const TAURI = path.resolve(HERE, '../../src/NetPeek.App/src-tauri');
  const miniCss = fs.readFileSync(path.join(UI, 'mini.css'), 'utf8');
  const miniRs = fs.readFileSync(path.join(TAURI, 'src/mini.rs'), 'utf8');
  const conf = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'));

  // CSS 侧：.orb 的宽高必须相等，且圆角是 50%（写死 46px 会在改边长时留下方块）。
  const orbRule = miniCss.match(/\n\.orb\s*\{([\s\S]*?)\n\}/);
  ok(orbRule !== null, 'mini.css 里能找到 .orb 规则（改名了就同步这条断言）');
  if (orbRule) {
    const w = Number((orbRule[1].match(/\bwidth:\s*(\d+)px/) || [])[1]);
    const h = Number((orbRule[1].match(/\bheight:\s*(\d+)px/) || [])[1]);
    eq(h, w, `.orb 宽高相等（${w}×${h}）—— 不等就被 50% 圆角渲染成椭圆`);
    ok(/border-radius:\s*50%/.test(orbRule[1]),
      '.orb 的圆角是 50%（跟着尺寸走，不是写死的半径）');

    // Rust 侧的球体尺寸与四周投影余量
    const size = Number((miniRs.match(/const ORB_SIZE:\s*f64\s*=\s*([\d.]+)/) || [])[1]);
    const pad = Number((miniRs.match(/const ORB_PAD:\s*f64\s*=\s*([\d.]+)/) || [])[1]);
    eq(size, w, `mini.rs 的 ORB_SIZE ${size} == mini.css 的 .orb 边长 ${w}（否则球不居中）`);

    // 窗口尺寸 = 球 + 两侧投影余量，且宽高相等
    const mini = (conf.app.windows || []).find((x) => x.label === 'mini');
    ok(mini != null, 'tauri.conf.json 里有 label="mini" 的窗口');
    if (mini) {
      eq(mini.width, size + pad * 2,
        `mini 窗口宽 ${mini.width} == ORB_SIZE + ORB_PAD×2（${size} + ${pad}×2）`);
      eq(mini.height, mini.width,
        `mini 窗口宽高相等（${mini.width}×${mini.height}）—— 窗口不方，球就没法是圆的`);
    }

    // 投影必须落在余量之内：offset + blur ≤ pad，否则被透明窗口的硬边界裁成直线。
    const sh = miniCss.match(/\.orb\s*\{[\s\S]*?box-shadow:\s*0\s+(\d+)px\s+(\d+)px/);
    ok(sh !== null, 'mini.css：.orb 有落影声明');
    if (sh) {
      const spend = Number(sh[1]) + Number(sh[2]);
      ok(spend <= pad,
        `球的落影 offset+blur = ${spend} ≤ ORB_PAD ${pad}（超了会被透明窗口裁成直线）`);
    }
  }

  // 液面是**纵向**灌注：高度由 --level 驱动。胶囊那版用的是 width，
  // 留着 width 就是「圆形球体里横向推进」——形状换了，动作没换。
  ok(/\.orb-level i\s*\{[\s\S]*?height:\s*var\(--level,\s*0%\)/.test(miniCss),
    'mini.css：能量液的高度由 --level 驱动（从球底向上灌，不是横向推进）');
  ok(/\.orb-level\s*\{[\s\S]*?overflow:\s*hidden/.test(miniCss),
    'mini.css：能量液被球轮廓裁住（少了它液面两端戳出球外）');

  // 球上只有两个读数，没有状态点。2026-09-20 用户否掉了两版：纵排三行顶上那颗
  // 7px「状态核心」（白热内核 + 同色辉光），以及后来挪到左下 8 点方向的修正版 ——
  // 原话「去掉能量球上的那个小绿点」。否掉的不是位置：92px 的球里已经是
  // 下载/上传两个读数，状态点塞进去就要跟数据抢视觉重量，而它一个字节都不代表。
  // 这条钉住的是「球上只留速率」：状态点只要有一处复活，这颗点就会自己长回来
  // （CSS 有规则、JS 有赋值，只是没人再为它报错）。
  // 状态的正式位置是 .panel-dot（面板头）与主界面顶栏，不在球上。
  const miniHtml = fs.readFileSync(path.join(UI, 'mini.html'), 'utf8');
  const miniJs = fs.readFileSync(path.join(UI, 'mini.js'), 'utf8');
  const orbMarkup = (miniHtml.match(/<div id="orb"[\s\S]*?\n  <\/div>/) || [''])[0];
  eq((orbMarkup.match(/class="orb-rate\b/g) || []).length, 2,
    '球内正好两组读数（下载 / 上传）——多一组少一组都是排版事故');
  ok(!/class="orb-dot|class="orb-status/.test(orbMarkup),
    '球内没有状态点元素（用户已否掉两版，理由见本段注释）');
  ok(!/\.orb-dot\s*\{|\.orb-status\s*\{/.test(miniCss),
    'mini.css 里没有状态点的样式规则（留一条就是给它留了复活的路）');
  ok(!/@keyframes\s+orb-core/.test(miniCss),
    'mini.css 里没有状态点的呼吸关键帧（点没了，动画没有载体）');
  ok(!/orbDot|orbStatus/.test(miniJs),
    'mini.js 里没有状态点的元素引用（取到 null 的引用会在下次改 paintStatus 时空指针）');

  // 液面必须是**流动的正弦波**，不是一条边在原地晃。
  // 2026-09-21 用户两次指出，两次都不是「水位不够高」：
  //   ①「都是平着上下，没有数据起伏的那种波浪感」→ 液柱顶边是水平直线；
  //   ②「不是水位的问题，而是水位的动画应该呈现波浪状」→ 上一版改成两块大椭圆
  //      各推 10%，形状几乎不变，读起来仍是一条边在微微晃。
  // 试过并否掉的做法记在这里，免得下一个人再走一遍：
  //   · 圆角方块绕中心旋转（CodePen 上最常见那一类）：波形确实来自「非圆形
  //     轮廓转动」，但振幅是容器高的固定比例（约 40%），既不可调、也远大于
  //     球上这条 14px 的液面带 —— 实机装上去是一记横扫的斜切和一口深勺。
  //   · 径向渐变拼一排半圆：能横向流过，但峰谷交界处是尖角，读作锯齿。
  // 最终用 SVG 正弦路径：振幅/波长/相位都是显式参数，起伏连续无尖角。
  //
  // 这几条钉的都是会**哑失败**的地方（波形全是 CSS，写错不报错，球看着还是老样子）：
  ok(/class="orb-wave"/.test(miniHtml), '球内有液面波形层（.orb-wave）');
  ok(/<svg[^>]*class="orb-wave"/.test(miniHtml),
    '波形是 SVG（路径才能给出连续的正弦起伏，渐变拼圆弧在峰谷交界是尖角）');
  ok(/orb-wave-track/.test(miniHtml), '波形有可位移的轨道组（.orb-wave-track）');
  ok(/class="orb-wave-track"[\s\S]{0,900}?transform="translate\(/.test(miniHtml),
    '轨道右侧复制了一个完整周期 —— 位移一个波长后才无缝，少了它循环点会跳');
  ok(/\.orb-wave\s*\{[\s\S]*?bottom:\s*calc\(var\(--level,\s*0%\)/.test(miniCss),
    'mini.css：波形贴着水位线走（不跟 --level 联动就会浮在固定高度）');
  const kf = miniCss.match(/@keyframes\s+orb-wave-a\s*\{([\s\S]*?)\n\}/);
  ok(kf !== null, 'mini.css：有波形流动关键帧 orb-wave-a');
  if (kf) {
    ok(/translateX/.test(kf[1]),
      '关键帧位移走 translateX（动 transform 才在合成层上跑，不触发重排）');
  }
  ok(/\.orb-wave-track\s*\{[\s\S]*?animation:\s*orb-wave-a/.test(miniCss),
    'mini.css：轨道带 animation（静态波形读不出「在流」）');
  // --level 必须写在 .orb 上：液柱（高度）与波形（bottom 基准）是两个**兄弟**
  // 消费者，变量挂在液柱自己身上时波形继承不到，calc 静默退化成 0、波面沉到球底。
  // 2026-09-21 实测踩过：getComputedStyle 的 bottom 是 -4px 而不是 57.6px。
  ok(/els\.orb\.style\.setProperty\('--level'/.test(miniJs),
    "mini.js：--level 写在 .orb（共同祖先）上，液柱与波形都要读它");
  ok(/\.orb-wave[^>]*\{\s*animation:\s*none|\.orb-wave-track\s*\{\s*animation:\s*none/.test(miniCss),
    'mini.css：reduced-motion 下液面停动（常驻动画必须能关）');


}

section('漆层地板随令牌上屏：applyTokens 写 --ui-paint-floor');
{
  // 地板只依赖令牌，所以它的写入点就该是令牌上屏那一处 —— 换肤必须重算，
  // 拖滑杆不必（CSS 的 max() 自己会挑）。分两个上下文测，因为 solo 是每个 webview
  // 固定的一档：主窗两层漆、小窗单层漆。
  const mkCtx = () => {
    const props = {};
    const ctx = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js'], {
      document: {
        documentElement: {
          style: { setProperty(k, v) { props[k] = v; } },
          classList: { add() {}, remove() {} },
        },
      },
      matchMedia: () => ({ matches: false }),
    });
    return { props, T: ctx.NetPeekTheme };
  };

  const main = mkCtx();
  main.T.applyTokens(main.T.SKINS.plain.tokens, { silent: true });
  eq(main.props['--ui-paint-floor'], String(T.uiPaintFloor(T.SKINS.plain.tokens, false)),
    '主窗上屏写入两层漆的地板');

  const mini = mkCtx();
  mini.T.applyTokens(mini.T.SKINS.plain.tokens, { silent: true, solo: true });
  eq(mini.props['--ui-paint-floor'], String(T.uiPaintFloor(T.SKINS.plain.tokens, true)),
    '小窗（solo）上屏写入单层漆的地板');
  ok(Number(mini.props['--ui-paint-floor']) > Number(main.props['--ui-paint-floor']),
    '同一套皮肤下小窗的地板更高（单层漆漏进来的桌面是两倍）');

  // 换肤要跟着变：地板是令牌的函数，不是一次性常量。
  main.T.applyTokens(main.T.SKINS.light.tokens, { silent: true });
  eq(main.props['--ui-paint-floor'], String(T.uiPaintFloor(T.SKINS.light.tokens, false)),
    '换肤后地板重算');

  // mini.js 必须真的传 solo —— 漏了这个参数是个哑失败：小窗照样有地板，
  // 只是那份地板按两层漆算，超支一倍，而单测和预览都看不出来。
  const miniJs = fs.readFileSync(path.resolve(HERE, '../../src/NetPeek.App/ui/mini.js'), 'utf8');
  ok(/applyTokens\(payload\.tokens,\s*\{[^}]*solo:\s*true/.test(miniJs),
    'mini.js 上屏时带 solo: true（漏了就按两层漆算，小窗超支一倍）');
}

section('小窗同步主窗按壁纸计算的面板地板');
{
  const UI = path.resolve(HERE, '../../src/NetPeek.App/ui');
  const themeUi = fs.readFileSync(path.join(UI, 'theme-ui.js'), 'utf8');
  const miniJs = fs.readFileSync(path.join(UI, 'mini.js'), 'utf8');

  ok(/panelOpFloor\s*=\s*clamped\s*\?\s*guard\.floor\s*:\s*0/.test(themeUi),
    'theme-ui.js：守卫每次重算都更新广播地板，无图 / 贴膜 / 未钳制时归零');
  ok(/backdrop:\s*\{[\s\S]*?\bpanelOpFloor\s*,[\s\S]*?\blens:/.test(themeUi),
    'theme-ui.js：backdrop payload 携带 panelOpFloor');
  ok(/setProperty\('--panel-op-floor',\s*has\s*\?\s*String\(num\(b\.panelOpFloor,\s*0\)\)\s*:\s*'0'\)/.test(miniJs),
    'mini.js：有图消费主窗地板，无图主动清零旧值');
  ok(!/setProperty\('--panel-op-floor',\s*'0'\);\s*\n\s*root\.style\.setProperty\('--bg-blur'/.test(miniJs),
    'mini.js：不再在有图路径把主窗地板写死为 0');
}

section('小窗主题共享：贴膜模式也发壁纸 + 底图磨砂与主窗表面对齐');
{
  const UI = path.resolve(HERE, '../../src/NetPeek.App/ui');
  const themeUi = fs.readFileSync(path.join(UI, 'theme-ui.js'), 'utf8');
  const miniJs = fs.readFileSync(path.join(UI, 'mini.js'), 'utf8');
  const miniCss = fs.readFileSync(path.join(UI, 'mini.css'), 'utf8');

  // 贴膜不再剥图：两个剥图点都必须消失。剥图的后果是「主窗有壁纸、小窗一块
  // 素色」—— 小窗复刻不了贴膜的坐标系对齐，但退回复底铺法比没有图诚实。
  ok(!/if \(wrap\) return \{ background: '', backdrop: null \};/.test(themeUi),
    'theme-ui.js：贴膜模式不再把壁纸从广播里剥掉');
  ok(/backdrop:\s*\{[\s\S]*?panelOpacity:\s*wrap \? effectiveWrapOpacity\(\)/.test(themeUi),
    'theme-ui.js：贴膜漆浓度取 effectiveWrapOpacity（与主窗膜浓度同源，含地板）');
  ok(/lens:\s*wrap \? 'saturate\(1\)'/.test(themeUi),
    'theme-ui.js：贴膜发中性透镜 saturate(1)（主窗的膜不带透镜；发 none 会让整条 filter 声明作废）');
  ok(/backdrop:\s*\{[\s\S]*?wrap,/.test(themeUi),
    'theme-ui.js：payload 携带 wrap 标记');
  ok(!/backdropStyle === 'wrap'\) return ''/.test(miniJs),
    'mini.js：resolveBg 不再按贴膜剥图');
  ok(/classList\.toggle\('wrap-bg',\s*has && !!b\.wrap\)/.test(miniJs),
    'mini.js：html.wrap-bg 类随 payload.wrap 开关');
  ok(/dim:\s*wrap \? 0 :/.test(miniJs),
    'mini.js：启动首帧的贴膜分支口径与广播一致（无纱）');

  // 底图磨砂档：主窗表面是 backdrop-filter blur(16px) 的固定磨砂，小窗的形态
  // 元素整个都是「表面」，滑杆为 0 时壁纸原样透出、和主窗表面的读感割裂。
  ok(/html\s*\{\s*--mini-blur:\s*max\(var\(--bg-blur,\s*0px\),\s*16px\)/.test(miniCss),
    'mini.css：--mini-blur 置底保底 16px（与主窗表面磨砂同档）');
  ok(/html\.wrap-bg\s*\{\s*--mini-blur:\s*var\(--bg-blur,\s*0px\)/.test(miniCss),
    'mini.css：贴膜底图跟滑杆走（主窗的膜是清晰取景）');
  ok(/\.panel::before\s*\{[^}]*filter:\s*blur\(var\(--mini-blur\)\)/.test(miniCss),
    'mini.css：面板底图消费 --mini-blur');
  ok(/\.orb-bg\s*\{[^}]*filter:\s*blur\(var\(--mini-blur\)\)/.test(miniCss),
    'mini.css：球底图消费 --mini-blur');
  ok(!/blur\(var\(--bg-blur\)\)/.test(miniCss),
    'mini.css：不再有裸消费 --bg-blur 的磨砂声明（有就绕过了保底档）');
  ok(/inset:\s*calc\(var\(--mini-blur\) \* -1\.5 - 6px\)/.test(miniCss),
    'mini.css：负外扩公式跟着磨砂档走（软边永远吃得掉）');
}

section('对比度守卫补 panel-2（输入框 / 顶栏底色）');
{
  // #008383 对 light 的 panel 恰好 4.59 达标，但对更暗的 panel-2 只有 3.81 ——
  // 旧守卫只看 panel，这个盲区里的次要字在输入框里会读不清。
  const L = T.SKINS.light.tokens;
  const bad = { ...L, text2: '#008383' };
  ok(T.contrast(T.hexToRgb(bad.text2), T.hexToRgb(L.panel)) >= 4.5, '前提：对 panel 达标');
  ok(T.contrast(T.hexToRgb(bad.text2), T.hexToRgb(L.panel2)) < 4.5, '前提：对 panel-2 不达标');

  const g = T.guardTokens(bad);
  const f = g.tokens.text2;
  ok(T.contrast(T.hexToRgb(f), T.hexToRgb(L.panel)) >= 4.5, '修后对 panel 仍达标');
  ok(T.contrast(T.hexToRgb(f), T.hexToRgb(L.panel2)) >= 4.5, '修后对 panel-2 也达标');
  ok(g.adjusted.includes('text2'), '修正进回执，UI 能说出来');
}

section('取色：ColorThief 适配器与平均色回落');
{
  // 适配器契约：主色 = 真实占比最大的成员，强调色 = 「彩度 × √占比」评分最高者；
  // 断言的是这条设计决策仍然成立，而不是中位切分的内部实现。
  // 桩要在 vendor 加载之后再注入 —— color-thief 的 UMD 会把自己挂到 window 上，
  // 先注入只会被它覆盖掉。
  const StubThief = class {
    getColor() { return [18, 20, 24]; }                       // 深海军蓝（主色）
    getPalette() { return [[18, 20, 24], [210, 80, 60], [70, 130, 180]]; }
  };
  const ctxS = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js']);
  ctxS.ColorThief = StubThief;
  const TS = ctxS.NetPeekTheme;
  const tiny = { data: new Uint8ClampedArray(16), width: 2, height: 2 }; // 桩路径不读像素
  const tokens = TS.tokensFromImage(tiny, { tagName: 'IMG' });
  // 表面归一：窗口底不再吃主色原样，只继承色相与明暗（彩度近零、明度在深色档带内）
  ok(Math.abs(TS.luminance(TS.hexToRgb(tokens.bg)) - TS.luminance({ r: 18, g: 20, b: 24 })) < 0.02,
    `窗口底保持主色的明暗（${tokens.bg}）`);
  ok(TS.okChroma(TS.hexToRgb(tokens.bg)) <= 0.031, '窗口底彩度被钳到近零（表面归一）');
  ok(TS.luminance(TS.hexToRgb(tokens.panel)) > TS.luminance(TS.hexToRgb(tokens.bg)),
    '深色 UI：面板比窗口底抬高一档');
  ok(TS.luminance(TS.hexToRgb(tokens.bg)) < 0.5, '深色主色 → 深色 UI');
  // 分工：accent 取评分最高成员（红，管交互）；down 取其后不撞族的成员（钢蓝，管数据）
  // —— 原来 accent 和 down 都吃最饱和色，主按钮与下载图表同色。
  eq(tokens.accent.toLowerCase(), TS.ensureContrast('#d2503c', tokens.panel).toLowerCase(),
    '交互强调色取评分最高成员（红），并过守卫');
  eq(tokens.down.toLowerCase(), TS.ensureContrast('#4682b4', tokens.panel).toLowerCase(),
    '下载语义色取次位成员（钢蓝），不再与交互色同色');
  ok(tokens.up.toLowerCase() !== tokens.down.toLowerCase(), '上行色不与下载色撞色（钢蓝 → 紫兜底）');
  ok(T.contrast(T.hexToRgb(tokens.down), T.hexToRgb(tokens.panel)) >= 4.5, '下载色相对面板达标');

  // 回落：真库在沙箱里没有 canvas 可用（getColor 抛 document is not defined），
  // 恰好真实地走到平均色回落 —— 绝不能黑屏或抛异常。
  const darkPx = { data: new Uint8ClampedArray(32).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 14)), width: 2, height: 4 };
  const fb = T.tokensFromImage(darkPx, null);
  ok(T.luminance(T.hexToRgb(fb.bg)) < 0.05, '取色不可用时回落到平均色（并归一成深底）');
  ok(T.contrast(T.hexToRgb(fb.text), T.hexToRgb(fb.panel)) >= 4.5, '回落后的文字仍过守卫');
}

section('压暗纱色调：scrimTint 有颜色、足够暗');
{
  // 纱从纯黑升级为「有颜色的暗」（Mica 式 tint）。约束两条：
  // ① 亮度钳在 0.1 以内 —— backdropFloor 的「底图 × 黑纱」近似模型要继续保守；
  // ② 彩色输入保留色相（压暗不换族），灰黑输入回落中性缺省。
  const ctxC = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js']);
  const hueOf = (hex) => ctxC.chroma(hex).get('hsl.h') || 0;
  const blue = T.scrimTint('#4a6fa5');
  ok(T.luminance(T.hexToRgb(blue)) <= 0.1 + 1e-9, `tint 亮度钳到 0.1 以内（${blue}）`);
  ok(blue.toLowerCase() !== '#0b0c0e', '彩色输入不回落中性缺省');
  const src = hueOf('#4a6fa5');
  let d = Math.abs(hueOf(blue) - src) % 360;
  if (d > 180) d = 360 - d;
  ok(d <= 30, `tint 与源色同族（色相距 ${d.toFixed(1)}° ≤ 30°）`);
  eq(T.scrimTint(''), '#0b0c0e', '非法输入回落中性缺省');
  eq(T.scrimTint('#111214'), '#111214', '已经足够暗的原样保留');
}

section('OKLab：往返精度与混色不偏色');
{
  // 混色从 sRGB 搬进 OKLab。往返误差必须 ≤1/255 通道，否则派生键会系统性漂移
  for (const hex of ['#1b1d21', '#e57373', '#4cc38a', '#f0963f', '#62a9e8', '#f2f3f5']) {
    const rt = T.oklabToRgb(T.rgbToOklab(T.hexToRgb(hex)));
    const a = T.hexToRgb(hex);
    ok(Math.abs(rt.r - a.r) <= 1 && Math.abs(rt.g - a.g) <= 1 && Math.abs(rt.b - a.b) <= 1,
      `${hex} 往返 ≤1/通道（got ${JSON.stringify(rt)}）`);
  }
  // 朝黑混不换族：饱和蓝对半压暗后色相距离仍近（sRGB 插值会把暗蓝混脏）
  const darkened = T.mixOk(T.hexToRgb('#2255cc'), { r: 0, g: 0, b: 0 }, 0.5);
  let d = Math.abs(T.okHue(T.rgbToOklab(darkened)) - T.okHue(T.rgbToOklab(T.hexToRgb('#2255cc')))) % 360;
  if (d > 180) d = 360 - d;
  ok(d < 4, `OKLab 朝黑混保持色相（偏 ${d.toFixed(1)}°）`);
}

section('像素权重：最近邻归属计数');
{
  // 32 像素：24 红 8 蓝。采样步长是每 4 像素采 1（i += 16 字节），
  // 恰好采到 0/4/…/28 号共 8 个样本 → 6 红 2 蓝，权重 0.75 / 0.25。
  const w = 8, h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  const put = (i, r, g, b) => { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; };
  for (let i = 0; i < 24; i++) put(i, 200, 40, 40);
  for (let i = 24; i < 32; i++) put(i, 40, 60, 200);
  const ws = T.paletteWeights({ data, width: w, height: h }, [
    { r: 200, g: 40, b: 40, weight: 0 }, { r: 40, g: 60, b: 200, weight: 0 },
  ]);
  ok(Math.abs(ws[0] - 0.75) < 1e-9 && Math.abs(ws[1] - 0.25) < 1e-9,
    `权重按真实占比（got ${ws.map((x) => x.toFixed(2))}）`);
}

section('强调色评分：彩度 × 占比，不是纯彩度也不是纯占比');
{
  // 钢蓝占 80%（彩度 0.13），正红只占 20% 但彩度更高（0.19）—— √占比在两者间
  // 取势：0.13×√0.8 ≈ 0.119 > 0.19×√0.2 ≈ 0.085，评分选蓝（纯彩度会选红）。
  const pick = T.pickBase([
    { r: 70, g: 110, b: 190, weight: 0.8 },
    { r: 210, g: 60, b: 50, weight: 0.2 },
  ]);
  ok(pick.accent.g > pick.accent.r, '占比主导时选低彩度多数派（蓝）');
  // 份额追平（50/50）后彩度说了算：0.19×√0.5 > 0.13×√0.5
  const pick2 = T.pickBase([
    { r: 70, g: 110, b: 190, weight: 0.5 },
    { r: 210, g: 60, b: 50, weight: 0.5 },
  ]);
  ok(pick2.accent.r > pick2.accent.g, '平分时选高彩度者（红）');
}

section('文字色随壁纸色温');
{
  // 冷壁纸（钢蓝主色）→ 文字掺冷；暖壁纸（橙主色）→ 文字掺暖。
  // 原实现写死暖白 #f2e6dc，蓝壁纸配暖白字是色温打架。
  const mk = (r, g, b) => {
    const data = new Uint8ClampedArray(16);
    for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
    return { data, width: 2, height: 2 };
  };
  const cool = T.tokensFromImage(mk(70, 110, 190), null);
  ok(T.hexToRgb(cool.text).b >= T.hexToRgb(cool.text).r, '冷壁纸 → 文字偏冷（B ≥ R）');
  const warm = T.tokensFromImage(mk(200, 120, 50), null);
  ok(T.hexToRgb(warm.text).r >= T.hexToRgb(warm.text).b, '暖壁纸 → 文字偏暖（R ≥ B）');
  ok(T.contrast(T.hexToRgb(cool.text), T.hexToRgb(cool.panel)) >= 4.5, '色温文字仍过守卫');
}

section('深浅偏好：image 皮肤可钉死方向');
{
  const mk = (r, g, b) => {
    const data = new Uint8ClampedArray(16);
    for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
    return { data, width: 2, height: 2 };
  };
  const darkImg = mk(20, 24, 30);
  ok(T.luminance(T.hexToRgb(T.tokensFromImage(darkImg, null, 'auto').bg)) < 0.5, 'auto：暗图 → 深色');
  ok(T.luminance(T.hexToRgb(T.tokensFromImage(darkImg, null, 'light').bg)) > 0.5, '钉 light：暗图也出浅色基底');
  ok(T.luminance(T.hexToRgb(T.tokensFromImage(mk(220, 220, 225), null, 'dark').bg)) < 0.5, '钉 dark：亮图也出深色基底');
}

section('取色色板与深浅偏好：迁移保留');
{
  const m = T.migrateState({
    skin: 'image',
    backgroundImage: 'wallpapers/wall-1.jpg',
    imageMode: 'dark',
    imageDraft: { tokens: { ...T.SKINS.plain.tokens }, source: 'standard', palette: [{ hex: '#aa2233', weight: 0.4 }, { hex: 'bad' }] },
    themes: {},
  });
  eq(m.imageMode, 'dark', '合法偏好原样保留');
  eq(m.imageDraft.palette.length, 1, '非法色条目被滤掉，合法的保留');
  eq(T.migrateState({ skin: 'image', backgroundImage: 'x', themes: {} }).imageMode, 'auto', '缺省回落 auto');
}

section('显示方式与背景亮度：迁移与守卫');
{
  const m = T.migrateState({ skin: 'image', backgroundImage: 'x', backdropStyle: 'wrap', wrapOpacity: 0.5, bgBrightness: 1.3, themes: {} });
  eq(m.backdropStyle, 'wrap', '合法方式原样保留');
  eq(m.wrapOpacity, 0.5, '合法浓度原样保留');
  eq(m.bgBrightness, 1.3, '合法亮度原样保留');
  const m2 = T.migrateState({ skin: 'image', backgroundImage: 'x', backdropStyle: 'flat', wrapOpacity: 3, bgBrightness: 9, themes: {} });
  eq(m2.backdropStyle, 'underlay', '非法方式回落置底');
  eq(m2.wrapOpacity, 0.9, '超界浓度钳回区间');
  eq(m2.bgBrightness, 1.5, '超界亮度钳回 1.5');
  eq(T.migrateState({ skin: 'image', backgroundImage: 'x', themes: {} }).bgBrightness, 1, '亮度缺省不调');
  // resolveSkin 带出显示方式与浓度（小窗等消费方按需读取）
  const r = T.resolveSkin(m);
  eq(r.backdropStyle, 'wrap', 'resolveSkin 带出显示方式');
  eq(r.wrapOpacity, 0.5, 'resolveSkin 带出浓度');
  // 贴膜浓度地板（wrapFloor）：守护档位 2026-09-15 从 WCAG 比值换成 APCA —— 亮侧
  // 主文字 Lc 75 / 次要 Lc 60，暗侧只守次要文字 Lc 45（贴膜天然是装饰性的，弱字阶
  // 不参与，否则膜会被推成不透明面板、模式失去意义）。
  // 换度量后暗图地板上移 0.55 → 0.58：亮字压暗底时 APCA 45 比 WCAG 4.5 严约 0.03
  // 个不透明度（探针实测 op=0.4 时合成面 #393b3d、text2 Lc 42.9；op=0.58 才到 45）。
  // 0.58 仍在滑杆区间（0.4–0.9）的中段，贴膜的装饰性保留 —— 这正是本条要守的东西。
  const plain = T.SKINS.plain.tokens;
  ok(T.wrapFloor(plain, 0.92, 0.4) > 0.6, '亮图：贴膜浓度地板显著抬高');
  const darkFloor = T.wrapFloor(plain, 0.066, 0.4);
  ok(darkFloor <= 0.6, `暗图：浓度地板落在可用区间（实测 ${darkFloor}）`);
  // 地板生效后，旧口径（WCAG 比值）也该同时成立 —— 两套度量在同一点互相印证，
  // 换度量不该把原来就达标的组合弄坏。
  const f = T.wrapFloor(plain, 0.92, 0.4);
  const eff = T.effectivePanel(plain, 0.92, 0, f);
  ok(T.contrast(T.hexToRgb(plain.text), T.hexToRgb(eff)) >= 4.5, '主文字按地板调和后 ≥ 4.5');
  ok(T.contrast(T.hexToRgb(plain.text2), T.hexToRgb(eff)) >= 3.2, '次要文字按地板调和后 ≥ 3.2');
  // 亮度进守卫:提亮亮图,等效亮度上升,浓度地板随之抬高(线性近似,钳到 1)
  const fBright = T.wrapFloor(plain, Math.min(1, 0.92 * 1.3), 0.4);
  ok(fBright >= f, '提亮后浓度地板不降');
}

section('有效深浅上报给后端（§37 托盘原生菜单跟随主题）');
{
  // 托盘菜单是系统画的 HMENU，只吃「应用是深是浅」这一个进程级开关；
  // 而有效深浅只有皮肤引擎知道（皮肤能把方向钉死，与系统设置无关）。
  // 这一节钉住的就是这条线：applyTokens 上屏的那个深浅，必须原样上报给后端。
  const invokes = [];
  const ctx = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js'], {
    document: {
      documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {} } },
    },
    matchMedia: () => ({ matches: false }),
  });
  ctx.__TAURI__ = { core: { invoke: (cmd, args) => { invokes.push([cmd, args]); return Promise.resolve(); } } };
  const TT = ctx.NetPeekTheme;

  // 朴素（深底浅字）→ 深色；浅色皮肤 → 浅色
  TT.applyTokens(TT.SKINS.plain.tokens, { silent: true });
  eq(invokes.length, 1, '上屏一次令牌上报一次');
  eq(invokes[0][0], 'set_tray_theme', '上报的是托盘主题命令');
  eq(invokes[0][1].dark, true, '深底皮肤 → 告诉后端是深色');

  // 同一个值重复上屏不再过一次 IPC：拖不透明度滑杆会让 applyTokens 每帧跑一次
  TT.applyTokens(TT.SKINS.plain.tokens, { silent: true });
  eq(invokes.length, 1, '深浅没变就不重复上报（滑杆每帧上屏也不能刷 IPC）');

  TT.applyTokens(TT.SKINS.light.tokens, { silent: true });
  eq(invokes.length, 2, '换到浅色皮肤：必须上报');
  eq(invokes[1][1].dark, false, '浅底皮肤 → 告诉后端是浅色');

  // 没有 __TAURI__（浏览器里直接开 index.html、预览脚本）时不能抛
  const plainCtx = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js'], {
    document: {
      documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {} } },
    },
    matchMedia: () => ({ matches: false }),
  });
  let threw = '';
  try { plainCtx.NetPeekTheme.applyTokens(plainCtx.NetPeekTheme.SKINS.plain.tokens, { silent: true }); } catch (e) { threw = String(e); }
  eq(threw, '', '无 __TAURI__ 时静默跳过，不抛');

  // invoke 失败（旧后端没这个命令 / IPC 挂了）也不能冒泡出来
  const failCtx = loadScripts(['vendor/chroma.min.js', 'vendor/color-thief.min.js', 'theme.js'], {
    document: {
      documentElement: { style: { setProperty() {} }, classList: { add() {}, remove() {} } },
    },
    matchMedia: () => ({ matches: false }),
  });
  failCtx.__TAURI__ = { core: { invoke: () => { throw new Error('no such command'); } } };
  let threw2 = '';
  try { failCtx.NetPeekTheme.applyTokens(failCtx.NetPeekTheme.SKINS.plain.tokens, { silent: true }); } catch (e) { threw2 = String(e); }
  eq(threw2, '', 'invoke 同步抛错时吞掉，不影响上屏');
}

section('像素审计的门槛与加固档位同源（跨文件不许各写一份）');
{
  // preview-v2.mjs 的像素审计是本仓库唯一的**地面真值**（直接量截图像素，不信模型）。
  // 它的门槛必须等于加固的弱字阶档位，否则两种失效方式各一个方向：
  //   门槛 > 档位 —— 加固刚好推到达标的 text3 会被自己的门禁判成失败（这次实际发生：
  //                  门槛写着 32，而弱档是 30，差 2 分就能让全链回归常态红）；
  //   门槛 < 档位 —— 门禁比实现松，加固退化了它也看不见。
  // 两个文件各写一份字面量是这类漂移的根源，所以这条断言直接读那份源码来比。
  // 读源码而不是 import：preview-v2.mjs 顶层就起 http 服务、连 playwright，import
  // 它等于在单测里跑一遍完整预览链。
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.resolve(HERE, '../preview-v2.mjs'), 'utf8');
  const m = src.match(/const\s+AUDIT_MIN_LC\s*=\s*(\d+(?:\.\d+)?)/);
  ok(m !== null, 'preview-v2.mjs 里能找到 AUDIT_MIN_LC（改名了就同步这条断言）');
  if (m) {
    eq(Number(m[1]), T.GLASS_HARDEN_WEAK_LC,
      `像素审计门槛 ${m[1]} == 加固弱字阶档位 ${T.GLASS_HARDEN_WEAK_LC}`);
  }
  // 门槛同时是 APCA 对「装饰性部件」的下限 30：低于它就不是「弱」而是看不见。
  eq(T.GLASS_HARDEN_WEAK_LC, 30, '弱字阶档位就是 APCA 装饰线 30（这个值有外部依据，不是手调的）');
}

section('覆盖性检查：每个作前景用的令牌都必须有一层可读性负责人');
{
  // 这一节是本轮全部返工的**根因锁**，不是又一条数值断言。
  //
  // 三代玻璃契约每次都栽在同一件事上：某个令牌**在 CSS 里当文字色用**，却不在任何
  // 一层可读性判据的覆盖范围内。于是它渲染得出来、单测全绿、只有人眼看得出问题：
  //   第一代 —— text3 与全部语义色不在契约里（plain 实测 text3 Lc 13.1、error 32.6）；
  //   第二代 —— 同上，外加自校准把 text2 的目标偷偷打到 37.7；
  //   §45.5 —— up/down 掉到 Lc 32.5/34.6 时，当时的判据一条都没响。
  // 每次都是「加一条断言修这一个键」，下一个漏网的键照旧要等人眼发现。所以这里换成
  // **反向**的检查：不问「这几个键达标吗」，而是从 CSS 实际用法出发，问
  // 「有没有哪个前景令牌没人负责」。新增一个 color: var(--x) 的用法就会让它失败。
  //
  // 负责人只有三种，允许的口径写死在下面这张表里 —— 想加第四种，就得先在这里说清楚。
  const UI_DIR = path.resolve(HERE, '../../src/NetPeek.App/ui');
  const cssText = ['styles.css', 'mini.css']
    .map((f) => fs.readFileSync(path.join(UI_DIR, f), 'utf8')).join('\n');

  // CSS 变量名 → token 键名（applyTokens 那张映射的反向）
  const VAR_TO_KEY = {
    '--text': 'text', '--text-2': 'text2', '--text-3': 'text3',
    '--down': 'down', '--up': 'up', '--ok': 'ok', '--warn': 'warn', '--error': 'error',
    '--accent': 'accent', '--accent-ink': 'accentInk', '--sel-bar': 'selBar',
    '--panel': 'panel', '--panel-hi': 'panelHi', '--panel-2': 'panel2',
    '--bg': 'bg', '--line': 'line', '--line-soft': 'lineSoft',
  };

  // 扫「作为前景色」的用法：color: 声明里出现的 var(--x)。
  // 只认 color（不认 background/border/box-shadow/outline）—— 前景是「压在合成面上被
  // 读」的那一类，也正是 APCA 判据成立的前提。
  const fgKeys = new Set();
  for (const m of cssText.matchAll(/(^|[;{}])\s*color\s*:\s*([^;}]+)/g)) {
    for (const v of m[2].matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const k = VAR_TO_KEY[v[1]];
      if (k) fgKeys.add(k);
    }
  }
  // 前提自检：扫不到东西的正则会让整节静默通过 —— 那是最坏的绿。
  ok(fgKeys.size >= 8, `扫到 ${fgKeys.size} 个作前景用的令牌（正则失效时这条先失败）`);
  ok(fgKeys.has('text') && fgKeys.has('error'), '扫描结果包含已知的前景键（口径自检）');

  // 三层负责人：
  //   band     —— 带的正文契约（|Lc| ≥ LENS_BODY_LC），只覆盖 text；
  //   harden   —— 加固层，覆盖 GLASS_HARDEN_KEYS；
  //   exempt   —— 结构性豁免。每一条都必须给出「为什么这个键不需要对合成面达标」的
  //               可验证理由，而不是「暂时没想好」。
  const EXEMPT = {
    // accentInk 是「强调底上的字」：它永远压在 --accent 实心背景上（styles.css:733-735
    // 是唯一用法，同一条规则里 background: var(--accent)），从不压在半透面板上。
    // 它的可读性由 deriveTokens 对着 accent 校（theme.js:427 选黑白墨 + guardTokens
    // 的 ensureContrast），下面用断言证明这条保证真的存在。
    accentInk: 'accent 实心底上的墨，由 deriveTokens/guardTokens 对着 accent 保证',
    // selBar 唯一的 color: 用法是 .sel-opt .ic（自绘下拉的勾标），而那个勾标
    // visibility: hidden，只在 .is-on 时可见；.is-on 的那一行同时把文字换成 --text，
    // 且勾标是形状不是文字（丢了不丢信息 —— 选中态另有背景色表达）。
    selBar: '仅用于自绘下拉的勾标图形（默认 hidden），不承载文字信息',
  };

  for (const k of [...fgKeys].sort()) {
    const owner = k === 'text' ? 'band'
      : T.GLASS_HARDEN_KEYS.includes(k) ? 'harden'
        : EXEMPT[k] ? 'exempt' : null;
    ok(owner !== null,
      `前景令牌 ${k} 有负责人（${owner === 'exempt' ? `豁免：${EXEMPT[k]}` : owner}）`);
  }

  // 反向也要成立：加固清单里不许有「其实没当前景用」的键 —— 那种键推了也是白推，
  // 而 accent 就是这么被推坏过的（品牌琥珀 #d98a3d 洗成 #efc8a6）。
  for (const k of T.GLASS_HARDEN_KEYS) {
    ok(fgKeys.has(k), `加固清单里的 ${k} 确实在 CSS 里作前景用（不给不存在的场景做补偿）`);
  }

  // 同一张「谁作前景用」的清单还要覆盖**另一条路**：桌面。上面三层负责人管的都是
  // 「面板 vs 应用内底图」，而窗口是 transparent:true —— 没设底图时顶在文字后面的
  // 是桌面，那条路的唯一守卫是 uiPaintFloor（判据集合 UI_PAINT_KEYS）。
  // 2026-09-15 用户截图就漏在这里：壁纸与另一个终端窗口的正文透在顶栏元信息后面，
  // 而当时三层负责人全都「有负责人」、全绿。所以这条断言问的是：
  // 每个作前景用的非豁免键，在桌面这条路上也有人管吗。
  for (const k of [...fgKeys].sort()) {
    if (EXEMPT[k]) continue;
    ok(T.UI_PAINT_KEYS.includes(k),
      `前景令牌 ${k} 在「面板 vs 桌面」这条路上也有负责人（UI_PAINT_KEYS）`);
  }
  for (const k of T.UI_PAINT_KEYS) {
    ok(fgKeys.has(k), `UI_PAINT_KEYS 里的 ${k} 确实在 CSS 里作前景用`);
  }
  // accent 的反例留档：它必须**不**在前景集合里。哪天有人写了 color: var(--accent)，
  // 这条会失败并提醒他：要么改用 --text 系，要么把 accent 纳入加固（并接受洗色代价）。
  ok(!fgKeys.has('accent'),
    'accent 不作前景用（全仓库只作背景：按钮底 / 开关 / 选区 / accent-color）');

  // 两条豁免理由的可验证部分 —— 豁免不能只是一句话。
  for (const [id, skin] of Object.entries(T.SKINS)) {
    ok(T.contrast(T.hexToRgb(skin.tokens.accentInk), T.hexToRgb(skin.tokens.accent)) >= 4.5,
      `${id}：accentInk 对 accent 达标（豁免理由成立，它不需要对合成面达标）`);
  }
  ok(/\.sel-opt\s+\.ic\s*\{[^}]*visibility:\s*hidden/.test(cssText),
    'selBar 的勾标默认 hidden（豁免理由成立）');
  ok(/\.sel-opt\.is-on\s*\{[^}]*color:\s*var\(--text\)/.test(cssText),
    'selBar 勾标可见时同行文字用 --text（信息不依赖 selBar 的对比度）');
}

process.exit(report('theme.test'));
