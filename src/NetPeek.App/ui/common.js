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
