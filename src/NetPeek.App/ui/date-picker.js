// 主题化日期选择器：包住 <input type="date">，用自绘浮层替掉 Chromium 的原生日历。
//
// 为什么必须自绘：那个日历弹层是一个独立的 PagePopup（自己的文档、自己的 UA 样式表），
// 不在页面 DOM 里，页面 CSS 完全够不着。唯一的开关是 color-scheme —— 而它只能翻深浅，
// 面板色与强调色仍是浏览器内置的灰石板 + 两个亮蓝文字链接。于是它在深色暖棕皮肤下
// 永远是一块贴错地方的控件：底是灰的、字是蓝的，跟周围全不相干。
//
// 渐进增强的契约与 select-menu.js 一致：原生 input 留在 DOM 里继续当唯一数据源
// （history-ui 照旧读 .value / min / max / required，校验逻辑一行不用改），
// 本模块只做四件事：
//   1. 藏掉原生指示器 —— 否则两个入口并存，点原来那个又会弹出没法改色的原生层；
//   2. 把日历画成浮层；
//   3. 把选择写回 input（冒泡 input + change 两个原生事件）；
//   4. 把「周一起」的格子对齐 history-ui 的自然周口径（周一 = 第 0 列）。
// 原生 input 的 yyyy/mm/dd 文本段仍可直接用键盘改，键入这条路没有被夺走。
//
// 键盘等价（U3 纪律）：按钮 Enter/Space 开合、↓ 开；网格内 ←→↑↓ 移动一天/一周、
// Home/End 到本周末、PageUp/PageDown 翻月、Enter/Space 选择；Esc 关回按钮；
// Tab 移出浮层自然收起。min/max 之外的格子真的 disabled，不是靠提交后报错。
(function () {
  'use strict';

  const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
  // 固定 6 行 42 格。按实际周数画的话换月时高度会跳，鼠标下的「下一格」跟着挪位。
  const CELLS = 42;

  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // 裸的 'YYYY-MM-DD' 会被 Date 当成 UTC 解析，UTC+8 下拿到的本地日期会退回前一天。
  // history-ui.js 里有同一条注释 —— 日期串走进 Date 的地方都得这么办。
  const dateOf = (iso) => new Date(`${iso}T00:00:00`);

  function icon(name) {
    return window.NetPeekCommon ? window.NetPeekCommon.icon(name) : '';
  }

  /** 周一为第 0 列。getDay() 里周日是 0，不减这一下周日会被排到下一周。 */
  function colOf(d) {
    return (d.getDay() + 6) % 7;
  }

  function enhance(input) {
    if (input._dpBound) return;
    input._dpBound = true;

    const wrap = document.createElement('span');
    wrap.className = 'dp';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add('dp-native'); // 只藏指示器，input 本身照常工作

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dp-btn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', input.getAttribute('aria-label') ? `${input.getAttribute('aria-label')}·打开日历` : '打开日历');
    btn.innerHTML = icon('calendar');

    const pop = document.createElement('span');
    pop.className = 'dp-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '选择日期');
    pop.hidden = true;
    // 整棵都是 span/i/button —— 它们都是短语内容，才能合法地待在 span 里；
    // 换成 div 会让 HTML 解析器把这段从 span 里踢出去。
    pop.innerHTML = `<span class="dp-head">`
      + `<button type="button" class="dp-nav" data-step="-1" aria-label="上个月">${icon('chevron-left')}</button>`
      + `<span class="dp-title"></span>`
      + `<button type="button" class="dp-nav" data-step="1" aria-label="下个月">${icon('chevron-right')}</button>`
      + `</span>`
      + `<span class="dp-dow">${WEEK_LABELS.map((w) => `<i>${w}</i>`).join('')}</span>`
      + `<span class="dp-grid"></span>`
      + `<span class="dp-foot">`
      + `<button type="button" class="dp-link" data-act="clear">清除</button>`
      + `<button type="button" class="dp-link" data-act="today">今天</button>`
      + `</span>`;

    wrap.appendChild(btn);
    wrap.appendChild(pop);

    const title = pop.querySelector('.dp-title');
    const grid = pop.querySelector('.dp-grid');

    let viewY = 0;
    let viewM = 0; // 当前显示的月份

    // min/max 是原生 input 上的属性，也是 history-ui 的「最早落库日 / 今天」边界。
    // 这里直接读它，判定口径就只有一份 —— 不在本模块再写一遍。
    function limits() {
      return {
        min: input.min ? dateOf(input.min) : null,
        max: input.max ? dateOf(input.max) : null,
      };
    }

    /** 重画网格。focusIso 给定时把焦点放到那一天（翻月/开浮层后键盘要能接着走）。 */
    function render(focusIso) {
      title.textContent = `${viewY} 年 ${viewM + 1} 月`;
      const lead = colOf(new Date(viewY, viewM, 1));
      const start = new Date(viewY, viewM, 1 - lead);
      const value = input.value || '';
      const { min, max } = limits();
      const today = isoOf(new Date());
      const frag = document.createDocumentFragment();
      let fallback = null;
      for (let i = 0; i < CELLS; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const iso = isoOf(d);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'dp-day';
        cell.dataset.day = iso;
        cell.textContent = String(d.getDate());
        if (d.getMonth() !== viewM) cell.classList.add('is-out');
        if ((min && d < min) || (max && d > max)) {
          // 真 disabled：min/max 之外的日期在提交侧是错误，在这里就该点不到。
          cell.disabled = true;
          cell.classList.add('is-off');
        } else if (!fallback) {
          fallback = iso;
        }
        if (iso === value) {
          cell.classList.add('is-on');
          cell.setAttribute('aria-current', 'date');
        }
        if (iso === today) cell.classList.add('is-today');
        cell.setAttribute('aria-label', `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`);
        frag.appendChild(cell);
      }
      grid.replaceChildren(frag);
      if (focusIso) {
        const want = grid.querySelector(`.dp-day[data-day="${focusIso}"]`);
        // 目标格被 min/max 挡住（或不在本屏）时退到第一个可用格，别把焦点留在
        // 已经被 replaceChildren 拿掉的节点上 —— 那会让焦点掉到 body，键盘链断掉。
        const el = want && !want.disabled ? want : (value && grid.querySelector(`.dp-day[data-day="${value}"]:not([disabled])`));
        const pickEl = el || (fallback && grid.querySelector(`.dp-day[data-day="${fallback}"]`));
        if (pickEl) pickEl.focus();
      }
    }

    function open() {
      const base = input.value ? dateOf(input.value) : new Date();
      viewY = base.getFullYear();
      viewM = base.getMonth();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      render(input.value || isoOf(new Date()));
    }

    function close(refocus) {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }

    function emit() {
      // 两个原生事件都冒泡：history-ui 同步粒度/边界听 input，别的监听者听 change。
      // 少发一个的后果是「选了日期但校验态没跟上」，而界面上看不出是事件缺了。
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function commit(iso) {
      if (input.value !== iso) {
        input.value = iso;
        emit();
      }
      close(true);
    }

    function goMonth(delta) {
      const d = new Date(viewY, viewM + delta, 1);
      viewY = d.getFullYear();
      viewM = d.getMonth();
      render(input.value || isoOf(new Date()));
    }

    btn.addEventListener('click', () => (pop.hidden ? open() : close(true)));
    btn.addEventListener('keydown', (e) => {
      // Enter/Space 由 button 自己变成 click，这里只补「↓ 展开」这一条。
      if (e.key === 'ArrowDown' && pop.hidden) {
        e.preventDefault();
        open();
      }
    });

    pop.addEventListener('click', (e) => {
      const nav = e.target.closest('.dp-nav');
      if (nav) {
        goMonth(Number(nav.dataset.step));
        return;
      }
      const act = e.target.closest('.dp-link');
      if (act) {
        if (act.dataset.act === 'today') {
          const t = new Date();
          viewY = t.getFullYear();
          viewM = t.getMonth();
          commit(isoOf(t));
        } else {
          // 清除后字段是空的，required 会拦在提交那一步（history-ui 有自己的文案），
          // 这里只把网格的选中态跟上，不顺手替用户补一个日期。
          input.value = '';
          emit();
          render();
        }
        return;
      }
      const day = e.target.closest('.dp-day');
      if (day && !day.disabled) commit(day.dataset.day);
    });

    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // 只收日历这一层。不拦的话事件会冒到 document 上 —— history-ui 在那边
        // 用 Esc 收整个自定义区间浮层，按一下 Esc 会把日历和它所在的面板一起关掉。
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      }
      const cur = document.activeElement;
      if (!cur || !cur.classList || !cur.classList.contains('dp-day')) return;
      const d = dateOf(cur.dataset.day);
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        goMonth(e.key === 'PageUp' ? -1 : 1);
        return;
      }
      let next = null;
      if (e.key === 'ArrowLeft') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
      else if (e.key === 'ArrowRight') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      else if (e.key === 'ArrowUp') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 7);
      else if (e.key === 'ArrowDown') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
      else if (e.key === 'Home') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() - colOf(d));
      else if (e.key === 'End') next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (6 - colOf(d)));
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        commit(cur.dataset.day);
        return;
      } else {
        return;
      }
      e.preventDefault();
      if (next.getFullYear() !== viewY || next.getMonth() !== viewM) {
        // 走出当前月：先把月份翻过去，render 会把焦点补在新格子上
        viewY = next.getFullYear();
        viewM = next.getMonth();
        render(isoOf(next));
        return;
      }
      const el = grid.querySelector(`.dp-day[data-day="${isoOf(next)}"]`);
      if (el && !el.disabled) el.focus();
    });

    document.addEventListener('click', (e) => {
      if (!pop.hidden && !wrap.contains(e.target)) close(false);
    });
    pop.addEventListener('focusout', () => {
      // 焦点移出浮层且没回到 wrap 内（Tab 前进）时收起；延一拍让 click 先落地
      setTimeout(() => {
        if (!pop.hidden && !wrap.contains(document.activeElement)) close(false);
      }, 0);
    });
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('input[type="date"][data-picker]').forEach(enhance);
  }

  window.NetPeekDatePicker = { enhanceAll };
  // 脚本在 body 末尾加载，目标元素此时都已解析
  enhanceAll();
})();
