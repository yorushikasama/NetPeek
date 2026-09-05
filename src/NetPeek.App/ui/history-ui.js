// 历史屏（§2.6，功能清单屏 3）。
//
// 图表层用 vendored ECharts（ui/vendor/echarts.min.js，Apache-2.0，离线不走了 CDN）：
// - 下载/上传拆两个 grid、各自量程 —— 30 天里上传只有下载的 ~15%，
//   同量程下上传柱只剩贴地条，等于没画；
// - 悬浮浮层、时间轴、空态文案都交给组件，不再手绘；
// - 实时屏的 1Hz 折线仍是手绘 canvas（性能纪律 §4.2），这一屏是回看场景，交互与美观优先。
//
// 时间区间：预设（近 7/30/90 天）与自定义起止（「自定义」弹层，支持到小时）。
// 数据都走 history_range 命令：≤48h 按小时聚合、>90d 按周聚合、其余按本地日聚合，
// Rust 侧 GROUP BY 出桶，前端只做补零骨架（「哪天没用网」不被压缩掉）与展示。
// 检查栏「30 天下载」（实时屏）仍走 history_daily 的 dailyFor，与本屏解耦。

(function () {
  const $ = (id) => document.getElementById(id);
  const TOP_N = 8;
  const HOUR = 3600;
  const DAY = 86400;
  const WEEK = 7 * DAY;
  const CUSTOM_MAX_DAYS = 365;

  const els = {
    range: $('histRange'),
    customBtn: $('histCustom'),
    customPop: $('histCustomPop'),
    customFrom: $('histFrom'),
    customTo: $('histTo'),
    customApply: $('histApply'),
    customClose: $('histCustomClose'),
    customErr: $('histCustomErr'),
    exportBtn: $('histExport'),
    chart: $('histChart'),
    rangeTitle: $('histRangeTitle'),
    rangeSub: $('histRangeSub'),
    sumDown: $('histSumDown'),
    sumUp: $('histSumUp'),
    sumAll: $('histSumAll'),
    rankTitle: $('histRankTitle'),
    rank: $('histRank'),
  };

  let chart = null;         // echarts 实例（惰性初始化）
  let mode = 'preset';      // 'preset' | 'custom'
  let days = 30;
  let custom = null;        // { start, end, bucket }
  let buckets = [];         // { key, start, end, label, down, up }
  let rowsKeyed = [];       // [{ key, name, down, up }]（Rust 侧已按桶聚合）
  let selected = -1;        // 选中的桶索引，-1 = 看整个区间
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

  function initial(name) {
    return window.NetPeekLive ? window.NetPeekLive.initialOf(name, 1) : '·';
  }

  function unattrName() {
    return window.NetPeekLive ? window.NetPeekLive.UNATTR : '(系统/未归因)';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function nowSecs() {
    return Math.floor(Date.now() / 1000);
  }

  function localMidnight(ts) {
    const d = new Date(ts * 1000);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function dayLabelOf(ts) {
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function hourLabelOf(ts) {
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad2(d.getHours())}时`;
  }

  function weekdayOf(ts) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(ts * 1000).getDay()] || '';
  }

  function fmtLocal(ts, withTime) {
    const d = new Date(ts * 1000);
    const base = `${d.getMonth() + 1}月${d.getDate()}日`;
    return withTime ? `${base} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : base;
  }

  // 当前查询区间。预设按本地零点回溯（含今天），自定义用用户输入。
  function currentRange() {
    if (mode === 'custom' && custom) return custom;
    return {
      start: localMidnight(nowSecs()) - (days - 1) * DAY,
      end: nowSecs() + 60,
      bucket: 0,
    };
  }

  // 补零骨架：没有落库的桶也要占位，「那天没用网」是信息不是空白。
  function buildBuckets(range) {
    const out = [];
    if (range.bucket === HOUR) {
      const first = Math.floor(range.start / HOUR) * HOUR;
      for (let ts = first; ts < range.end; ts += HOUR) {
        out.push({ key: ts, start: ts, end: ts + HOUR, label: hourLabelOf(ts) });
      }
    } else if (range.bucket === WEEK) {
      const first = Math.floor(range.start / WEEK) * WEEK;
      for (let ts = first; ts < range.end; ts += WEEK) {
        out.push({ key: ts, start: ts, end: ts + WEEK, label: `${dayLabelOf(ts)} 起一周` });
      }
    } else {
      // 本地日桶按 +86400 推进：中国无夏令时，边界稳定；跨夏令时时区是后续项。
      for (let ts = localMidnight(range.start); ts < range.end; ts += DAY) {
        out.push({ key: ts, start: ts, end: ts + DAY, label: dayLabelOf(ts) });
      }
    }
    for (const b of out) { b.down = 0; b.up = 0; }
    return out;
  }

  async function loadRows() {
    const range = currentRange();
    try {
      const raw = await window.__TAURI__.core.invoke('history_range',
        { start: range.start, end: range.end, bucket: range.bucket });
      const apiRows = JSON.parse(raw || '[]');
      buckets = buildBuckets(range);
      rowsKeyed = apiRows.map((r) => ({ key: r.ts, name: r.name, down: r.down, up: r.up }));
      const byKey = new Map(buckets.map((b) => [b.key, b]));
      for (const r of rowsKeyed) {
        const b = byKey.get(r.key);
        if (b) { b.down += r.down; b.up += r.up; }
      }
    } catch {
      // 浏览器预览或库不可用：画补零空骨架，不报错弹窗
      buckets = buildBuckets(range);
      rowsKeyed = [];
    }
    loaded = true;
    selected = -1;
    render();
  }

  // ---------- ECharts 图表层 ----------

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // y 轴紧凑字节：52~56px 的轴槽放不下「1024.00 MB」这种全长格式
  function compactBytes(v) {
    if (!(v > 0)) return '0';
    const units = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'K']];
    for (const [scale, tag] of units) {
      if (v >= scale) {
        const n = v / scale;
        return `${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 0 : 1)}${tag}`;
      }
    }
    return `${Math.round(v)}`;
  }

  function ensureChart() {
    if (!chart && window.echarts) {
      chart = echarts.init(els.chart);
      chart.on('click', (params) => {
        if (params.componentType === 'series') selectBucket(params.dataIndex);
      });
      // 点空白处取消选中：zr 事件在空白处 target 为空，落在系列上则已被上面的 handler 处理
      chart.getZr().on('click', () => {
        if (selected !== -1) { selected = -1; render(); }
      });
      window.addEventListener('resize', () => chart && chart.resize());
    }
    return chart;
  }

  function dimOf(i) {
    return selected >= 0 && i !== selected ? 0.45 : 1;
  }

  function barStyle(color) {
    return {
      color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color },
        { offset: 1, color: `${color}59` },
      ]),
      borderRadius: [3, 3, 0, 0],
    };
  }

  function renderChart() {
    const c = ensureChart();
    if (!c) return; // ECharts 未加载（极端降级）：检查栏数字仍可用
    // 实例尺寸与容器不符（init 落在布局完成前会拿到 0×0 → ECharts 回退 100×100）就重量测
    if (c.getWidth() !== els.chart.clientWidth || c.getHeight() !== els.chart.clientHeight) {
      c.resize();
    }

    const mut = cssVar('--text-muted', '#b4a99e');
    const txt = cssVar('--text', '#f6efe8');
    const line = 'rgba(255,255,255,0.08)';
    const surface = cssVar('--surface', '#1e1a16');
    const down = cssVar('--down', '#f0913f');
    const up = cssVar('--up', '#7fa8c9');
    const dataMax = buckets.reduce((m, b) => Math.max(m, b.down, b.up), 0);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = buckets.length ? buckets[0].start * 1000 : 0;
    const t1 = buckets.length ? buckets[buckets.length - 1].end * 1000 : 1;

    c.setOption({
      animation: !reduced,
      animationDuration: 260,
      title: loaded && dataMax === 0 ? {
        text: '这个区间还没有落库的流量',
        left: 'center', top: 'middle',
        textStyle: { color: mut, fontSize: 13, fontWeight: 400 },
      } : undefined,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.06)' } },
        backgroundColor: surface,
        borderColor: 'rgba(255,255,255,0.12)',
        textStyle: { color: txt, fontSize: 12 },
        formatter: (params) => {
          const first = Array.isArray(params) ? params[0] : params;
          const b = buckets[first.dataIndex];
          if (!b) return '';
          const title = `<div style="color:${mut};margin-bottom:4px">${escapeHtml(b.label)}</div>`;
          return `${title}<span style="color:${down}">▼ 下载 ${fmt(b.down)}</span><br/>` +
            `<span style="color:${up}">▲ 上传 ${fmt(b.up)}</span>`;
        },
      },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: 56, right: 14, top: 14, height: '56%' },
        { left: 56, right: 14, top: '76%', height: '18%' },
      ],
      xAxis: [
        { type: 'time', gridIndex: 0, min: t0, max: t1,
          axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false } },
        { type: 'time', gridIndex: 1, min: t0, max: t1,
          axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false },
          axisLabel: { color: mut, fontSize: 11, hideOverlap: true } },
      ],
      yAxis: [
        { type: 'value', gridIndex: 0, splitNumber: 3,
          axisLabel: { color: mut, fontSize: 11, formatter: compactBytes },
          splitLine: { lineStyle: { color: line, type: 'dashed' } } },
        { type: 'value', gridIndex: 1, splitNumber: 2,
          axisLabel: { color: mut, fontSize: 11, formatter: compactBytes },
          splitLine: { show: false } },
      ],
      series: [
        { name: '下载', type: 'bar', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 22,
          itemStyle: { ...barStyle(down), opacity: 1 },
          data: buckets.map((b, i) => ({ value: [b.start * 1000, b.down], itemStyle: { opacity: dimOf(i) } })) },
        { name: '上传', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 22,
          itemStyle: { ...barStyle(up), opacity: 1 },
          data: buckets.map((b, i) => ({ value: [b.start * 1000, b.up], itemStyle: { opacity: dimOf(i) } })) },
      ],
    }, true);
  }

  // ---------- 检查栏（合计 + 排行） ----------

  function renderSide() {
    const b = selected >= 0 ? buckets[selected] : null;
    const scope = b ? [b] : buckets;

    let down = 0;
    let up = 0;
    for (const it of scope) { down += it.down; up += it.up; }
    setTotal(els.sumDown, down);
    setTotal(els.sumUp, up);
    setTotal(els.sumAll, down + up);

    if (b) {
      // 选中态标题：日桶带星期，小时/周桶直接用桶标签
      els.rangeTitle.textContent = (b.end - b.start === DAY)
        ? `${b.label} · ${weekdayOf(b.start)}`
        : b.label;
      els.rangeSub.textContent = '点柱状图空白处取消选中';
      els.rankTitle.textContent = b.end - b.start === HOUR ? '该时段应用排行'
        : (b.label.includes('一周') ? '本周应用排行' : '当日应用排行');
    } else if (mode === 'custom' && custom) {
      els.rangeTitle.textContent = `${fmtLocal(custom.start, custom.bucket === HOUR)} – ${fmtLocal(custom.end, true)}`;
      els.rangeSub.textContent = '点柱状图上的某一格可只看那段时间';
      els.rankTitle.textContent = '应用排行';
    } else {
      els.rangeTitle.textContent = `近 ${days} 天`;
      els.rangeSub.textContent = '点柱状图上的某一天可只看那天';
      els.rankTitle.textContent = '应用排行';
    }

    renderRank();
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

  function renderRank() {
    const b = selected >= 0 ? buckets[selected] : null;
    const byApp = new Map();
    for (const r of rowsKeyed) {
      if (b && r.key !== b.key) continue;
      const cur = byApp.get(r.name) || { down: 0, up: 0 };
      cur.down += r.down;
      cur.up += r.up;
      byApp.set(r.name, cur);
    }
    const ranked = Array.from(byApp, ([name, v]) => ({ name, ...v }))
      .sort((a, b2) => b2.down - a.down)
      .slice(0, TOP_N);

    if (!ranked.length) {
      els.rank.replaceChildren(Object.assign(document.createElement('div'), {
        className: 'hint-row',
        textContent: loaded ? '这个区间还没有落库的流量' : '正在读取历史库…',
      }));
      return;
    }
    const peak = ranked[0].down;
    const frag = document.createDocumentFragment();
    for (const app of ranked) {
      const row = document.createElement('div');
      row.className = 'rank-row';
      const share = peak > 0 ? Math.round((app.down / peak) * 100) : 0;
      row.style.backgroundImage =
        `linear-gradient(90deg, rgba(240,145,63,0.09), rgba(240,145,63,0) ${share}%)`;
      // 行内只放主值（下载，排序键）；双向明细进悬浮提示，不挤 116px 的值列
      row.title = `下载 ${fmt(app.down)} · 上传 ${fmt(app.up)}`;
      const icon = iconFor(app.name);
      const name = app.name || unattrName();
      row.innerHTML = `
        ${icon
          ? `<img class="rank-icon" src="${icon}" alt="" />`
          : `<span class="rank-icon is-placeholder">${escapeHtml(initial(app.name))}</span>`}
        <span class="rank-name">${escapeHtml(name)}</span>
        <span class="rank-value">${escapeHtml(fmt(app.down))}</span>`;
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

  function render() {
    renderChart();
    renderSide();
  }

  function selectBucket(i) {
    selected = selected === i ? -1 : i;
    render();
  }

  // ---------- 自定义时间区间 ----------

  let fpFrom = null;
  let fpTo = null;

  const PICKER = {
    enableTime: true,
    time_24hr: true,
    dateFormat: 'Y-m-d H:i',
    locale: 'zh',
    allowInput: false,        // 只用选择器输入，避免手打的畸形时间
    minuteStep: 5,
  };

  function initPickers() {
    if (fpFrom || !window.flatpickr) return;
    fpFrom = flatpickr(els.customFrom, PICKER);
    fpTo = flatpickr(els.customTo, PICKER);
  }

  function fmtInputValue(ts) {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function setCustomError(msg) {
    els.customErr.textContent = msg;
    els.customErr.hidden = !msg;
  }

  function openCustom() {
    initPickers();
    els.customPop.hidden = false;
    els.customBtn.classList.add('is-active');
    els.customBtn.setAttribute('aria-expanded', 'true');
    setCustomError('');
    const end = nowSecs() + 60;
    if (fpFrom && fpTo) {
      fpFrom.setDate((custom ? custom.start : end - 24 * HOUR) * 1000, false);
      fpTo.setDate((custom ? custom.end : end) * 1000, false);
    }
  }

  function closeCustom() {
    els.customPop.hidden = true;
    // Flatpickr 日历挂在 body 上，不受弹层 hidden 影响，要显式收起
    if (fpFrom) fpFrom.close();
    if (fpTo) fpTo.close();
    if (mode !== 'custom') els.customBtn.classList.remove('is-active');
    els.customBtn.setAttribute('aria-expanded', 'false');
  }

  function applyCustom() {
    const dFrom = fpFrom && fpFrom.selectedDates[0];
    const dTo = fpTo && fpTo.selectedDates[0];
    if (!dFrom || !dTo) {
      setCustomError('请先选择开始和结束时间');
      return;
    }
    const start = Math.floor(dFrom.getTime() / 1000);
    const end = Math.floor(dTo.getTime() / 1000);
    if (end <= start) {
      setCustomError('结束时间要晚于开始时间');
      return;
    }
    const spanDays = (end - start) / DAY;
    if (spanDays > CUSTOM_MAX_DAYS) {
      setCustomError(`区间最长 ${CUSTOM_MAX_DAYS} 天`);
      return;
    }
    setCustomError('');
    custom = { start, end, bucket: spanDays <= 2 ? HOUR : (spanDays > 90 ? WEEK : 0) };
    mode = 'custom';
    // 自定义生效时预设不再高亮，当前区间以检查栏标题为准
    els.range.querySelectorAll('button').forEach((b) => b.classList.remove('is-active'));
    closeCustom();
    loadRows();
  }

  function applyQuick(kind) {
    if (!fpFrom || !fpTo) return;
    const end = nowSecs() + 60;
    let start;
    if (kind === '24h') {
      start = end - 24 * HOUR;
    } else if (kind === 'today') {
      start = localMidnight(nowSecs());
    } else {
      start = localMidnight(nowSecs()) - DAY;
      end = localMidnight(nowSecs());
    }
    fpFrom.setDate(start * 1000, false);
    fpTo.setDate(end * 1000, false);
  }

  // ---------- 导出 ----------

  function exportCsv() {
    // 导出跟随当前视野：选中某桶时只导该桶的行，与检查栏口径一致
    const b = selected >= 0 ? buckets[selected] : null;
    const scoped = b ? rowsKeyed.filter((r) => r.key === b.key) : rowsKeyed;
    const header = '时间,应用,下载字节,上传字节';
    const labelByKey = new Map(buckets.map((it) => [it.key, it.label]));
    const lines = scoped.map((r) => {
      const t = labelByKey.get(r.key) || String(r.key);
      return `"${t}","${String(r.name).replace(/"/g, '""')}",${r.down},${r.up}`;
    });
    const blob = new Blob([`\ufeff${[header, ...lines].join('\r\n')}\r\n`], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const scope = b ? b.label.replace(/\s/g, '') : (mode === 'custom' ? 'custom' : `${days}d`);
    a.download = `netpeek-history-${scope}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- 事件绑定 ----------

  els.range.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    days = parseInt(btn.dataset.days, 10);
    mode = 'preset';
    els.range.querySelectorAll('button').forEach((b) => b.classList.toggle('is-active', b === btn));
    els.customBtn.classList.remove('is-active');
    closeCustom();
    loadRows();
  });

  els.customBtn.addEventListener('click', () => {
    if (els.customPop.hidden) openCustom(); else closeCustom();
  });
  els.customClose.addEventListener('click', closeCustom);
  els.customApply.addEventListener('click', applyCustom);
  els.customPop.querySelector('.hist-custom-quick').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-quick]');
    if (btn) applyQuick(btn.dataset.quick);
  });

  els.exportBtn.addEventListener('click', exportCsv);

  window.addEventListener('netpeek-themechange', () => render());

  window.NetPeekHistoryUI = {
    // 进入历史屏时拉一次；库每整分钟才落一次，不需要更勤
    async onEnter() {
      await loadRows();
    },
    redraw() {
      render();
    },
    // 检查栏「30 天下载」复用日聚合（独立小图，走 history_daily 按天路径）。
    // 每次现查：库每整分钟落一次盘，过期缓存会让「今天」这根柱停在旧值。
    async dailyFor(name, n) {
      let rows = [];
      try {
        const raw = await window.__TAURI__.core.invoke('history_daily', { days: n });
        rows = JSON.parse(raw || '[]');
      } catch { rows = []; }
      const keys = [];
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (n - 1));
      for (let i = 0; i < n; i++) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        keys.push(`${y}-${m}-${day}`);
        d.setDate(d.getDate() + 1);
      }
      const perDay = new Map(keys.map((k) => [k, 0]));
      const key = name ? String(name).toLowerCase() : null;
      for (const r of rows) {
        if (key && String(r.name).toLowerCase() !== key) continue;
        if (perDay.has(r.day)) perDay.set(r.day, perDay.get(r.day) + r.down);
      }
      return keys.map((k) => ({
        key: k,
        label: `${Number(k.split('-')[1])}月${Number(k.split('-')[2])}日`,
        value: perDay.get(k),
      }));
    },
  };
})();
