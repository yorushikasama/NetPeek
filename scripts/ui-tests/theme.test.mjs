// theme.js 单测：皮肤解析、令牌派生、对比度守卫。
//
// 值这个文件的意义：皮肤是「一份 JSON 表覆写 CSS 变量」，中间没有任何一层会
// 告警。派生错一个键，表现是顶栏在浅色皮肤下还是黑的；解析漏一个来源，表现是
// 用户改的颜色重启就没了 —— 两种都不会报错、只会让人以为「这软件皮肤是坏的」。
// 主界面和小窗是两个 webview，唯一的一致性保证就是双方都走 resolveSkin，
// 所以这里重点锁三件事：resolveSkin 认得全部来源、派生键跟着核心键走、
// 上屏的颜色一定过对比度守卫。

import { loadScripts, eq, ok, section, report } from './_harness.mjs';

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

section('glass lens：带端由可读性契约反解，带宽就是底图的形');
{
  // 这一节替换掉「窄带」时代的契约。旧版把带写死成浅色 [0.85, 1] 通道 —— 一条
  // 0.15 宽、贴着纯白的窄带，底图自己的形在里面只剩几个灰阶（实测面板上只剩
  // p2p 6/255），用户因此连着两次报「不透明度拉到最低也透不出底图」。
  // 现在带端由 theme.lensBand 反解：在设计不透明度（取滑杆下限，于是契约在整个
  // 滑杆行程上都成立）下，最不利那档面板上 GLASS_TIERS 每一档都要达标。
  // 带宽 = 底图的形能用的空间，所以这一节主要钉「带够宽」+「带端刚好卡在那条线上」。
  const light = T.expandTokens({
    bg: '#f5e4df', panel: '#f8eeeb', text: '#2a2c30', accent: '#2a2c30',
    down: '#8d5621', up: '#39668f', ok: '#1f6f44', warn: '#8a6608', error: '#b3352b',
  }, { tightRamp: true });
  const dark = T.expandTokens({
    bg: '#161418', panel: '#1c191d', text: '#f2ecea', accent: '#f2ecea',
    down: '#f0963f', up: '#62a9e8', ok: '#4cc38a', warn: '#e5b567', error: '#e57373',
  }, { tightRamp: true });

  const hexOf = (c) => '#' + ['r', 'g', 'b'].map((k) => Math.round(
    Math.min(255, Math.max(0, c[k])),
  ).toString(16).padStart(2, '0')).join('');
  // 最不利那档面板：浅色皮肤怕「更暗」（暗字没地方落）取更暗的，深色取更亮的
  const worstSurf = (tokens) => {
    const p1 = T.hexToRgb(tokens.panel);
    const p2 = T.hexToRgb(tokens.panel2);
    const lt = T.isLightSkin(tokens);
    return lt
      ? (T.luminance(p1) <= T.luminance(p2) ? p1 : p2)
      : (T.luminance(p1) >= T.luminance(p2) ? p1 : p2);
  };
  // 带上的灰 × 最不利面板，按设计不透明度调和 → 各档字阶的 Lc
  const lcsAt = (tokens, t) => {
    const p = worstSurf(tokens);
    const op = T.LENS_DESIGN_OP;
    const g = t * 255;
    const comp = { r: g + (p.r - g) * op, g: g + (p.g - g) * op, b: g + (p.b - g) * op };
    const hex = hexOf(comp);
    const tiers = T.isLightSkin(tokens) ? T.GLASS_TIERS.light : T.GLASS_TIERS.dark;
    return tiers.map(([k, min]) => [k, Math.abs(T.apcaLc(tokens[k], hex)), min]);
  };
  // 自校准后的**实际**目标 = min(声明档位, 该档在「最有利端」实测对比 × GLASS_TIER_REL)。
  // 判定必须用它，不能直接用声明档位 —— 深色那枚中灰的物理上限低于声明档位，拿声明
  // 档位判会永远判不过，这正是旧实现的死结：带退化成一个点。
  // 实际目标直接取实现导出的那一份（glassTierTargets），测试不重抄一遍公式 ——
  // 两处口径一旦漂移，重抄的那份会假装通过。
  const effTiers = (tokens) => T.glassTierTargets(tokens);
  const tiersOkAt = (tokens, t) => {
    const eff = new Map(effTiers(tokens));
    return lcsAt(tokens, t).every(([k, v]) => v >= (eff.get(k) ?? 0) - 0.5);
  };
  const brief = (rows) => JSON.stringify(rows.map(([, v]) => Math.round(v)));

  eq(T.LENS_DESIGN_OP, T.MIN_PANEL_OP, '带端按滑杆下限反解（契约在整个滑杆行程上成立）');

  const [l0, l1] = T.lensBand(light);
  eq(l1, 0.99, '浅色带顶留一点白（不烧成纯色）');
  ok(tiersOkAt(light, l0), `浅色带底上各字阶达标（Lc ${brief(lcsAt(light, l0))}）`);
  ok(!tiersOkAt(light, l0 - 0.02), '浅色带底不是白送的：再往下 0.02 就有档位不达标');
  ok(l1 - l0 >= 0.30,
    `浅色带够宽（${(l1 - l0).toFixed(3)} ≥ 0.30）—— 这是「底图的形」能用的空间`);

  const [d0, d1] = T.lensBand(dark);
  eq(d0, 0.05, '深色带底留一点黑（暗部不压死、形还在）');
  ok(tiersOkAt(dark, d1), `深色带顶上各字阶达标（实测 Lc ${brief(lcsAt(dark, d1))}）`);
  ok(!tiersOkAt(dark, d1 + 0.02), '深色带顶不是白送的：再往上 0.02 就有档位不达标');
  ok(d1 - d0 >= 0.20, `深色带够宽（${(d1 - d0).toFixed(3)} ≥ 0.20）`);

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
    eq(gd.autoDim, 0, `深色派生 + 底图亮度 ${L}：不铺自动压暗（带顶已经压在契约线上）`);
  }

  // —— 用户第二次报缺陷的回归锁（深色那一半） ——
  // 实测来源：2026-09-15 用户壁纸（橙红火焰）派生出的深色皮肤，token 实测为
  //   panel #1e130f / panel2 #0e0604 / text #f0e5e2 / text2 #9b8f8b
  // 这枚中灰次要字压在近黑底上，|Lc| 的物理上限只有 ≈43（连纯黑也只给 43.3），
  // 而 GLASS_TIERS.dark 当时声明 45 —— 契约无解。旧实现无解时返回退化的
  // [0.05,0.05]，lensParams 因斜率 0 返回 null，lensOf 变 null，backdropGuard
  // 退回「无透镜」分支把面板地板顶到 1：深色面板全不透明，底图彻底消失
  // （像素量尺实测 p2p 0/255 —— 就是用户那句「现在深色也一样了」）。
  // 自校准之后下面每一条都必须同时成立，缺一条就是缺陷复发。
  const userDark = {
    ...dark,
    bg: '#140906', panel: '#1e130f', panel2: '#0e0604',
    text: '#f0e5e2', text2: '#9b8f8b', text3: '#6a5e5a',
  };
  eq(T.isLightSkin(userDark), false, '实测深色皮肤：方向判为深色（亮字压暗底）');
  const [u0, u1] = T.lensBand(userDark);
  ok(u1 - u0 >= 0.20,
    `实测深色皮肤：带不退化成点（${u0.toFixed(3)} → ${u1.toFixed(3)}，宽 ${(u1 - u0).toFixed(3)}）`);
  const uLens = T.lensOf(userDark);
  ok(uLens !== null, '实测深色皮肤：透镜非空（否则守卫退回「无透镜」把面板顶成全不透明）');
  ok(uLens.contrast > 0 && uLens.brightness > 0, '实测深色皮肤：透镜参数有效');
  const uEff = new Map(effTiers(userDark));
  ok(uEff.get('text2') < 45 && uEff.get('text2') > 0,
    `实测深色皮肤：次要字档被自校准松到 ${uEff.get('text2').toFixed(1)}（物理上限 ≈43，声明 45 无解）`);
  eq(uEff.get('text'), 60, '实测深色皮肤：正文档位余量充足，自校准不动它');
  const ug = T.backdropGuard(userDark, 0.06, 0.2, T.MIN_PANEL_OP);
  eq(ug.floor, T.MIN_PANEL_OP, '实测深色皮肤：地板仍是滑杆下限（面板不会变成全不透明）');
  eq(ug.autoDim, 0, '实测深色皮肤：不铺自动补偿（滑杆不被拿走）');
  // 兜底本身也不能再退化成「没有透镜」：契约自校准后走不到，但形状必须是有效透镜
  const wide = { ...userDark, text2: '#1e130f' };   // 次要字与面板同色 → 物理对比为 0
  const wLens = T.lensOf(wide);
  ok(wLens !== null && wLens.contrast > 0,
    '病态 token（次要字与面板同色）：兜底仍是有效透镜，绝不返回 null');
  ok(T.lensBand(wide)[1] - T.lensBand(wide)[0] > 0, '病态 token：带仍有正宽度');
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
  // 用实测的深色 token。透镜自校准把**次要字**档松到 ≈32（那枚中灰的物理上限只有
  // ≈43，声明 45 无解），但**正文**（近白 #f0e5e2）档必须仍 ≥60 —— 这是「放宽次要字
  // 换底图的形」这笔交易的下限，也是深色玻璃上用户真能感觉到的可读性。同时地板必须
  // 仍是滑杆下限：地板一介入，面板就全不透明，底图又没了。
  const duser = {
    ...light,
    bg: '#140906', panel: '#1e130f', panel2: '#0e0604',
    text: '#f0e5e2', text2: '#9b8f8b', text3: '#6a5e5a',
  };
  for (const L of [0, 0.0014, 0.06, 0.6, 1.0]) {
    const g = T.backdropGuard(duser, L, 0.2, T.MIN_PANEL_OP);
    eq(g.floor, T.MIN_PANEL_OP, `深色实测皮肤 + 底图亮度 ${L}：地板不介入（底图不会被面板吃掉）`);
    const eff = T.effectivePanel(duser, L, 0.2, T.MIN_PANEL_OP);
    const body = Math.abs(T.apcaLc(duser.text, eff));
    const sec = Math.abs(T.apcaLc(duser.text2, eff));
    ok(body >= 60, `深色实测皮肤 + 底图亮度 ${L} + 0.30 漆层：正文 Lc ${body.toFixed(0)} ≥ 60`);
    ok(sec >= 32, `深色实测皮肤 + 底图亮度 ${L}：次要字 Lc ${sec.toFixed(0)} ≥ 32（自校准档）`);
  }
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

process.exit(report('theme.test'));
