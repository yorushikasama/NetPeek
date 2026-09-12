// NetPeek 前端公共工具（U4 收敛）。
// index.html / mini.html 都先加载这一份，之后 main.js、history-ui.js、mini.js、
// theme-ui.js 统一从这里取 —— 转义规则这类「各写一份迟早漂移」的东西只留一处。

window.NetPeekCommon = {
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
    };
    return `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor"`
      + ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
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
