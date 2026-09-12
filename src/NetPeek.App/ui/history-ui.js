// 历史屏（§2.6，功能清单屏 3）。这一屏不放折线图：历史要回答的是「哪天用得多」，
// 柱状图直接可比、可点；折线只是把同一份日聚合数据画得更含糊。
//
// 数据来自后端：预设档走 history_daily(days)，「自定义…」档走 history_range(start, end)，
// 两者都返回按「本地日期 × 应用」聚合的行（自定义档过去只能靠天数近似，取回的数据
// 和所选窗口零重叠，柱图整片是空的 —— 所以后端加了真正的起止边界）。
// 不拉分钟级原始行 —— 30 天 × 1440 分钟 × N 进程的 JSON 前端解析不动，
// 日聚合在 SQL 里做完再过线。同一份数据同时喂三处：日柱状图、区间合计、应用排行。
// 检查栏的「30 天下载」窗口够用时复用，否则自己查一次 —— 它要的永远是最近 30 天，
// 和这一屏当前的档位不是一回事，见 dailyFor。

(function () {
  const $ = (id) => document.getElementById(id);
  const C = window.NetPeekCharts;
  const TOP_N = 8;
  const WEEK_AGG_THRESHOLD = 60; // 超过这个天数按周聚合：90 根 3px 宽的柱读不出也点不中
  // 自定义区间的长度上限。日期框里能敲出 1900 年，而 buildBuckets 会给区间里
  // 每一天都排一根柱 —— 没有上限的话，一次误输入就能让画布去画几万根柱。
  const MAX_RANGE_DAYS = 3660; // ≈10 年，按周聚合后约 523 组，画得动也读得出

  const els = {
    range: $('histRange'),
    aggNote: $('histAggNote'),
    exportBtn: $('histExport'),
    canvas: $('histChart'),
    customToggle: $('histCustomToggle'),
    customForm: $('histCustomRange'),
    startDate: $('histStartDate'),
    endDate: $('histEndDate'),
    customCancel: $('histCustomCancel'),
    rangeError: $('histRangeError'),
    rangeTitle: $('histRangeTitle'),
    rangeSub: $('histRangeSub'),
    sumDown: $('histSumDown'),
    sumUp: $('histSumUp'),
    sumAll: $('histSumAll'),
    rankTitle: $('histRankTitle'),
    rank: $('histRank'),
  };

  let days = 30;
  let customRange = null; // { start, end }；生效时 rows 由 history_range 查回，不再是「最近 N 天」
  let rows = [];          // [{ day, name, down, up }]
  let windowDays = 0;     // rows 覆盖的「最近 N 天」天数；自定义区间时为 0
  let inspectorRows = null; // 检查栏 30 天曲线的独立缓存，理由见 dailyFor
  let inspectorSpan = 0;
  let buckets = [];       // 图上每一组：{ key, label, down, up, days: [dayStr] }
  let selected = -1;      // 选中的柱索引，-1 = 看整个区间
  let hit = null;         // charts.bars 返回的命中测试
  let loaded = false;
  let loading = false;    // loadRows 进行中，柱图降透明 + 排行空态显示读取中
  let firstDay = null;    // 历史库最早有数据的本地日期（YYYY-MM-DD），打开浮层时从 history_stats 取

  // 图标从最近一帧快照借：历史库只存名字，不存图标。解析走主界面那份
  // iconOf —— 图标已改按路径缓存（IconUpdates 增量），进程数据里不再带图标本体。
  function iconFor(name) {
    const snap = window.NetPeekLive && window.NetPeekLive.lastSnapshot();
    if (!snap) return '';
    const key = String(name).toLowerCase();
    for (const p of snap.Processes || []) {
      if ((p.Name || '').toLowerCase() === key) {
        const icon = window.NetPeekLive.iconOf(p);
        if (icon) return icon;
      }
    }
    return '';
  }

  function fmt(bytes) {
    return window.NetPeekLive ? window.NetPeekLive.fmtBytes(bytes) : `${bytes} B`;
  }

  // 未归因流量的名字以半角括号开头，切首字符会在徽标里画一个孤零零的括号，
  // 读成渲染出错而不是占位 —— 首字母一律走 main.js 那份实现，两屏保持一致。
  function initial(name) {
    return window.NetPeekLive ? window.NetPeekLive.initialOf(name, 1) : '·';
  }

  function unattrName() {
    return window.NetPeekLive ? window.NetPeekLive.UNATTR : '(系统/未归因)';
  }

  // 生成从 days 天前到今天的连续本地日期串，缺数据的那天也要占一根空柱，
  // 否则「哪天没用网」这个信息会被压缩掉。
  function dayKeys(n) {
    const out = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (n - 1));
    for (let i = 0; i < n; i++) {
      out.push(dayKey(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  // 本地日期串。必须自己拼，不能用 toISOString() —— 后者按 UTC 出串，
  // UTC+8 的凌晨会被算成前一天，整排柱子错一格。
  function dayKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // 自定义区间：start..end，含两端。用带时间的字面量构造 ——
  // 裸的 'YYYY-MM-DD' 会被 Date 当成 UTC 解析，同样会错一格。
  // 上限判断在提交那侧按天数做，这里再兜一层，保证画布不会被喂进几万根柱。
  function dayKeysBetween(start, end) {
    const out = [];
    const d = new Date(`${start}T00:00:00`);
    const last = new Date(`${end}T00:00:00`);
    if (Number.isNaN(d.getTime()) || Number.isNaN(last.getTime())) return out;
    while (d <= last && out.length < MAX_RANGE_DAYS) {
      out.push(dayKey(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  // 区间天数（含两端）。直接数两个日期之间的毫秒数，夏令时切换那两天不是
  // 86400000 的整数倍，取整兜住。
  function spanDays(start, end) {
    const a = new Date(`${start}T00:00:00`);
    const b = new Date(`${end}T00:00:00`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.round((b - a) / 86_400_000) + 1;
  }

  function labelOf(dayStr) {
    const [, m, d] = dayStr.split('-');
    return `${Number(m)} 月 ${Number(d)} 日`;
  }

  function weekdayOf(dayStr) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(`${dayStr}T00:00:00`).getDay()] || '';
  }

  // 按天或按周分组。按周时组标签用周起始日。
  function buildBuckets() {
    const keys = customRange ? dayKeysBetween(customRange.start, customRange.end) : dayKeys(days);
    const perDay = new Map();
    for (const k of keys) perDay.set(k, { down: 0, up: 0 });
    for (const r of rows) {
      const slot = perDay.get(r.day);
      if (slot) { slot.down += r.down; slot.up += r.up; }
    }

    const weekly = keys.length > WEEK_AGG_THRESHOLD;
    els.aggNote.hidden = !weekly;
    if (!weekly) {
      return keys.map((k) => ({
        key: k, label: labelOf(k), days: [k],
        down: perDay.get(k).down, up: perDay.get(k).up,
      }));
    }
    const out = [];
    for (let i = 0; i < keys.length; i += 7) {
      const chunk = keys.slice(i, i + 7);
      let down = 0;
      let up = 0;
      for (const k of chunk) { down += perDay.get(k).down; up += perDay.get(k).up; }
      out.push({ key: chunk[0], label: labelOf(chunk[0]), days: chunk, down, up });
    }
    return out;
  }

  // x 轴只标两端和每个月初那一根（§2.6）
  function tickLabels() {
    const ticks = [];
    for (let i = 0; i < buckets.length; i++) {
      const d = buckets[i].key.split('-')[2];
      if (d === '01') ticks.push({ index: i, text: labelOf(buckets[i].key) });
    }
    return ticks;
  }

  function drawChart() {
    if (!buckets.length) return;
    hit = C.bars(els.canvas, {
      groups: buckets.map((b) => ({ label: b.label, values: [b.down, b.up] })),
      formatY: C.axisBytes,
      xLabels: [buckets[0].label, buckets[buckets.length - 1].label],
      tickLabels: tickLabels(),
      selectedIndex: selected,
      // 悬停小卡：两个系列的名称；周聚合时标题标「当周」，周合计不被读成单日
      seriesNames: ['下载', '上传'],
      tipTitle: (b) => (b.days.length > 1 ? `${b.label} 当周` : b.label),
    });
  }

  function renderSide() {
    const scope = selected >= 0 ? [buckets[selected]] : buckets;
    const dayFilter = selected >= 0 ? new Set(buckets[selected].days) : null;

    let down = 0;
    let up = 0;
    for (const b of scope) { down += b.down; up += b.up; }
    setTotal(els.sumDown, down);
    setTotal(els.sumUp, up);
    setTotal(els.sumAll, down + up);

    if (selected >= 0) {
      const b = buckets[selected];
      const many = b.days.length > 1;
      els.rangeTitle.textContent = many
        ? `${b.label} 起一周`
        : `${b.label} · ${weekdayOf(b.key)}`;
      els.rangeSub.textContent = '点柱状图空白处取消选中';
      els.rankTitle.textContent = many ? '本周应用排行' : '当日应用排行';
    } else if (customRange) {
      // 自定义区间不能再说「近 N 天」：区间可能整段在过去，而且它不是从今天倒数的。
      els.rangeTitle.textContent = `${customRange.start} ~ ${customRange.end}`;
      els.rangeSub.textContent = `共 ${buckets.reduce((n, b) => n + b.days.length, 0)} 天 · 点某一天可只看那天`;
      els.rankTitle.textContent = '应用排行';
    } else {
      els.rangeTitle.textContent = `近 ${days} 天`;
      els.rangeSub.textContent = '点柱状图上的某一天可只看那天';
      els.rankTitle.textContent = '应用排行';
    }

    // 应用排行：按下载量降序，行背景一条极淡的琥珀渐变表示占比（同 §2.5）。
    // 未选中柱时按整个当前区间过滤 —— 不能直接遍历 rows：history_daily 的截断点是
    // 「现在往前推 N 天」，跨天的那个窗口比 dayKeys(N) 多出小半天，排行会比柱图多算一截。
    const pool = selected >= 0 ? rows.filter((r) => dayFilter.has(r.day)) : filteredRows();
    const byApp = new Map();
    for (const r of pool) {
      const cur = byApp.get(r.name) || { down: 0, up: 0 };
      cur.down += r.down;
      cur.up += r.up;
      byApp.set(r.name, cur);
    }
    const ranked = Array.from(byApp, ([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.down - a.down)
      .slice(0, TOP_N);
    renderRank(ranked, ranked.length ? ranked[0].down : 0);
  }

  // 合计数字：数值 20px、单位 12px。一列只有 116px，整串按 20px 排会溢出，
  // 而这三个数是这一屏的头号数字，不该为了塞进去整体降级。
  function setTotal(el, bytes) {
    const s = fmt(bytes);
    const i = s.lastIndexOf(' ');
    if (i < 0) { el.textContent = s; return; }
    el.replaceChildren(
      document.createTextNode(s.slice(0, i)),
      Object.assign(document.createElement('span'), { className: 'u', textContent: s.slice(i + 1) }),
    );
  }

  // 排行数值：数字主体 + 小一号灰单位，与进程表速率列同一规则 ——
  // 整串同大同色时，一列「830.9 MB / 130.0 MB」读起来是八段等重的字符串。
  function valueHtml(bytes) {
    const s = fmt(bytes);
    const i = s.lastIndexOf(' ');
    if (i < 0) return escapeHtml(s);
    return `${escapeHtml(s.slice(0, i))}<span class="u">${escapeHtml(s.slice(i + 1))}</span>`;
  }

  function renderRank(list, peak) {
    if (!list.length) {
      els.rank.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'hint-row',
        // 查询进行中先说读取中：大区间首查要跑一会儿，「还没有落库的流量」
        // 在这个窗口期读起来像「查完了、确实没数据」。
        textContent: loading || !loaded ? '正在读取历史库…' : '这个区间还没有落库的流量',
      }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const app of list) {
      const row = document.createElement('div');
      row.className = 'rank-row';
      const share = peak > 0 ? Math.round((app.down / peak) * 100) : 0;
      row.style.setProperty('--share', `${share}%`);
      const icon = iconFor(app.name);
      const name = app.name || unattrName();
      row.innerHTML = `
        ${icon
          ? `<img class="rank-icon" src="${icon}" alt="" />`
          : `<span class="rank-icon is-placeholder">${escapeHtml(initial(app.name))}</span>`}
        <span class="rank-name">${escapeHtml(name)}</span>
        <span class="rank-value">${valueHtml(app.down)}</span>`;
      frag.appendChild(row);
    }
    els.rank.replaceChildren(frag);
    requestAnimationFrame(snapRankHeight);
  }

  // 排行列表高度取整到整行。检查栏 324px 的净高放不下「头部 + 合计 + 8×32 排行」，
  // 列表必须滚动；但半行卡在容器底边上会被读成被切掉的内容，所以量完可用高再往下取整。
  function snapRankHeight() {
    const list = els.rank;
    const row = list.firstElementChild;
    if (!row || !row.classList.contains('rank-row')) return;
    list.style.flex = '';
    list.style.height = '';
    const avail = list.clientHeight;
    const rowH = Math.round(row.getBoundingClientRect().height);
    if (!avail || !rowH) return;
    list.style.flex = 'none';
    list.style.height = `${Math.max(1, Math.floor(avail / rowH)) * rowH}px`;
  }

  const escapeHtml = window.NetPeekCommon.escapeHtml; // 统一走 common.js（U4）

  function activeDayKeys() {
    return customRange ? dayKeysBetween(customRange.start, customRange.end) : dayKeys(days);
  }

  function filteredRows() {
    const keys = new Set(activeDayKeys());
    return rows.filter((row) => keys.has(row.day));
  }

  async function loadRows() {
    // 加载态：柱图降透明，排行区如果还空着就把提示换成「读取中」。
    // 有旧数据时保留旧图不动 —— 换档期间闪一帧空图比沿用旧图更糟。
    loading = true;
    els.canvas.classList.add('is-loading');
    if (!els.rank.querySelector('.rank-row')) renderRank([], 0);
    // 自定义区间必须走 history_range：history_daily 只认「从今天往前数 N 天」，
    // 拿它查一个过去的区间只会取回与所选窗口零重叠的数据，柱图整片是空的。
    try {
      const raw = customRange
        ? await window.__TAURI__.core.invoke('history_range', {
            start: customRange.start,
            end: customRange.end,
          })
        : await window.__TAURI__.core.invoke('history_daily', { days });
      rows = JSON.parse(raw || '[]').filter((row) => row && typeof row.day === 'string');
      windowDays = customRange ? 0 : days;
    } catch {
      rows = []; // 浏览器预览或库不可用：画空坐标轴，不报错弹窗
      windowDays = customRange ? 0 : days;
    }
    loading = false;
    els.canvas.classList.remove('is-loading');
    loaded = true;
    buckets = buildBuckets();
    selected = -1;
    drawChart();
    renderSide();
  }

  function exportCsv() {
    const exportRows = filteredRows();
    const header = '日期,应用,下载字节,上传字节';
    const lines = exportRows.map((r) => `${r.day},"${String(r.name).replace(/"/g, '""')}",${r.down},${r.up}`);
    const blob = new Blob([`\ufeff${[header, ...lines].join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const keys = activeDayKeys();
    const suffix = customRange && keys.length ? `${keys[0]}_${keys[keys.length - 1]}` : `${days}d`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `netpeek-history-${suffix}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function closeCustomRange() {
    els.customForm.hidden = true;
    els.customToggle.setAttribute('aria-expanded', 'false');
    els.rangeError.hidden = true;
  }

  function showRangeError(message) {
    els.rangeError.textContent = message;
    els.rangeError.hidden = false;
  }

  // ---------- 事件绑定 ----------

  els.range.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    days = parseInt(btn.dataset.days, 10);
    customRange = null;
    closeCustomRange();
    els.range.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
    loadRows();
  });

  els.customToggle.addEventListener('click', () => {
    const opening = els.customForm.hidden;
    els.customForm.hidden = !opening;
    els.customToggle.setAttribute('aria-expanded', String(opening));
    els.rangeError.hidden = true;
    if (opening) {
      const keys = activeDayKeys();
      els.startDate.value = customRange ? customRange.start : keys[0];
      els.endDate.value = customRange ? customRange.end : keys[keys.length - 1];
      applyDateBounds();
      els.startDate.focus();
    }
  });

  // 日期框的边界在框上拦，不靠提交后报错（U1）：
  // max = 今天（end > today 原来只在提交时拦）；min = max(最早落库日, 今天-10 年)，
  // 早于最早落库日的区间查出来必然是空柱，与其让人选完再读一遍错误文案，
  // 不如日期选择器里就点不到。
  async function applyDateBounds() {
    const today = dayKeys(1)[0];
    els.startDate.max = today;
    els.endDate.max = today;
    if (firstDay) {
      els.startDate.min = firstDay;
      els.endDate.min = firstDay;
      return;
    }
    try {
      const raw = await window.__TAURI__.core.invoke('history_stats');
      const stats = JSON.parse(raw || '{}');
      if (stats.firstTs > 0) {
        firstDay = dayKey(new Date(stats.firstTs * 1000));
        // min 取「最早落库日」和「今天 - 10 年上限」里更晚的那个。
        const floor = dayKey(new Date(Date.now() - MAX_RANGE_DAYS * 86_400_000));
        const min = firstDay > floor ? firstDay : floor;
        els.startDate.min = min;
        els.endDate.min = min;
      }
    } catch { /* 浏览器预览或库不可用：不设 min，提交侧校验兜底 */ }
  }

  els.customCancel.addEventListener('click', closeCustomRange);

  // Esc 收起浮层。它盖在柱图上，键盘用户需要一个不等价的出口 ——
  // 「取消」按钮要 Tab 三下才够得着。
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.customForm.hidden) {
      closeCustomRange();
      els.customToggle.focus();
    }
  });

  els.customForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const start = els.startDate.value;
    const end = els.endDate.value;
    const today = dayKeys(1)[0];
    if (!start || !end) {
      showRangeError('请选择开始日期和结束日期。');
      return;
    }
    if (start > end) {
      showRangeError('开始日期不能晚于结束日期。');
      return;
    }
    if (end > today) {
      showRangeError('结束日期不能晚于今天。');
      return;
    }
    // min 属性拦得住选择器，拦不住手敲；整段落在最早记录之前的区间必然空柱。
    if (firstDay && end < firstDay) {
      showRangeError(`历史库最早记录是 ${firstDay}，这个区间没有数据。`);
      return;
    }
    const span = spanDays(start, end);
    if (span > MAX_RANGE_DAYS) {
      showRangeError(`区间最长 ${MAX_RANGE_DAYS} 天（约 10 年）。`);
      return;
    }
    customRange = { start, end };
    // 不动 days：它只表达「预设档的天数」。自定义区间有自己的 customRange，
    // 所有读 days 的路径都以 customRange 为先决条件，混写只会埋语义坑。
    // 三个预设胶囊都取消激活，把激活态交给「自定义…」——否则整组胶囊没有任何一个
    // 高亮，读起来像「当前档位丢了」。点预设档时那个 forEach 会顺手摘掉它。
    els.range.querySelectorAll('button').forEach((button) => button.classList.remove('is-active'));
    els.customToggle.classList.add('is-active');
    closeCustomRange();
    loadRows();
  });

  els.exportBtn.addEventListener('click', exportCsv);

  // 点柱选中某天，点空白处取消（§2.6）
  els.canvas.addEventListener('click', (e) => {
    if (!hit) return;
    const idx = hit.indexAt(e.clientX);
    selected = idx >= 0 && idx === selected ? -1 : idx;
    drawChart();
    renderSide();
  });

  // 键盘等价操作（U3）：canvas 带 tabindex 后方向键移选中、Esc 取消。
  // Esc 在浮层开着时由上面的 document 级处理器优先收浮层，两不干扰。
  els.canvas.addEventListener('keydown', (e) => {
    if (!buckets.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const next = selected < 0
        ? (step > 0 ? 0 : buckets.length - 1)   // 未选中：右 = 第一根，左 = 最后一根
        : Math.min(buckets.length - 1, Math.max(0, selected + step));
      if (next === selected) return;
      selected = next;
      drawChart();
      renderSide();
    } else if (e.key === 'Escape' && selected >= 0) {
      e.preventDefault();
      selected = -1;
      drawChart();
      renderSide();
    }
  });

  window.addEventListener('netpeek-themechange', () => { if (buckets.length) drawChart(); });

  window.NetPeekHistoryUI = {
    // 进入历史屏时拉一次；库每整分钟才落一次，不需要更勤
    async onEnter() {
      await loadRows();
    },
    redraw() {
      if (buckets.length) drawChart();
      snapRankHeight();
    },
    // 检查栏「30 天下载」要的是最近 n 天，和历史屏当前的档位不是一回事，
    // 所以不能无条件复用 rows：
    //   - 历史屏切到「近 7 天」时 rows 只有 7 天，30 天曲线会剩 23 根空柱；
    //   - 切到自定义区间时 rows 只覆盖用户挑的那一段，可能整段都在过去，
    //     拿它画「最近 30 天」等于把曲线清空。
    // 够用就复用（默认档位下零额外查询），不够用才自己查一次并缓存。
    async dailyFor(name, n) {
      let source = null;
      if (windowDays >= n) {
        source = rows;
      } else if (inspectorRows && inspectorSpan >= n) {
        source = inspectorRows;
      } else {
        // fallback 固定按 30 天兜底，不掺当前档位：days 在自定义区间下是区间长度
        // （最长 3660），拿它当查询跨度会拉全库日聚合，纯属浪费。
        const span = Math.max(n, 30);
        try {
          const raw = await window.__TAURI__.core.invoke('history_daily', { days: span });
          inspectorRows = JSON.parse(raw || '[]');
          inspectorSpan = span;
        } catch {
          inspectorRows = []; // 查不动就先不用缓存，下次选中行再试
          inspectorSpan = 0;
        }
        source = inspectorRows;
      }
      const keys = dayKeys(n);
      const perDay = new Map(keys.map((k) => [k, 0]));
      const key = name ? String(name).toLowerCase() : null;
      for (const r of source) {
        if (key && String(r.name).toLowerCase() !== key) continue;
        if (perDay.has(r.day)) perDay.set(r.day, perDay.get(r.day) + r.down);
      }
      return keys.map((k) => ({ key: k, label: labelOf(k), value: perDay.get(k) }));
    },
  };
})();
