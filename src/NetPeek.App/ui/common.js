// NetPeek 前端公共工具（U4 收敛）。
// index.html / mini.html 都先加载这一份，之后 main.js、history-ui.js、mini.js、
// theme-ui.js 统一从这里取 —— 转义规则这类「各写一份迟早漂移」的东西只留一处。

window.NetPeekCommon = {
  // ---------- DOM 契约 ----------
  // HTML 里的 id 和各脚本里的 getElementById 是一份跨文件的隐式契约，共 120 处查找，
  // 没有任何一层校验它：查不到就是 null，然后在第一次 .textContent = 时才炸，
  // 而且炸的位置离真正的原因（HTML 少了个节点）很远。这里把每次查空都记下来，
  // 由 boot() 末尾一次性报出来 —— 一条日志说清「谁少了哪些节点」。
  _missingIds: [],

  /** getElementById + 查空登记。所有脚本的 $() 都走这一份。 */
  byId(id, owner) {
    const el = document.getElementById(id);
    if (!el) window.NetPeekCommon._missingIds.push(owner ? `${owner}:${id}` : id);
    return el;
  },

  /** 报告并清空累积的缺失 id。返回缺失列表，便于调用方决定是否降级。 */
  reportMissingIds() {
    const miss = window.NetPeekCommon._missingIds.slice();
    if (miss.length) {
      console.warn(`[NetPeek] HTML 缺少 ${miss.length} 个脚本要用的节点：${miss.join(', ')}`);
    }
    window.NetPeekCommon._missingIds.length = 0;
    return miss;
  },

  // HTML 文本转义。凡是用 innerHTML 拼接、内容含进程名/路径/主题名等外部字符串的地方都要过它。
  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  /**
   * 统一图标组件（Lucide 线性族：24 viewBox / stroke currentColor / round 线帽，
   * 与导航、窗口钮、搜索框里的内联 SVG 同一族）。界面上不再直接写 emoji 或
   * 文本符号（🔒 ✓ ✎ 🗗 ▼ ▲ ↓ ↑）—— 全部从这张表出，粗细、线帽、尺寸跟着
   * CSS 走，换主题自动继承 currentColor。
   * 静态 HTML 里的图标（顶栏、导航）是构建期内联的同源 path，改这里记得同步。
   */
  icon(name, cls) {
    const P = {
      'arrow-down': '<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />',
      'arrow-up': '<path d="M12 19V5" /><path d="m5 12 7-7 7 7" />',
      'caret-down': '<path d="m6 9 6 6 6-6" />',
      'caret-up': '<path d="m18 15-6-6-6 6" />',
      'check': '<path d="M20 6 9 17l-5-5" />',
      'lock': '<rect x="4.5" y="10.5" width="15" height="10" rx="2" /><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />',
      'pencil': '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />',
      'trash': '<path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" />',
      // 告警：右键菜单的「复制失败」回执用它。界面上原本没有负面状态的图形符号，
      // 缺了它失败回执只能是一行红字（§35）。
      'alert': '<circle cx="12" cy="12" r="9" /><path d="M12 7.5V13" /><path d="M12 16.5v.01" />',
      // 日历：日期框自绘浮层的入口按钮（date-picker.js）。原生那个指示器是
      // 浏览器画的、颜色跟着 color-scheme 走，跟我们自己的皮肤对不上，所以藏掉换它。
      'calendar': '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M8 3v4M16 3v4M3.5 10h17" />',
      'chevron-left': '<path d="m15 6-6 6 6 6" />',
      'chevron-right': '<path d="m9 6 6 6-6 6" />',
    };
    return `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
      + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
  },

  // 未归因流量的显示名。main.js 与 mini.js 都要用它做首字母占位的特例判断，
  // 各写一份字面量迟早漂移成两个不同的字符串。
  UNATTR: '(系统/未归因)',

  /**
   * 图标取不到时的首字母占位。
   * 跳过开头的非字母数字：未归因流量那类以半角括号开头的名字直接切首字符，
   * 会在徽标里画一个孤零零的括号 —— 读起来是渲染出错，不是占位。
   */
  initialOf(name, len) {
    const s = String(name || '').replace(/^[^\p{L}\p{N}]+/u, '');
    if (!s) return '·';
    return s.slice(0, len || 1).toUpperCase();
  },

  // 单位非 B 时把数值压到 999 上限。起因：999_999 字节 / 1000 = 999.999，
  // 四舍五入成 "1000.0 KB" —— 数字跨出了自己的单位，读起来像计算错误。
  clampUnit(n) {
    return n > 999 ? 999 : n;
  },

  /**
   * 入口取数：非有限值一律当 0。
   * 快照字段缺失时（采集端换协议、旧库回读、未归因行没有速率）传进来的是
   * undefined，`undefined / 1e3` 是 NaN，最后渲染成 "NaN B" 摆在表格里 ——
   * 那比显示 0 更糟：它看着像程序崩了，而不是「这一行没有流量」。
   */
  toFinite(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  },

  /**
   * 速率格式化。unit 为 'auto' | 'kb' | 'mb' | 'gb'（设置屏的「速率单位」）。
   * 固定档直接换算，auto 档按量级选档。
   * GB 档不可省：万兆链路（1.25 GB/s）在没有 GB 档时会被压在 "999.00 MB/s"，
   * 而且与 fmtBytes 的档位不一致。
   */
  fmtRate(v, unit) {
    const K = window.NetPeekCommon;
    const c = K.clampUnit;
    const bps = K.toFinite(v);
    if (unit === 'kb') return `${c(bps / 1e3).toFixed(1)} KB/s`;
    if (unit === 'mb') return `${c(bps / 1e6).toFixed(1)} MB/s`;
    if (unit === 'gb') return `${c(bps / 1e9).toFixed(2)} GB/s`;
    if (bps >= 1e9) return `${c(bps / 1e9).toFixed(2)} GB/s`;
    if (bps >= 1e6) return `${c(bps / 1e6).toFixed(2)} MB/s`;
    if (bps >= 1e3) return `${c(bps / 1e3).toFixed(1)} KB/s`;
    return `${Math.round(bps)} B/s`;
  },

  /** 字节总量格式化。档位与 fmtRate 对齐，只是不带 /s。 */
  fmtBytes(v, unit) {
    const K = window.NetPeekCommon;
    const c = K.clampUnit;
    const bytes = K.toFinite(v);
    if (unit === 'kb') return `${c(bytes / 1e3).toFixed(1)} KB`;
    if (unit === 'mb') return `${c(bytes / 1e6).toFixed(1)} MB`;
    if (unit === 'gb') return `${c(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e9) return `${c(bytes / 1e9).toFixed(2)} GB`;
    if (bytes >= 1e6) return `${c(bytes / 1e6).toFixed(1)} MB`;
    if (bytes >= 1e3) return `${c(bytes / 1e3).toFixed(1)} KB`;
    return `${Math.round(bytes)} B`;
  },

  /** 把 "1.23 MB/s" 拆成数值与单位两段：单位要用小一号字排，不能混在一个字号里。 */
  splitUnit(text) {
    const i = String(text).lastIndexOf(' ');
    return i < 0
      ? { value: String(text), unit: '' }
      : { value: String(text).slice(0, i), unit: String(text).slice(i + 1) };
  },

  /** 秒 → HH:MM:SS。负数与小数一律先夹到非负整数，避免出现 "-1:59:59"。 */
  fmtDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  },

  /**
   * 尾部防抖，返回 { schedule, flush, pending }。
   * 用于「连续动作只需最后一次落盘」的场景：设置里拖数字框、连点下拉，
   * 每一下都写文件 + 起一次 reg 子进程是纯浪费。
   * flush 供页面隐藏/失焦时调用，避免最后一次改动悬在定时器里丢掉。
   * 注意：语义是「延后合并」，不是「节流跳过」——中间值不会丢，只是晚一点写。
   */
  debounce(fn, ms) {
    let timer = null;
    let waiting = false;
    const run = async () => {
      clearTimeout(timer);
      timer = null;
      if (!waiting) return;
      waiting = false;
      await fn();
    };
    return {
      schedule() {
        waiting = true;
        clearTimeout(timer);
        timer = setTimeout(() => { void run(); }, ms);
      },
      flush: run,
      get pending() { return waiting; },
    };
  },
};
