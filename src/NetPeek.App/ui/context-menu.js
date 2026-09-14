// 右键菜单：把 WebView2 的原生菜单（刷新 / 另存为 / 检查 / 全选）换成应用自己的浮层，
// 顺带把「界面里的值可以复制出来」这件事做掉。
//
// 为什么必须自己画：这个窗口里没有地址栏也没有页面，原生菜单那几项全是噪音；
// 而它的配色来自系统，皮肤换成琥珀色后右键弹出来的还是系统灰。和托盘菜单是同一个
// 问题（docs/开发进度.md §34.5），托盘那条 tauri 没给 API 只能自绘，这条本来就能自绘。
//
// 为什么是「换」而不是「关」：只把右键禁掉，IP / 路径这类值就只剩「拖选 + Ctrl+C」
// 一条路，而表格行整行可点、拖选完 mouseup 还会补一个 click（main.js 的 bindTable
// 里有对应的守卫），手感和信任都差。右键菜单里直接给「复制」才是这件事的正解。
//
// 复制值从哪来（优先级）：
//   1. 已选中的文本       兜底能力 —— 界面上任何被拖选的东西都能通过它复制出去
//   2. [data-copy] 的值   显式标好的「值」（对端地址）：同格里的国旗图标不该跟着复制
//   3. 表格行             逐列复制 + 整行 TSV（能直接粘进 Excel）
// 三者都没有就不弹菜单（原生菜单同样已被拦下）。右键落在空白处什么都不发生，
// 比弹一个「没有可复制内容」的死菜单干净。
//
// 输入框是唯一的豁免：搜索框、API Key、日期框里的剪切 / 粘贴 / 全选只能靠系统菜单，
// 全应用禁掉会让「粘贴 Key」变成做不完的操作。
(function () {
  'use strict';

  // ---------- 纯逻辑（单测直接抽这一组，全部不碰 DOM） ----------

  /**
   * 抹掉零宽字符与 BOM。
   * 两个真实来源：检查栏的路径在 `\` 后插了零宽空格（为了能断在目录分隔符上，
   * 见 main.js 的 renderDetail），以及从别处粘进来的 BOM。不抹掉的话复制出去的
   * 路径看起来一模一样、粘进命令行却报「系统找不到指定的路径」——
   * 这类隐形脏字符只能在这个出口拦。
   */
  function stripInvisible(s) {
    return String(s == null ? '' : s).replace(/[\u200b-\u200f\ufeff]/g, '');
  }

  /**
   * 系统菜单的豁免判定。
   * 参数是「标签名 / contenteditable / input type」三个裸值，不碰 DOM，便于单测。
   * checkbox / range / color 这些没有文本可编辑，系统菜单对它们同样只有
   * 「刷新 / 另存为」这类噪音，所以不豁免。
   */
  function isEditableTarget(tagName, isContentEditable, type) {
    if (isContentEditable) return true;
    const tag = String(tagName == null ? '' : tagName).toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const t = String(type == null ? '' : type).toLowerCase();
    if (!t || t === 'text') return true;
    return ['search', 'url', 'password', 'email', 'tel', 'number', 'date',
      'datetime-local', 'month', 'week', 'time'].indexOf(t) >= 0;
  }

  /** 数值与单位在 DOM 里是两个节点（「1.23」+「MB/s」）。复制时要补回那个空格。 */
  function joinUnit(value, unit) {
    const v = stripInvisible(value).trim();
    const u = String(unit == null ? '' : unit).trim();
    return u ? `${v} ${u}` : v;
  }

  /**
   * 单元格的可复制文本。
   * 数值列是「值 + .u 单位」两个节点拼出来的，textContent 拿到的是「1.23MB/s」——
   * 粘到聊天窗口里连空格都没有，读起来是另一个东西（§32.1 统一坐标轴单位时
   * 刚踩过同一类问题）。unit 传空则原样返回。
   */
  function cellText(text, unit) {
    const whole = stripInvisible(text);
    const u = String(unit == null ? '' : unit).trim();
    // 文本尾部对不上单位（单元格结构变了、或本来就是纯文本列）就原样返回：
    // 硬拼一个不在文本里的单位会造出「1.2GB MB/s」这种既不真也不像的读数。
    if (!u || whole.slice(-u.length) !== u) return whole.trim();
    return joinUnit(whole.slice(0, whole.length - u.length), u);
  }

  /**
   * 一行 TSV。
   * 值里的制表符与换行必须抹成空格：它们就是列分隔符与行分隔符本身（进程路径、
   * 对端的服务名都可能带上），放过去会让整行错列 —— 粘进 Excel 时表现得像数据
   * 错乱，而不是像「复制失败」，是最难往回查的那一类。
   */
  function tsvRow(cells) {
    return (cells || [])
      .map((c) => stripInvisible(c).replace(/[\t\r\n]+/g, ' ').trim())
      .join('\t');
  }

  /** 浮层定位：贴指针，四边各留 pad。菜单比视口还大时收到 pad 上（高度由 CSS 钳）。 */
  function clampPos(x, y, w, h, vw, vh, pad) {
    const p = pad == null ? 8 : pad;
    const maxX = Math.max(p, Number(vw) - Number(w) - p);
    const maxY = Math.max(p, Number(vh) - Number(h) - p);
    return {
      x: Math.max(p, Math.min(Math.round(Number(x) || 0), maxX)),
      y: Math.max(p, Math.min(Math.round(Number(y) || 0), maxY)),
    };
  }

  /** 菜单右列的值预览：折成一行并截断。复制出去的始终是完整值，这里只是给人看。 */
  function preview(value, max) {
    const s = stripInvisible(value).replace(/\s+/g, ' ').trim();
    const n = max == null ? 26 : max;
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  }

  /**
   * 菜单模型。输入是「已经把值读出来的上下文」，不碰 DOM —— 单测可以直接喂。
   * 返回项要么是 { sep: true }（分隔线），要么是 { id, label, value, sub }。
   *
   * 「—」不进菜单：破折号是「这一格没有值」的显示形式，让它变成一项等于提供一个
   * 复制空内容的入口。但**整行**例外，它恒定含全部列 —— 列数固定了，粘进表格
   * 去才对得上，缺列比空值更难查。
   *
   * 逐列项只在「没命中具体字段」时展开：在 IP 上右键只需要那一项，不必把另外
   * 五列一起列出来；在行的空白处右键才需要挑。
   */
  function menuModel(input) {
    const it = input || {};
    const items = [];

    const sel = stripInvisible(it.selection).trim();
    if (sel) items.push({ id: 'selection', label: '复制选中内容', value: sel, sub: preview(sel) });

    for (const f of it.fields || []) {
      const v = stripInvisible(f && f.value).trim();
      if (!v || v === '—') continue;
      items.push({
        id: (f && f.id) || 'field',
        label: `复制${(f && f.label) || ''}`,
        value: v,
        sub: preview(v),
      });
    }

    if (it.row && !items.length) {
      for (const c of it.row.cells || []) {
        const v = stripInvisible(c && c.value).trim();
        if (!v || v === '—') continue;
        items.push({
          id: `cell:${(c && (c.key || c.label)) || ''}`,
          label: `复制${(c && c.label) || ''}`,
          value: v,
          sub: preview(v),
        });
      }
    }

    if (it.row && it.row.tsv) {
      if (items.length) items.push({ sep: true });
      items.push({
        id: 'row',
        label: '复制整行（制表符分隔）',
        value: it.row.tsv,
        sub: preview(it.row.tsv, 30),
      });
    }
    return items;
  }

  // ---------- DOM 侧 ----------

  let menu = null;      // 当前浮层。同一时刻最多一个，元素建一次反复用
  let toast = null;
  let toastTimer = 0;
  let prevFocus = null; // 打开菜单前的焦点，键盘路径（Esc）要还回去

  function menuNode() {
    if (menu) return menu;
    const el = document.createElement('div');
    el.className = 'ctx-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', '右键菜单');
    el.tabIndex = -1;
    el.hidden = true;
    el.addEventListener('keydown', onMenuKey);
    document.body.appendChild(el);
    menu = el;
    return el;
  }

  /**
   * 关掉当前菜单。restore 为真时把焦点还给打开它之前的元素（仅键盘路径）——
   * 滚动 / 失焦关闭不还焦点，那会把用户滚走的行又拉回视野里。
   */
  function closeMenu(restore) {
    if (!menu || menu.hidden) return false;
    menu.hidden = true;
    menu.replaceChildren();
    if (restore && prevFocus && document.contains(prevFocus) && prevFocus.focus) {
      prevFocus.focus({ preventScroll: true });
    }
    prevFocus = null;
    return true;
  }

  function toastNode() {
    if (toast) return toast;
    const el = document.createElement('div');
    el.className = 'ctx-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    document.body.appendChild(el);
    toast = el;
    return el;
  }

  /** 复制回执。菜单已经关了才显示，所以位置要由调用方先把矩形量出来传进来。 */
  function showToast(x, y, text, ok) {
    const el = toastNode();
    const parts = [];
    // 唯一一处 innerHTML：图标来自 common.js 的固定表，不含任何外部字符串。
    const svg = window.NetPeekCommon ? window.NetPeekCommon.icon(ok ? 'check' : 'alert') : '';
    if (svg) {
      const ic = document.createElement('span');
      ic.className = 'ctx-toast-ic';
      ic.innerHTML = svg;
      parts.push(ic);
    }
    const tx = document.createElement('span');
    tx.textContent = text;
    parts.push(tx);
    el.replaceChildren(...parts);
    el.classList.toggle('is-error', !ok);
    el.hidden = false;
    const r = el.getBoundingClientRect();
    const p = clampPos(x, y, r.width, r.height, window.innerWidth, window.innerHeight, 8);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ok ? 1200 : 2000);
  }

  // ---------- 上下文读取 ----------

  /** 右键目标可能是文本节点（老浏览器），统一收成元素。 */
  function elementOf(node) {
    if (!node) return null;
    if (node.nodeType === 1) return node;
    return node.parentElement || null;
  }

  /**
   * 有没有「就在这一块里」的选中文本。
   * 只认锚点落在右键目标同一块（目标本身 / 它的容器）里的选区：别处的旧选区跟着
   * 弹出来，会让人以为刚复制的是眼前这块。目标与容器互为祖先都算，这样「在表格里
   * 拖选了几行再右键其中一行」也算命中。
   */
  function selectionIn(target) {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return '';
    const txt = stripInvisible(sel.toString()).trim();
    if (!txt) return '';
    const anchor = sel.anchorNode;
    const holder = anchor ? (anchor.nodeType === 1 ? anchor : anchor.parentNode) : null;
    if (holder && !target.contains(holder) && !holder.contains(target)) return '';
    return txt;
  }

  /**
   * 一个可复制值的取值。
   * data-copy 优先于 textContent：对端格子里有国旗节点，textContent 会把图标的
   * 文本残留一起带上；而 IP 的完整形态（含端口与服务名）也只在 data-copy 里。
   */
  function fieldValue(el) {
    const explicit = el.getAttribute('data-copy');
    if (explicit != null) {
      const v = stripInvisible(explicit).trim();
      if (v) return v;
    }
    return stripInvisible(el.textContent).trim();
  }

  /** 值的名字。检查栏的字段是 dt/dd 一对，标签在左邻 —— 这样它们不用加属性。 */
  function copyLabel(el) {
    const own = el.getAttribute('data-copy-label');
    if (own) return stripInvisible(own).trim();
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === 'DT') return stripInvisible(prev.textContent).trim();
    return '';
  }

  /**
   * 读一整行。
   * 列名从表头按序号取，不写死 —— 加一列（比如 §33 的近 24 小时）时菜单自动跟着长，
   * 不需要回来改这里。
   *
   * 取值规则与单格一致：单元格自己声明了 data-copy 就用它，否则用「显示中的文本」
   * （数值列要补回数值与单位之间的空格）。对端列两个都有，声明的那份是完整形态
   * （IP:端口（服务名）），格子里的「104.18.32.115 · HTTPS」是为了省宽度压出来的
   * 显示形态 —— 复制出去的是能直接用的那个。
   */
  function readRow(tr) {
    const ths = document.querySelectorAll('.proc-table thead th');
    const cells = [];
    for (let i = 0; i < tr.children.length; i++) {
      const td = tr.children[i];
      const th = ths[i];
      const explicit = td.getAttribute('data-copy');
      const u = td.querySelector('.u');
      cells.push({
        key: (th && th.getAttribute('data-sort')) || String(i),
        label: th ? stripInvisible(th.textContent).replace(/\s+/g, ' ').trim() : '',
        value: explicit ? stripInvisible(explicit).trim() : cellText(td.textContent, u ? u.textContent : ''),
      });
    }
    return { cells, tsv: tsvRow(cells.map((c) => c.value)) };
  }

  function readContext(target) {
    const ctx = { selection: selectionIn(target), fields: [], row: null };

    const fieldEl = target.closest('[data-copy], [data-copy-label]');
    if (fieldEl) {
      const value = fieldValue(fieldEl);
      if (value) ctx.fields.push({ id: 'field', label: copyLabel(fieldEl), value });
    }

    const tr = target.closest('.proc-table tbody tr');
    if (tr && tr.children.length) ctx.row = readRow(tr);
    return ctx;
  }

  // ---------- 复制 ----------

  /**
   * 写剪贴板。
   * 首选异步剪贴板（tauri.localhost 属于安全上下文，满足前提），但它在「窗口没有
   * 键盘焦点」「企业策略禁用剪贴板」时会直接抛，所以必须留 execCommand 兜底 ——
   * 复制失败最怕的是静默：菜单关了、剪贴板还是上一次的内容。
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 落到下面的兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }

  // ---------- 开合 ----------

  function renderMenu(items) {
    const el = menuNode();
    const frag = document.createDocumentFragment();
    for (const it of items) {
      if (it.sep) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        s.setAttribute('role', 'separator');
        frag.appendChild(s);
        continue;
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctx-item';
      b.setAttribute('role', 'menuitem');
      const lb = document.createElement('span');
      lb.className = 'ctx-label';
      lb.textContent = it.label;
      b.appendChild(lb);
      if (it.sub) {
        const sb = document.createElement('span');
        sb.className = 'ctx-sub';
        sb.textContent = it.sub;
        b.appendChild(sb);
      }
      b.addEventListener('click', () => { void activate(it); });
      frag.appendChild(b);
    }
    // 菜单文案全程 textContent —— 里面会出现进程名、路径、对端的服务名，都是外部
    // 字符串（common.js 里 escapeHtml 的注释讲了同一课，这里干脆一条 innerHTML 都不用）。
    el.replaceChildren(frag);
  }

  /** 先亮出来量尺寸再定位：宽度是内容决定的，算不出就得量。 */
  function placeMenu(x, y) {
    const el = menuNode();
    el.hidden = false;
    el.style.visibility = 'hidden';
    el.style.left = '0px';
    el.style.top = '0px';
    const r = el.getBoundingClientRect();
    const p = clampPos(x, y, r.width, r.height, window.innerWidth, window.innerHeight, 8);
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.style.visibility = '';
    const first = el.querySelector('.ctx-item');
    if (first && first.focus) first.focus({ preventScroll: true });
  }

  async function activate(item) {
    const rect = menu && !menu.hidden ? menu.getBoundingClientRect() : null;
    closeMenu(false);
    if (!item || !item.value) return;
    const ok = await copyText(item.value);
    const x = rect ? rect.left : 24;
    const y = rect ? rect.top : 24;
    showToast(x, y, ok ? `已复制 ${preview(item.value, 18)}` : '复制失败', ok);
  }

  function onMenuKey(ev) {
    if (!menu || menu.hidden) return;
    const list = [...menu.querySelectorAll('.ctx-item')];
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      list[(i + 1 + list.length) % list.length].focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      list[(i - 1 + list.length) % list.length].focus();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      list[0].focus();
    } else if (ev.key === 'End') {
      ev.preventDefault();
      list[list.length - 1].focus();
    } else if (ev.key === 'Tab') {
      closeMenu(true);
    }
    // Enter / Space 由按钮自己触发 click，不在这里接管（U3：别把等价键写两遍）
  }

  function openFor(ev) {
    const target = elementOf(ev.target);
    if (!target) return;
    const model = menuModel(readContext(target));
    if (!model.length) { closeMenu(false); return; }
    // 记下打开前的焦点：菜单是被右键唤起的，不会自己挪焦点，关闭时（Esc / Tab）
    // 还回去才能接着用键盘。pointerdown 那一步已经把上一个菜单收掉了，此刻
    // activeElement 不是菜单项。
    prevFocus = document.activeElement;
    renderMenu(model);
    placeMenu(ev.clientX, ev.clientY);
  }

  function onContextMenu(ev) {
    const target = elementOf(ev.target);
    const type = target && target.getAttribute ? target.getAttribute('type') : null;
    if (target && isEditableTarget(target.tagName, target.isContentEditable, type)) {
      // 输入框里的剪切 / 粘贴 / 全选只有系统菜单给得了。同时把我们自己的浮层收掉，
      // 否则它会在输入框上方悬着，看起来像卡住了。
      closeMenu(false);
      return;
    }
    ev.preventDefault();
    openFor(ev);
  }

  function bindGlobal() {
    document.addEventListener('contextmenu', onContextMenu);
    // Esc 挂 document 而不是菜单本身：焦点可能已经不在菜单里（比如刚被 blur），
    // 挂在菜单上的话这一下就没反应。capture 保证它先于其他 Esc 处理跑。
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (menu && !menu.hidden) {
        ev.preventDefault();
        closeMenu(true);
      }
    }, true);
    document.addEventListener('pointerdown', (ev) => {
      if (menu && !menu.hidden && !menu.contains(elementOf(ev.target))) closeMenu(false);
    }, true);
    // 浮层是 position:fixed，底下滚了它不会跟着走 —— 与其漂在错的位置，不如收掉
    document.addEventListener('scroll', () => closeMenu(false), true);
    window.addEventListener('resize', () => closeMenu(false));
    window.addEventListener('blur', () => closeMenu(false));
  }

  // 脚本在 body 末尾加载，document 已可用；但仍按 readyState 判一次，
  // 免得以后有人把它挪进 <head> 时静默失效。
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindGlobal);
  else bindGlobal();
})();
