// 历史屏（§2.6，功能清单屏 3）。这一屏不放折线图：历史要回答的是「哪天用得多」，
// 柱状图直接可比、可点；折线只是把同一份日聚合数据画得更含糊。
//
// 数据来自后端 history_daily(days)，返回按「本地日期 × 应用」聚合的行。
// 不用 query_history 拉分钟级原始行 —— 30 天 × 1440 分钟 × N 进程的 JSON 前端解析不动。
// 同一份数据同时喂三处：日柱状图、区间合计、应用排行；检查栏的「30 天下载」也复用它。

(function () {
  const $ = (id) => document.getElementById(id);
  const C = window.NetPeekCharts;
  const TOP_N = 8;
  const WEEK_AGG_THRESHOLD = 60; // 超过这个天数按周聚合：90 根 3px 宽的柱读不出也点不中

  const els = {
    range: $('histRange'),
    aggNote: $('histAggNote'),
    exportBtn: $('histExport'),
    canvas: $('histChart'),
    rangeTitle: $('histRangeTitle'),
    rangeSub: $('histRangeSub'),
    sumDown: $('histSumDown'),
    sumUp: $('histSumUp'),
    sumAll: $('histSumAll'),
    rankTitle: $('histRankTitle'),
    rank: $('histRank'),
  };

  let days = 30;
  let rows = [];          // [{ day, name, down, up }]
  let buckets = [];       // 图上每一组：{ key, label, down, up, days: [dayStr] }
  let selected = -1;      // 选中的柱索引，-1 = 看整个区间
  let hit = null;         // charts.bars 返回的命中测试
  let loaded = false;

  // 图标从最近一帧快照借：历史库只存名字，不存图标。
  function iconFor(name) {
    const snap = window.NetPeekLive && window.NetPeekLive.lastSnapshot();
    if (!snap) return '';
    const key = String(name).toLowerCase();
    for (const p of snap.Processes || []) {
      if ((p.Name || '').toLowerCase() === key && p.IconBase64) return p.IconBase64;
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
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      out.push(`${y}-${m}-${day}`);
      d.setDate(d.getDate() + 1);
    }
    return out;
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
    const keys = dayKeys(days);
    const perDay = new Map();
    for (const k of keys) perDay.set(k, { down: 0, up: 0 });
    for (const r of rows) {
      const slot = perDay.get(r.day);
      if (slot) { slot.down += r.down; slot.up += r.up; }
    }

    const weekly = days > WEEK_AGG_THRESHOLD;
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
    } else {
      els.rangeTitle.textContent = `近 ${days} 天`;
      els.rangeSub.textContent = '点柱状图上的某一天可只看那天';
      els.rankTitle.textContent = '应用排行';
    }

    // 应用排行：按下载量降序，行背景一条极淡的琥珀渐变表示占比（同 §2.5）
    const byApp = new Map();
    for (const r of rows) {
      if (dayFilter && !dayFilter.has(r.day)) continue;
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

  function renderRank(list, peak) {
    if (!list.length) {
      els.rank.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'hint-row',
        textContent: loaded ? '这个区间还没有落库的流量' : '正在读取历史库…',
      }));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const app of list) {
      const row = document.createElement('div');
      row.className = 'rank-row';
      const share = peak > 0 ? Math.round((app.down / peak) * 100) : 0;
      row.style.backgroundImage =
        `linear-gradient(90deg, rgba(240,145,63,0.09), rgba(240,145,63,0) ${share}%)`;
      const icon = iconFor(app.name);
      const name = app.name || unattrName();
      row.innerHTML = `
        ${icon
          ? `<img class="rank-icon" src="${icon}" alt="" />`
          : `<span class="rank-icon is-placeholder">${escapeHtml(initial(app.name))}</span>`}
        <span class="rank-name">${escapeHtml(name)}</span>
        <span class="rank-value">${fmt(app.down)}</span>`;
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadRows() {
    try {
      const raw = await window.__TAURI__.core.invoke('history_daily', { days });
      rows = JSON.parse(raw || '[]');
    } catch {
      rows = []; // 浏览器预览或库不可用：画空坐标轴，不报错弹窗
    }
    loaded = true;
    buckets = buildBuckets();
    selected = -1;
    drawChart();
    renderSide();
  }

  function exportCsv() {
    const header = '日期,应用,下载字节,上传字节';
    const lines = rows.map((r) => `${r.day},"${String(r.name).replace(/"/g, '""')}",${r.down},${r.up}`);
    const blob = new Blob([`\ufeff${[header, ...lines].join('\r\n')}\r\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `netpeek-history-${days}d.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- 事件绑定 ----------

  els.range.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    days = parseInt(btn.dataset.days, 10);
    els.range.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
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
    // 检查栏「30 天下载」复用同一份日聚合，按应用名过滤
    async dailyFor(name, n) {
      if (!loaded || rows.length === 0) {
        try {
          const raw = await window.__TAURI__.core.invoke('history_daily', { days: Math.max(n, days) });
          rows = JSON.parse(raw || '[]');
          loaded = true;
        } catch { rows = []; }
      }
      const keys = dayKeys(n);
      const perDay = new Map(keys.map((k) => [k, 0]));
      const key = name ? String(name).toLowerCase() : null;
      for (const r of rows) {
        if (key && String(r.name).toLowerCase() !== key) continue;
        if (perDay.has(r.day)) perDay.set(r.day, perDay.get(r.day) + r.down);
      }
      return keys.map((k) => ({ key: k, label: labelOf(k), value: perDay.get(k) }));
    },
  };
})();
