// NetPeek 图表渲染 —— 基于 ECharts 5（vendor/echarts.min.js，Apache-2.0）。
// 历史教训记在这里：这套图先手写 canvas（281ed8b），换 ECharts（64e8e8a），又回到
// 手写，2026-09 最终定版为 ECharts —— 手写版悬停卡、虚线段、稀疏刻度加起来 500 行
// bespoke 代码，每条视觉规则都要自己实现、自己圆；ECharts 把这些换成标准视觉语言
//（十字准线、共享悬浮卡、优雅刻度），用户一眼就懂。
//
// 对外 API 与手写版完全一致：line(el, opt) / bars(el, opt) / axisBytes / axisRate，
// 调用点（main.js / history-ui.js）不需要知道底下换了引擎。el 是容器 div
//（ECharts 自己在里面建 canvas）。
//
// ===== 动效预算（§3.7 的「禁止常驻补间」在新引擎下的落法）=====
// 数据每秒一帧，图不能永远在动。这里的纪律：
//   - 每次数据更新只给 190ms 的收尾过渡（新点滑入、旧点左移、颜色渐变），
//     占空比 19%，动完即停 —— 传达「数据来了」，不是不停表演；
//   - 入场动画 320ms 只在实例首次建立时跑一次，柱图带每根 4ms 的递进延迟；
//   - 结构变化（空态↔数据、暂停虚线段出现）走 notMerge 直接切换，不补间 ——
//     数据语义变了，滑动画出来是误导；
//   - prefers-reduced-motion 时全部时长归零，动效退化为瞬切。

