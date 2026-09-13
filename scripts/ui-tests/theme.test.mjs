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

section('backdropFloor：面板不透明度下限由实测底图亮度推出');
{
  // 界面上写着「0.82 下限保证 4.5:1」，实测并不成立：面板叠在任意照片上时，
  // 有效底色是合成结果，固定下限保证不了任何东西。压暗层在面板之下、值已知，
  // 所以由它承担这个保证。
  const white = T.backdropFloor(T.SKINS.plain.tokens, 1.0, 0.2);
  const black = T.backdropFloor(T.SKINS.plain.tokens, 0.0, 0.2);
  ok(white >= 0.82 && white <= 1, '白底：下限落在合法区间');
  ok(white > black, '越亮的底图要求越高的面板不透明度');

  // 拿返回的下限合成一次，验证它真的兑现了 4.5:1
  const floor = T.backdropFloor(T.SKINS.plain.tokens, 1.0, 0.2);
  const eff = T.effectivePanel(T.SKINS.plain.tokens, 1.0, 0.2, floor);
  ok(T.contrast(T.hexToRgb(T.SKINS.plain.tokens.text2), T.hexToRgb(eff)) >= 4.5,
    '按下限合成后，次要文字也达标（原来这里是 3.30）');
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

section('backdropFloor：下限只由 text2 驱动');
{
  // 旧版 floor 同时保 text2@4.5 与 text3@2.9 —— 让设计意图就是「弱」的字阶握着
  // 最强的一票否决，实测任意真实照片（最坏块亮度 ≥0.2）都会把下限顶到 0.94+，
  // 面板不透明度滑杆的可用区间只剩 0.04，三个材质滑杆全部失感（2026-09-13）。
  // 现在 floor 只保 text2@4.5；text3 的可读性由派生托底与自动压暗间接保障。
  // 方向：floor 抬高只发生在「字与有效底反向」的组合 —— 亮字皮肤遇亮图、
  // 暗字皮肤遇暗图；反方向的组合（亮图 + 暗字）天然受益，不再被误抬。
  const plain = T.SKINS.plain.tokens;
  const light = T.SKINS.light.tokens;
  ok(T.backdropFloor(plain, 0.92, 0.2) > 0.82, '亮字皮肤 + 亮图：下限抬过 0.82');
  ok(T.backdropFloor(light, 0.066, 0.3) > 0.82, '暗字皮肤 + 暗图：下限抬过 0.82');
  eq(T.backdropFloor(light, 0.92, 0.2), 0.82, '亮图 + 暗字：暗字在亮底上更清楚，下限不动');

  // 中等亮度（0.2 = 「挺暗的照片」）不再把下限顶到 0.94+：本次重构的直接验收
  const mid = T.backdropFloor(plain, 0.2, 0.37);
  ok(mid < 0.94, `中等亮度图的下限回落到可用区间（实测 ${mid}）`);

  // 暗图不能被抬高 —— 半透明是该模式的存在意义。
  const mist = { ...T.SKINS.plain.tokens, panel: '#151619', text2: '#a9a19c' };
  eq(T.backdropFloor(mist, 0.066, 0.3), 0.82, '晨雾级暗图（默认压暗）：下限仍是 0.82');
  eq(T.backdropFloor(mist, 0.066, 0.2), 0.82, '晨雾级暗图（最低压暗）：下限仍是 0.82');
}

section('backdropGuard：亮图先补自动压暗，顶格才硬钳');
{
  const plain = T.SKINS.plain.tokens;
  // 亮图 + 低不透明度：自动压暗补偿让用户选的 0.70 原地达标
  const g = T.backdropGuard(plain, 0.95, 0.3, 0.7);
  ok(g.autoDim > 0 && g.autoDim <= 0.6, `亮图触发自动压暗（${g.autoDim}）`);
  const eff = T.effectivePanel(plain, 0.95, Math.min(1, 0.3 + g.autoDim), 0.7);
  ok(T.contrast(T.hexToRgb(plain.text2), T.hexToRgb(eff)) >= 4.5,
    '补完自动压暗后，0.70 不透明度下 text2 仍 ≥ 4.5');
  // 暗图：零补偿
  eq(T.backdropGuard(plain, 0.066, 0.3, 0.7).autoDim, 0, '暗图不需要自动压暗');
  // 自动压暗顶格仍不达标 → 硬钳 floor 兜底
  const g2 = T.backdropGuard(plain, 1.0, 0.2, 0.7);
  if (g2.autoDim >= 0.6) {
    ok(g2.floor > 0.7, `顶格仍不达标时给出硬钳 floor（${g2.floor}）`);
  } else {
    ok(g2.floor <= 0.7 + 1e-9, '未顶格时不需要硬钳');
  }
  // 守卫对用户滑杆单调：不透明度越高，需要的自动压暗不增
  const hi = T.backdropGuard(plain, 0.95, 0.3, 0.95);
  ok(hi.autoDim <= g.autoDim, '不透明度调高，自动压暗随之减少');
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
  // 贴膜浓度地板（wrapFloor：主文字 4.5、次要 3.2）：亮图抬地板,暗图落在可用区间
  const plain = T.SKINS.plain.tokens;
  ok(T.wrapFloor(plain, 0.92, 0.4) > 0.6, '亮图：贴膜浓度地板显著抬高');
  const darkFloor = T.wrapFloor(plain, 0.066, 0.4);
  ok(darkFloor <= 0.55, `暗图：浓度地板落在可用区间（实测 ${darkFloor}）`);
  const f = T.wrapFloor(plain, 0.92, 0.4);
  const eff = T.effectivePanel(plain, 0.92, 0, f);
  ok(T.contrast(T.hexToRgb(plain.text), T.hexToRgb(eff)) >= 4.5, '主文字按地板调和后 ≥ 4.5');
  ok(T.contrast(T.hexToRgb(plain.text2), T.hexToRgb(eff)) >= 3.2, '次要文字按地板调和后 ≥ 3.2');
  // 亮度进守卫:提亮亮图,等效亮度上升,浓度地板随之抬高(线性近似,钳到 1)
  const fBright = T.wrapFloor(plain, Math.min(1, 0.92 * 1.3), 0.4);
  ok(fBright >= f, '提亮后浓度地板不降');
}

process.exit(report('theme.test'));
