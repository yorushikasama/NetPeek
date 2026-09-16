// 自定义下拉菜单：把带 data-menu 的原生 <select> 升级成主题化的「按钮 + 浮层」。
// 原生 select 的箭头和弹出层是 OS 画的，是全应用唯一没被设计语言覆盖的库存控件。
//
// 为什么不直接用 Choices.js：试过（2026-09-12），v11 的开合状态横跨 is-active /
// is-open / aria-expanded 三处、hideDropdown 走 rAF 延迟、capture 阶段的
// mousedown 处理器会吞掉触发器点击，在我们的环境里「点不开」排查了六轮探针
// 没有收敛；而这份 150 行的实现当场可用，且焦点/键盘/外点关闭的行为全部可见
// 可断言。回落方案就是它 —— 除非某天需要搜索、多选、远程数据，再评估。
//
// 渐进增强的契约：select 留在 DOM 里继续当唯一数据源 —— settings-ui 照旧读
// .value、听 change，一行不用改。本模块只做三件事：把 select 藏起来、把选项
// 画成浮层、把用户的选择写回 select（冒泡原生 change 事件）。
//
// 键盘等价（U3 纪律）：按钮 Enter/Space/↓ 开；浮层内 ↑↓ 移动、Enter/Space
// 选择、Esc 关回按钮、Tab 关闭自然前进；Home/End 跳首尾。
(function () {
  'use strict';

  function icon(name) {
    return window.NetPeekCommon ? window.NetPeekCommon.icon(name) : '';
  }

  function currentLabel(select) {
    const opt = select.selectedOptions && select.selectedOptions[0];
    return opt ? opt.textContent : '';
  }

  function enhance(select) {
    if (select._menuBound) return;
    select._menuBound = true;

    const wrap = document.createElement('span');
    wrap.className = 'sel';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('sel-native'); // 藏掉 OS 控件，数据源角色不变

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sel-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const label = document.createElement('span');
    label.className = 'sel-label';
    btn.appendChild(label);
    btn.insertAdjacentHTML('beforeend', icon('caret-down'));

    const pop = document.createElement('span');
    pop.className = 'sel-pop';
    pop.setAttribute('role', 'listbox');
    pop.hidden = true;

    const opts = Array.from(select.options).map((o) => {
      const el = document.createElement('span');
      el.className = 'sel-opt';
      el.setAttribute('role', 'option');
      el.dataset.value = o.value;
      el.tabIndex = -1;
      el.innerHTML = `${window.NetPeekCommon ? window.NetPeekCommon.icon('check') : ''}<span></span>`;
      el.lastElementChild.textContent = o.textContent;
      pop.appendChild(el);
      return el;
    });

    wrap.appendChild(btn);
    wrap.appendChild(pop);

    function sync() {
      label.textContent = currentLabel(select);
      const val = select.value;
      opts.forEach((el) => {
        const on = el.dataset.value === val;
        el.classList.toggle('is-on', on);
        el.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }

    function open() {
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      const cur = opts.find((el) => el.dataset.value === select.value) || opts[0];
      if (cur) cur.focus();
    }

    function close(refocus) {
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }

    function pick(el) {
      if (!el) return;
      if (select.value !== el.dataset.value) {
        select.value = el.dataset.value;
        // 冒泡原生 change：settings-ui 的监听与节流保存走的是同一条路
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sync();
      close(true);
    }

    btn.addEventListener('click', () => (pop.hidden ? open() : close(true)));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        open();
      }
    });

    pop.addEventListener('keydown', (e) => {
      const cur = document.activeElement;
      const idx = opts.indexOf(cur);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (opts[Math.min(opts.length - 1, idx + 1)] || cur).focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        (opts[Math.max(0, idx - 1)] || cur).focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        opts[0].focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        opts[opts.length - 1].focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        pick(cur);
      } else if (e.key === 'Escape') {
        // 只收下拉这一层。不拦的话事件会冒到 document 上 —— history-ui 在那边
        // 用 Esc 收整个自定义区间浮层，按一下 Esc 会把下拉和它所在的面板一起关掉。
        // date-picker.js 的日历早就拦住了，这里是漏的那一处（同一场合里的两个
        // 浮层必须给同一种回执，否则「按 Esc」在同一个表单里有两个含义）。
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
    });

    opts.forEach((el) => el.addEventListener('click', () => pick(el)));
    document.addEventListener('click', (e) => {
      if (!pop.hidden && !wrap.contains(e.target)) close(false);
    });
    pop.addEventListener('focusout', () => {
      // 焦点移出浮层且没回到 wrap 内（Tab 前进）时收起；延一拍让 click 先落地
      setTimeout(() => {
        if (!pop.hidden && !wrap.contains(document.activeElement)) close(false);
      }, 0);
    });

    // settings-ui 会在 init 里程序化写 select.value（不触发 change 事件），
    // 在实例上包一层 setter，让按钮文字永远跟数据源一致。
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value');
    if (desc && desc.set) {
      Object.defineProperty(select, 'value', {
        get() { return desc.get.call(select); },
        set(v) { desc.set.call(select, v); sync(); },
        configurable: true,
      });
    }

    sync();
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('select[data-menu]').forEach(enhance);
  }

  window.NetPeekSelect = { enhanceAll };
  // 脚本在 body 末尾加载，目标元素此时都已解析
  enhanceAll();
})();