(function () {
  // 绘图区几何（px）。固定值是有意的：hitTest（bars 返回的 indexAt）按这套
  // 几何反推行下标，跟着 ECharts 内部布局走反而要翻私有 API。
  // left 是**下限**不是定值：真实槽宽由 yGutter() 按三档标注实测后撑开，
  // 这样「6.0 MB/s」拿到 63px、30 天图的「40 GB」仍然只占 52px，
  // 不必为了最长的那种标注把每张图都留一条空槽。
  const GRID = { left: 52, right: 8, top: 8, bottom: 20 };
  const FONT_NUM = '"Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, monospace';
  const FONT_SIZE = 11;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // 把 #rrggbb 转 rgba()，用于渐变填充、悬浮卡、指针阴影。
  function rgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  // 上限取整到整数刻度，避免「23.7 MB/s」这种读不出的刻度。
  // 只有 1/2/5 三档时 2.6 会被顶到 5（26G 的峰值配 50G 的量程），绘图区一半是空的；
  // 加密中间档把最坏情况的留白从 100% 压到 33%。
  const NICE_STEPS = [1, 1.5, 2, 3, 4, 5, 6, 8, 10];
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const f = v / base;
    for (const step of NICE_STEPS) {
      // 浮点余量：1e9 在 log10 上会算出 8.999…，f 得到 10.000000000000002，
      // 不留余量就会掉出这张表、返回 undefined。
      if (f <= step * (1 + 1e-9)) return step * base;
    }
    return 10 * base;
  }

  // 空态 / 待机量程。没有采样时坐标轴不能只给「0 到 1 字节」：那会让
  // interval 落到 0.5，而 0.5 和 1 恰好格式化成同一个字符串，两个刻度叠字。
  // 这里给的是各量级里读起来像仪表的待机范围 —— 曲线为空，刻度仍然成立。
  const IDLE_RATE = 1e6;    // 折线（速率）→ 0 / 500 KB/s / 1.0 MB/s
  const IDLE_BYTES = 1e9;   // 柱图（累计量）→ 0 / 500 MB / 1.00 GB

  // 坐标标注专用的紧凑格式。
  //
  // 单位必须和界面其它地方（fmtBytes / fmtRate 的「1.00 MB/s」）用同一套写法。
  // 这里曾经缩写成 K / M / G，于是实时图的轴标注是「6.0M/s」——没有 B，
  // 读起来是「六米每秒」，而且同一屏里顶栏写「5.12 MB/s」、坐标写「6.0M/s」，
  // 两套单位并排出现，是最典型的「差一口气」。
  // 槽宽由 yGutter() 按实际标注实测后撑开，所以这里不必再为省字符牺牲可读性。
  function axisNum(v, suffix) {
    if (!(v > 0)) return '0';
    const units = [[1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']];
    for (const [scale, tag] of units) {
      if (v >= scale) {
        const n = v / scale;
        return `${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 0 : 1)} ${tag}${suffix}`;
      }
    }
    // 不足 1 KB 的量级只可能是空态占位，带上 B 才不会被当成无量纲的数字
    const n = v < 10 && !Number.isInteger(v) ? v.toFixed(1) : Math.round(v);
    return `${n} B${suffix}`;
  }

  const axisBytes = (v) => axisNum(v, '');
  const axisRate = (v) => axisNum(v, '/s');

  // 悬浮卡用的全精度格式。y 轴为了塞进 52px 用紧凑格式，读数里要能看出
  // 「2.35 MB/s」这种两位小数 —— 两处格式化有意不同。
  function fmtFull(v, suffix) {
    if (!(v > 0)) return `0${suffix}`;
    const units = [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']];
    for (const [scale, tag] of units) {
      if (v >= scale) {
        const n = v / scale;
        return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${tag}${suffix}`;
      }
    }
    return `${Math.round(v)}${suffix}`;
  }

  // ---------- ECharts 实例管理 ----------

  const registry = new Map();   // el -> { chart, key, played, ro }

  const reduceMotion = () =>
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 拿到（或建起）el 上的实例。容器不可见（宽 0）时不建 —— ECharts 在 0 尺寸上
  // 初始化会留下一个布局坏掉的实例，等可见后的下一次调用自然补上。
  function acquire(el) {
    if (!window.echarts) return null;
    let entry = registry.get(el);
    if (!entry) { entry = {}; registry.set(el, entry); }
    if (!entry.chart) {
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return null;
      entry.chart = window.echarts.init(el);
      // 尺寸跟随宿主，不靠「恰好再来一次重绘」：940×620 下首进历史屏时
      // 排行栏还没稳，flex 分完高度 ECharts 已经按旧高度建好画布了 —— 实测
      // 439 vs 稳定后 399，底部 40px 连同 x 轴标签被裁出窗口，且之后再没有
      // 任何事件会触发重画。ResizeObserver 在宿主尺寸变化的那一帧补 resize。
      entry.ro = new ResizeObserver(() => {
        if (!entry.chart) return;
        if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
        if (entry.chart.getWidth() !== el.clientWidth || entry.chart.getHeight() !== el.clientHeight) {
          entry.chart.resize();
        }
      });
      entry.ro.observe(el);
    } else if (el.clientWidth > 0 && el.clientHeight > 0
      && (entry.chart.getWidth() !== el.clientWidth || entry.chart.getHeight() !== el.clientHeight)) {
      entry.chart.resize();
    }
    return entry;
  }

  // 系列数量 / 虚线段 / 选中态这类「形状」变了就整个换 option（不补间）；
  // 只是数据流过去（每秒一帧）就走 merge，悬浮卡在刷新期间保持稳定不掉。
  function setShape(entry, key, option) {
    const structural = entry.key !== key;
    entry.key = key;
    entry.chart.setOption(option, { notMerge: structural });
  }

  // ---------- 公共的坐标轴 / 悬浮卡片段 ----------

  function axisLabelOpt() {
    return {
      color: cssVar('--text-2') || '#9ba1a9',
      fontSize: FONT_SIZE,
      fontFamily: FONT_NUM,
      margin: 8,
    };
  }

  // ECharts 的轴标签以刻度为中心，柱图末端的「9 月 12 日」有一半会画出绘图区
  // 被容器裁掉（旧手写版是右端标注右对齐解决的）。这里按首末标签实测宽度
  // 把 grid 边距撑开，标签刚好收在容器里。缓存一个离屏 ctx 专供测量。
  let measureCtx = null;
  function textW(s) {
    if (!s) return 0;
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = `${FONT_SIZE}px ${FONT_NUM}`;
    }
    return measureCtx.measureText(String(s)).width;
  }

  function gridFor(opt, yLeft) {
    const grid = { ...GRID };
    // y 轴槽先撑开：下面按 x 端标注撑开的写不回去（只增不减），顺序无关，但要在这里合并
    if (yLeft) grid.left = Math.max(grid.left, yLeft);
    if (!opt) return grid;
    const first = opt.groups && opt.groups.length
      ? opt.groups[0].label
      : (opt.xLabels && opt.xLabels[0]);
    const last = opt.groups && opt.groups.length
      ? opt.groups[opt.groups.length - 1].label
      : (opt.xLabels && opt.xLabels.length > 1 ? opt.xLabels[opt.xLabels.length - 1] : null);
    const need = (s) => Math.ceil(textW(s) / 2) + 6;
    if (first) grid.left = Math.max(grid.left, need(first));
    if (last) grid.right = Math.max(grid.right, need(last));
    return grid;
  }

  // y 轴槽宽度：把三个刻度真格式化一遍再量宽，而不是按「最多 6 个字符」估。
  // 轴标注走的是等宽字族，量得准；加 10px 是 tick 与文字之间的呼吸位。
  function yGutter(yMax, formatY) {
    const fmt = formatY || axisRate;
    const w = [0, yMax / 2, yMax].reduce((m, v) => Math.max(m, textW(fmt(v))), 0);
    return Math.ceil(w) + 10;
  }

  function yAxisOpt(yMax, formatY) {
    return {
      type: 'value',
      min: 0,
      max: yMax,
      // 上限 / 中位 / 底，三档 —— 和旧手写版同一套三行刻度
      interval: yMax / 2,
      axisLine: { show: false },
      axisTick: { show: false },
      // 网格线用 --line 而不是 --line-soft：后者在 --panel 上只有 1.06:1，
      // 等于没画 —— 图里少了横向基准，曲线浮在一片空底上，读数只能靠猜。
      // --line 是 1.26:1（浅色皮肤下同样量级），刚好「看得见但不抢线」。
      // 两档 token 都随皮肤覆写，所以换肤后网格线自动跟着换。
      splitLine: { lineStyle: { color: cssVar('--line') || '#32363e', type: 'dashed' } },
      axisLabel: { ...axisLabelOpt(), formatter: formatY },
    };
  }

  function tooltipBase() {
    return {
      confine: true,
      transitionDuration: reduceMotion() ? 0 : 0.12,
      backgroundColor: cssVar('--panel-hi') || '#2c2f36',
      borderColor: cssVar('--line') || '#32363e',
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: cssVar('--text') || '#e3e5e9', fontSize: 12, fontFamily: FONT_NUM },
      extraCssText: 'border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.28);',
    };
  }

  function animOpt() {
    const reduce = reduceMotion();
    return {
      animation: !reduce,
      animationDuration: reduce ? 0 : 320,
      animationEasing: 'cubicOut',
      animationDurationUpdate: reduce ? 0 : 190,
      animationEasingUpdate: 'cubicOut',
    };
  }

  // ---------- 折线图 ----------
  // series = [{ values, color, label }]；values 右对齐进 window 个槽位，
  // 新点从右侧进入。dashFrom ≥ 0 时从该下标起尾段转虚线（暂停态，§2.8）。

  function line(el, opt) {
    const entry = acquire(el);
    if (!entry) return;
    const slots = Math.max(2, opt.window || 60);
    const series = opt.series || [];
    const empty = opt.axesOnly || !series.length || !series.some((s) => s.values.length);

    let dataMax = 0;
    for (const s of series) for (const v of s.values) if (v > dataMax) dataMax = v;
    // 量程加 6% 余量再取整：峰值正好落在 nice 刻度上时（6.0M 配 6.0M 上限），
    // 曲线会整段贴着绘图区顶边走，看着像被裁掉。留一档呼吸空间。
    // 没有采样（含 offline 的 axesOnly）时退回待机量程，见 IDLE_RATE。
    const yMax = niceMax(opt.yMax || (dataMax > 0 ? dataMax * 1.06 : IDLE_RATE));
    const fmtY = opt.formatY || axisRate;

    if (empty) {
      setShape(entry, 'L|empty', {
        animation: false,
        grid: gridFor(opt, yGutter(yMax, fmtY)),
        tooltip: { show: false },
        xAxis: emptyXAxis(slots, opt.xLabels),
        yAxis: yAxisOpt(yMax, fmtY),
        series: [],
      });
      return;
    }

    const dash = typeof opt.dashFrom === 'number' && opt.dashFrom >= 0;
    const tipSuffix = opt.tipSuffix || '';
    const names = [];
    const seriesOpt = [];
    for (const s of series) {
      const pad = slots - s.values.length;
      // 悬浮卡按 name 聚合去重：实线段和虚线段是两个 series，共用同一个名字
      if (!names.includes(s.label || '')) names.push(s.label || '');
      const base = {
        name: s.label || '',
        type: 'line',
        smooth: 0.4,
        symbol: 'circle',
        showSymbol: false,
        lineStyle: { width: 2, color: s.color },
        itemStyle: { color: s.color },
        areaStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: rgba(s.color, 0.14) },
              { offset: 1, color: rgba(s.color, 0) },
            ],
          },
        },
        connectNulls: false,
        emphasis: { scale: 2 },
      };
      if (!dash) {
        seriesOpt.push({ ...base, data: padData(s.values, pad, slots) });
      } else {
        // 实线段 0..dashFrom、虚线段 dashFrom..末尾，两个 series 拼一条曲线。
        // 虚线段 z 高一档、不带面积填充，接缝处虚线压在实线上面。
        const df = opt.dashFrom;
        seriesOpt.push({
          ...base, z: 3,
          data: splitData(s.values, pad, slots, df, false),
        });
        seriesOpt.push({
          ...base, z: 4, areaStyle: undefined,
          lineStyle: { width: 2, color: s.color, type: [4, 3], opacity: 0.9 },
          data: splitData(s.values, pad, slots, df, true),
        });
      }
    }

    setShape(entry, `L|${seriesOpt.length}|${dash}|${slots}`, {
      ...animOpt(),
      grid: gridFor(opt, yGutter(yMax, fmtY)),
      tooltip: {
        ...tooltipBase(),
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: cssVar('--line') || '#32363e', width: 1 } },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const idx = params[0].dataIndex;
          const left = slots - 1 - idx;
          const rows = [];
          const seen = new Set();
          for (const p of params) {
            // trigger:'axis' 时 p.name 是类目值（这里多为空串），系列名在 p.seriesName
            if (p.value == null || seen.has(p.seriesName) || !names.includes(p.seriesName)) continue;
            seen.add(p.seriesName);
            rows.push(`<div>${p.marker}${esc(p.seriesName)}&nbsp;&nbsp;<b>${fmtFull(p.value, tipSuffix)}</b></div>`);
          }
          return `<div style="color:${esc(cssVar('--text-2') || '#9ba1a9')};margin-bottom:2px">${left > 0 ? esc(`${left} 秒前`) : '现在'}</div>${rows.join('')}`;
        },
      },
      xAxis: lineXAxis(slots, opt.xLabels),
      yAxis: yAxisOpt(yMax, fmtY),
      series: seriesOpt,
    });
    entry.played = true;
  }

  function padData(values, pad, slots) {
    const out = new Array(slots).fill(null);
    for (let i = 0; i < values.length; i++) out[pad + i] = values[i];
    return out;
  }

  function splitData(values, pad, slots, df, dashedHalf) {
    const out = new Array(slots).fill(null);
    for (let i = 0; i < values.length; i++) {
      // 边界点 df 同时落进实线(i<=df)和虚线(i>=df)两个 series：两段共享这个点，
      // 虚线段的头才压得住实线段的尾，消除接缝处 connectNulls:false 造成的 1px 断裂。
      const keep = dashedHalf ? i >= df : i <= df;
      if (keep) out[pad + i] = values[i];
    }
    return out;
  }

  function lineXAxis(slots, xLabels) {
    const labels = new Array(slots).fill('');
    if (xLabels && xLabels.length) {
      labels[0] = xLabels[0];
      labels[slots - 1] = xLabels[xLabels.length - 1];
    }
    return {
      type: 'category',
      boundaryGap: false,
      data: labels,
      // 与网格线同一档：折线脚底那根基线要能看见，曲线落底时才读得出是 0。
      axisLine: { lineStyle: { color: cssVar('--line') || '#32363e' } },
      axisTick: { show: false },
      axisLabel: { ...axisLabelOpt(), interval: (i) => i === 0 || i === slots - 1 },
    };
  }

  function emptyXAxis(slots, xLabels) {
    const axis = lineXAxis(slots, xLabels);
    return { ...axis, data: xLabels && xLabels.length ? xLabels.slice(0, 2) : [''] };
  }

  // ---------- 柱状图 ----------
  // groups = [{ label, values: [down] 或 [down, up] }]。检查栏 30 天图只画下载
  // （296px 宽挤不开双色分组柱）；历史屏画双色分组。selectedIndex 那组保持全色、
  // 其余组降透明 —— 选中这件事靠对比度表达，190ms 的平滑过渡比顶帽瞬变更清楚。

  function bars(el, opt) {
    const entry = acquire(el);
    if (!entry) return null;
    const groups = opt.groups || [];
    const colors = opt.colors || [cssVar('--down') || '#f0963f', cssVar('--up') || '#62a9e8'];
    const empty = !groups.length;

    let dataMax = 0;
    for (const g of groups) for (const v of g.values) if (v > dataMax) dataMax = v;
    const yMax = niceMax(dataMax > 0 ? dataMax * 1.06 : IDLE_BYTES);
    const fmtY = opt.formatY || axisBytes;

    if (empty) {
      setShape(entry, 'B|empty', {
        animation: false,
        grid: gridFor(opt, yGutter(yMax, fmtY)),
        tooltip: { show: false },
        xAxis: { ...lineXAxis(2, opt.xLabels), boundaryGap: true },
        yAxis: yAxisOpt(yMax, fmtY),
        series: [],
      });
      return null;
    }

    const seriesCount = Math.max(1, groups[0].values.length);
    const sel = typeof opt.selectedIndex === 'number' ? opt.selectedIndex : -1;
    const tickSet = new Set((opt.tickLabels || []).map((t) => t.index));
    const grid = gridFor(opt, yGutter(yMax, fmtY));

    const seriesOpt = [];
    for (let si = 0; si < seriesCount; si++) {
      seriesOpt.push({
        name: (opt.seriesNames || [])[si] || '数值',
        type: 'bar',
        barCategoryGap: '25%',
        barGap: '35%',
        itemStyle: { color: colors[si] || colors[0], borderRadius: [2, 2, 0, 0] },
        data: groups.map((g, gi) => ({
          value: g.values[si] || 0,
          itemStyle: sel >= 0 ? { opacity: gi === sel ? 1 : 0.45 } : undefined,
        })),
      });
    }

    const tipTitle = opt.tipTitle;
    setShape(entry, `B|${seriesCount}|${groups.length}|${sel >= 0}`, {
      ...animOpt(),
      // 入场只在首次：柱子随每根 4ms 递进长出（90 根封顶 320ms），
      // 之后切档位/选中只走 190ms 的更新过渡，不再重新逐根表演
      animationDelay: entry.played ? 0 : (idx) => Math.min(idx * 4, 320),
      grid,
      tooltip: {
        ...tooltipBase(),
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: rgba(cssVar('--text') || '#e3e5e9', 0.06) } },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const gi = params[0].dataIndex;
          const g = groups[gi];
          if (!g) return '';
          const title = String(tipTitle ? tipTitle(g, gi) : (g.label ?? ''));
          const rows = params.map((p) => (
            `<div>${p.marker}${esc(p.seriesName)}&nbsp;&nbsp;<b>${fmtFull(p.value, opt.tipSuffix || '')}</b></div>`
          ));
          return `<div style="color:${esc(cssVar('--text-2') || '#9ba1a9')};margin-bottom:2px">${esc(title)}</div>${rows.join('')}`;
        },
      },
      xAxis: {
        type: 'category',
        data: groups.map((g) => g.label),
        // 基线同样从 --line-soft 提到 --line：柱脚总得有一条落地线，
        // 否则柱子在岛底凭空截断，读不出「这就是 0」。
        axisLine: { lineStyle: { color: cssVar('--line') || '#32363e' } },
        axisTick: { show: false },
        // 两端标注 + 月初刻度（tickLabels），贴太近的让 hideOverlap 裁掉
        axisLabel: {
          ...axisLabelOpt(),
          interval: (i) => i === 0 || i === groups.length - 1 || tickSet.has(i),
          hideOverlap: true,
        },
      },
      yAxis: yAxisOpt(yMax, fmtY),
      series: seriesOpt,
    });
    entry.played = true;

    // 点柱选中的命中测试。按固定 GRID 几何反推，与旧手写版同一套契约：
    // 出绘图区返回 -1（点空白 = 取消选中）。
    return {
      indexAt(clientX) {
        const box = el.getBoundingClientRect();
        const x = clientX - box.left;
        const left = grid.left;
        const right = el.clientWidth - grid.right;
        if (x < left || x > right) return -1;
        const pitch = (right - left) / groups.length;
        return Math.max(0, Math.min(groups.length - 1, Math.floor((x - left) / pitch)));
      },
    };
  }

  // 悬浮卡里的进程名 / 日期来自外部数据，进 HTML 前过一道转义
  function esc(s) {
    return window.NetPeekCommon ? window.NetPeekCommon.escapeHtml(s) : String(s);
  }

  window.NetPeekCharts = { line, bars, rgba, cssVar, axisBytes, axisRate };
})();
