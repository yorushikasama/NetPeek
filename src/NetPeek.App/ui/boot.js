/* NetPeek 启动动效控制器。
 *
 * 几何与时间线都在 boot.css 里，这里只管三件与「应用生命周期」有关的事：
 *   1) 把窗口露出来 —— 配置里主窗是 visible:false，一直没有代码负责显示它。
 *   2) 让动效从可见的第一帧开始，而不是从页面加载的第一帧开始。
 *   3) 在界面真的就绪之后把启动层卸下来，并把「就绪」和「至少播完一遍」两个条件都满足。
 *
 * 为什么由前端负责显示窗口（而不是 Rust 里 setup 完就 show）：
 *   visible:false + 前端首绘后再 show 是 Tauri 的无白闪标准做法 ——
 *   Rust 那边 show 的时候 WebView 还没画出第一帧，用户会看到一个纯白或全黑的矩形。
 *   启动动效正好把这个「等首绘」的窗口期变成产品的一部分。
 *
 * 为什么这里要自己管显示时机，而不是沿用原来的路径：
 *   原先没有任何代码调用 show，主窗实际是靠 Rust 里那条 8 秒兜底线程弹出来的 ——
 *   也就是「点开应用，8 秒后窗口才出现」。启动动效如果没有配套的显示时机，
 *   只会变成「8 秒后窗口出现，并且已经播完了」。
 */

(() => {
  "use strict";

  const layer = document.getElementById("bootLayer");
  if (!layer) return;                       // 标记没渲染出来就整段跳过

  const win = (() => {
    const t = window.__TAURI__;
    return t && t.window ? t.window.getCurrentWindow() : null;
  })();

  const REDUCED =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // 与 boot.css 的时间线一一对应。改那边一定要改这里 ——
  // 这里用错只会让「至少播完一遍」的判定偏一点，不会让动效本身出错。
  //
  // 拆成两段是为了让「定格」这件事在代码里显式存在：
  //   ANIM 最后一条动画（字标擦除）的结束时刻；
  //   HOLD 之后什么都不动的那 400ms，它是这个动效唯一的落点 ——
  //        没有它，用户看到的是「一闪而过，没看清长什么样」。
  // 合成一个 TOTAL 看起来更短，但那样「为什么要等这么久」就没法回答了，
  // 下次有人想缩短时间也不知道该动哪一段。
  const ANIM = 2000;
  const HOLD = 400;
  const TOTAL = ANIM + HOLD;
  // 动效播完之后最多再等界面多久。超过就带着当前状态卸下启动层：
  // 一个定格在终帧的 logo 再好看，也好不过让用户看到「采集服务未运行」的提示。
  const AFTER_ANIM = 1600;
  // 从露脸算起的硬上限。界面的 init 链里任何一环挂住都不该把用户关在启动页里。
  const HARD_CAP = 6000;
  // 无动效路径的最短停留：只是为了让启动层不闪一下就没，不是要让人等。
  const MIN_STATIC = 320;

  let shownAt = 0;
  let appReady = false;
  let dismissed = false;
  let poll = 0;
  let hardTimer = 0;

  /* 读当前皮肤底色的实际亮度，决定用深底还是浅底的配色。
   *
   * 为什么必须真的去量，而不是「皮肤 id 是 light 就用浅底配色」：
   *   皮肤可分三类（深 / 浅 / 跟随背景图），而「跟随背景图」皮肤下 --bg 只是底衬，
   *   真正决定观感的是用户选的那张壁纸，深浅完全未知。按皮肤 id 判断会在这里失手。
   *   直接问「底色算出来多亮」对三类皮肤都成立。
   *
   * 为什么要绕一圈 canvas：getComputedStyle 在 Chrome 152 上会把颜色规范化成
   *   color(srgb 0.105 0.113 0.129) 这种新语法，皮肤表里写的却是 #1b1d21。
   *   手写解析器要同时吃 #rrggbb / rgb() / color(srgb ...) 三种，还得处理
   *   color-mix 之类未来语法；canvas 的 fillStyle 是「任何合法 CSS 颜色都能吃」的
   *   标准入口，再 getImageData 拿回 8 位整数 —— 一行就把规范化做完了。 */
  function bgLuminance() {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:absolute;left:-9999px;top:0;width:1px;height:1px;background-color:var(--bg)";
    layer.appendChild(probe);
    const raw = getComputedStyle(probe).backgroundColor;
    probe.remove();

    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "#000000";              // 先设成黑，下面用它检测解析是否失败
    g.fillStyle = raw;
    const parsed = g.fillStyle !== "#000000";
    g.fillRect(0, 0, 1, 1);
    const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;

    const lin = (v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lum = 0.2126 * lin(r) + 0.7152 * lin(gg) + 0.0722 * lin(b);
    // 解析失败时返回一个「当深底」的值：三个内置皮肤里两个是深底，
    // 而且深底那套配色在浅底上只是对比度不足、不是不可读，反向才是灾难性的。
    return parsed ? lum : 0;
  }

  /* 把整条时间线拉回起点。
   * 页面一解析出标记，CSS 动画就随样式起跑了，而那时窗口还没显示 ——
   * 不拉回起点，用户看到的会是从中段切进去的动画，切多深还取决于窗口显示耗时。
   * （用 currentTime 而不是重挂动画：重挂要读一次 layout 强制回流，会有一次可见的抖。） */
  function rewind() {
    for (const a of layer.getAnimations({ subtree: true })) {
      a.currentTime = 0;
      a.play();
    }
  }

  function reveal() {
    // 两帧：第一帧样式与新值算完，第二帧才真正上屏。
    // 必须等这一次上屏完成再 show —— 早于首绘 show 出来就是白闪，
    // 而白闪正是 visible:false 这套机制要避免的东西。
    requestAnimationFrame(() => requestAnimationFrame(async () => {
      // 配色要在第一帧之前定下来：晚一帧就是「先按深底画一遍、再切成浅底」，
      // 而那一下正好在窗口刚露脸的时候，最显眼。
      if (bgLuminance() > 0.5) layer.classList.add("is-light-bg");

      if (REDUCED) layer.classList.add("is-static");
      else rewind();

      shownAt = performance.now();

      if (win) {
        try { await win.show(); } catch { /* 浏览器里预览时没有窗口，正常 */ }
        try { await win.setFocus(); } catch { /* 同上 */ }
      }

      poll = window.setInterval(tick, 90);
      hardTimer = window.setTimeout(() => dismiss("hard-cap"), HARD_CAP);
      tick();
    }));
  }

  function elapsed() {
    return shownAt ? performance.now() - shownAt : 0;
  }

  function tick() {
    if (dismissed) return;
    const floor = REDUCED ? MIN_STATIC : TOTAL;
    if (elapsed() < floor) return;
    if (appReady) return dismiss("ready");
    // 动效播完（且停了一小会儿）界面还没就绪 —— 不再无限等，让界面自己解释状态
    const budget = REDUCED ? MIN_STATIC : TOTAL + AFTER_ANIM;
    if (elapsed() >= budget) dismiss("timeout");
  }

  function dismiss(reason) {
    if (dismissed) return;
    dismissed = true;
    if (poll) window.clearInterval(poll);
    if (hardTimer) window.clearTimeout(hardTimer);

    layer.dataset.dismissedBy = reason;

    const finish = () => layer.remove();

    if (REDUCED) {
      // 无动效：没有淡出可播，直接撤。仍走一个 rAF，保证这一帧画完再删，
      // 否则最后一次合成可能落在一个已经被摘掉节点的帧上。
      requestAnimationFrame(finish);
      return;
    }

    layer.classList.add("is-out");
    let done = false;
    const once = () => { if (!done) { done = true; finish(); } };
    // 监听整层自己的 transitionend。子元素（#np-lockup 的 220ms）也会冒泡上来，
    // 所以 e.target 判断不能省 —— 否则会在内容刚淡完、幕布还没走完时就把节点删掉，
    // 交接那一下露出未合成的底色。
    // 这里**不能**用 { once: true }：它会在第一个（可能是子元素的）事件后就把
    // 监听摘掉，幕布那次真正该收的事件反而收不到。幂等由 once() 里的 done 保证。
    layer.addEventListener("transitionend", (e) => {
      if (e.target === layer) once();
    });
    // transitionend 在「元素被遮挡 / 后台标签 / 动画被系统关掉」时可能不来，兜一个定时器。
    // 不兜这一下，启动层会永久留在 DOM 里盖着界面，表现为「窗口一片死黑」。
    // 620 = 幕布那一段的 100ms 延迟 + 360ms 时长 + 160ms 余量。
    window.setTimeout(once, 620);
  }

  /* 由 main.js 在启动链跑完之后调用。
   * 故意做成幂等的：重复调用只更新标志位，不重复触发卸载。 */
  function ready() {
    appReady = true;
    tick();
  }

  window.NetPeekBoot = {
    ready,
    reveal,
    dismiss,
    /* 调试与审阅用：切换配色预设（brand 默认 / chrome 中性反白） */
    setPreset(name) {
      layer.classList.remove("preset-chrome");
      if (name) layer.classList.add("preset-" + name);
    },
    get state() {
      return { shownAt, appReady, dismissed, reduced: REDUCED };
    },
  };

  reveal();
})();
