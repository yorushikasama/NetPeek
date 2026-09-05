// NetPeek 图表渲染（canvas）。规格见 docs/UI生成提示词.md §2.4 / §2.5 / §3.6：
// y 轴三档标注（0 / 中位 / 上限）靠左占 52px，x 轴只标两端，横向虚线网格 2 条、不画纵向网格，
// 线宽 2、无数据点圆点、线下方同色 12% 渐变到透明。
//
// 不用 uPlot：它自带图例、游标和一整套坐标轴渲染，要压成上面这套规格得逐项覆盖，
// 比直接画省不下事。这里一次数据更新画一帧，不跑 rAF 循环 —— 数据每秒一帧，
// 常驻的补间动画在 §3.7 里是明确禁止项。

(function () {
  const AXIS_W = 52;   // y 轴标注区宽
  const PAD_R = 4;
  const PAD_T = 6;
  const XLAB_H = 16;   // x 轴标注行高
  const FONT_NUM = '11px "Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, monospace';

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // 把 #rrggbb 转 rgba()，用于曲线下的渐变填充与网格线。
  function rgba(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  // 按设备像素比重设画布尺寸，返回逻辑宽高与已缩放的 2D 上下文。
  function prepare(canvas) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w <= 0 || h <= 0) return null;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  // 上限取整到 1/2/5 × 10^n，避免「23.7 MB/s」这种读不出的刻度。
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const f = v / base;
    const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return step * base;
  }

  // 画坐标框：y 三档标注 + 2 条横向虚线网格 + x 两端标注。返回绘图区矩形。
  function drawFrame(ctx, w, h, yMax, opt) {
    const muted = cssVar('--text-muted') || '#b4a99e';
    const line = cssVar('--line') || 'rgba(255,255,255,0.10)';
    const left = AXIS_W;
    const right = w - PAD_R;
    const top = PAD_T;
    const bottom = h - XLAB_H;
    const plotH = Math.max(1, bottom - top);

    ctx.font = FONT_NUM;
    ctx.fillStyle = muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    // 量程塌到 1 时，三档会被 formatY 全格成同一个字符串（「1 / 1 / 0」这种读不出的轴）。
    // 这时只标上限和 0，中位那一档连线也不画。
    const midLabel = opt.formatY(yMax / 2);
    const dupMid = midLabel === opt.formatY(yMax) || midLabel === opt.formatY(0);
    const levels = dupMid ? [yMax, 0] : [yMax, yMax / 2, 0];
    ctx.save();
    ctx.strokeStyle = line;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    for (let i = 0; i < levels.length; i++) {
      const y = Math.round(bottom - (levels[i] / yMax) * plotH) + 0.5;
      ctx.fillText(opt.formatY(levels[i]), AXIS_W - 8, y);
      if (levels[i] !== 0) {
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
      }
    }
    ctx.restore();

    if (opt.xLabels && opt.xLabels.length) {
      const y = h - XLAB_H / 2 + 1;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(opt.xLabels[0], left, y);
      if (opt.xLabels.length > 1) {
        ctx.textAlign = 'right';
        ctx.fillText(opt.xLabels[opt.xLabels.length - 1], right, y);
      }
    }

    return { left, right, top, bottom, plotH, plotW: Math.max(1, right - left) };
  }

  // 双线图。series = [{ values, color }]；values 右对齐进 window 个槽位，
  // 新点从右侧进入。dashFrom 让尾段转虚线（暂停态，§2.8）。
  function line(canvas, opt) {
    const p = prepare(canvas);
    if (!p) return;
    const { ctx, w, h } = p;
    const series = opt.series || [];
    const slots = Math.max(2, opt.window || 60);

    let dataMax = 0;
    for (const s of series) {
      for (const v of s.values) if (v > dataMax) dataMax = v;
    }
    const yMax = niceMax(opt.yMax || dataMax || 1);
    const r = drawFrame(ctx, w, h, yMax, opt);
    if (opt.axesOnly) return;

    const step = r.plotW / (slots - 1);
    // 非零值不许压在绘图区底边上。上传常比下载小一到两个数量级（1.3M/s 对 10M/s 的量程），
    // 按比例算出来的 y 会和底边差不到 1px，整条上传线就读成了坐标框的一部分。
    // 抬起 2px 只影响「有流量但很小」这一档的可读性，真正的 0 仍然压在底边。
    const LIFT = 2;
    const yFor = (v) => {
      const y = r.bottom - Math.min(1, Math.max(0, v / yMax)) * r.plotH;
      return v > 0 ? Math.min(y, r.bottom - LIFT) : y;
    };

    for (const s of series) {
      const n = s.values.length;
      if (n === 0) continue;
      const xFor = (i) => r.right - (n - 1 - i) * step;

      // 线下方渐变填充：同色 12% 到透明
      const grad = ctx.createLinearGradient(0, r.top, 0, r.bottom);
      grad.addColorStop(0, rgba(s.color, 0.12));
      grad.addColorStop(1, rgba(s.color, 0));
      ctx.beginPath();
      ctx.moveTo(Math.max(r.left, xFor(0)), r.bottom);
      for (let i = 0; i < n; i++) ctx.lineTo(Math.max(r.left, xFor(i)), yFor(s.values[i]));
      ctx.lineTo(r.right, r.bottom);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.save();
      ctx.beginPath();
      ctx.rect(r.left, r.top - PAD_T, r.plotW + PAD_R, r.plotH + PAD_T + 1);
      ctx.clip();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = opt.lineWidth || 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      // dashFrom < 0 表示没有暂停，整条实线。不加这个下限，-1 会让
      // 实线段直接返回、虚线段从 -1 画到末尾 —— 整条曲线都成了虚线。
      const dashFrom = typeof opt.dashFrom === 'number' && opt.dashFrom >= 0 ? opt.dashFrom : n;
      // 实线段与虚线段分两次描边，避免一条 path 里切 dash
      strokeSegment(ctx, s.values, xFor, yFor, 0, Math.min(dashFrom, n - 1), null);
      if (dashFrom < n - 1) {
        strokeSegment(ctx, s.values, xFor, yFor, dashFrom, n - 1, [4, 3]);
      }
      ctx.restore();
    }
  }

  function strokeSegment(ctx, values, xFor, yFor, from, to, dash) {
    if (to <= from) return;
    ctx.save();
    ctx.setLineDash(dash || []);
    ctx.beginPath();
    ctx.moveTo(xFor(from), yFor(values[from]));
    for (let i = from + 1; i <= to; i++) ctx.lineTo(xFor(i), yFor(values[i]));
    ctx.stroke();
    ctx.restore();
  }

  // 柱状图。groups = [{ label, values: [down] 或 [down, up] }]。
  // 检查栏 30 天图只画下载（296px 宽挤不开双色分组柱）；历史屏把上传拆成
  // 独立量程的窄条图 —— 双序列共享量程时 15:1 的量级差会把上传压成贴地条。
  // selectedIndex 那一组加 2px 顶帽、其余组降到 45%（过滤范围直接读在图上）。
  // 悬浮：组高亮带 + 数值浮层（需要 opt.tipFormat，值由调用方格式化）。
  // 监听器按 canvas 只绑一次，重复调用只更新 opt；hover 变化整帧重画
  // （几十根柱的矢量重画远低于 1Hz 的刷新预算）。
  function bars(canvas, opt) {
    const state = canvas.__npBars || (canvas.__npBars = { hoverIdx: -1, bound: false });
    state.opt = opt;
    if (!state.bound) {
      state.bound = true;
      canvas.addEventListener('mousemove', (e) => {
        const st = canvas.__npBars;
        const idx = st.rects ? barIndexAt(st.rects, canvas, e.clientX) : -1;
        canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
        if (idx !== st.hoverIdx) { st.hoverIdx = idx; drawBars(canvas); }
      });
      canvas.addEventListener('mouseleave', () => {
        const st = canvas.__npBars;
        canvas.style.cursor = 'default';
        if (st.hoverIdx !== -1) { st.hoverIdx = -1; drawBars(canvas); }
      });
    }
    return drawBars(canvas);
  }

  function barIndexAt(rects, canvas, clientX) {
    const box = canvas.getBoundingClientRect();
    const x = clientX - box.left;
    for (const rect of rects) if (x >= rect.x0 && x < rect.x1) return rect.index;
    return -1;
  }

  function drawBars(canvas) {
    const state = canvas.__npBars;
    const opt = state.opt || {};
    const hoverIdx = state.hoverIdx;
    state.rects = null;
    const p = prepare(canvas);
    if (!p) return null;
    const { ctx, w, h } = p;
    const groups = opt.groups || [];
    const colors = opt.colors || [cssVar('--down') || '#f0913f', cssVar('--up') || '#7fa8c9'];

    let dataMax = 0;
    for (const g of groups) {
      for (const v of g.values) if (v > dataMax) dataMax = v;
    }
    const yMax = niceMax(dataMax || 1);
    const r = drawFrame(ctx, w, h, yMax, opt);
    // 零数据空态：库里还没有任何落库流量时，画一个「1 / 0」刻度的空坐标框
    // 读起来像渲染出错。emptyText 由调用方决定措辞（检查栏与历史屏不同）。
    if (opt.emptyText && !dataMax) {
      ctx.font = '12px "Segoe UI Variable Text", "Segoe UI", system-ui, "Microsoft YaHei", sans-serif';
      ctx.fillStyle = cssVar('--text-muted') || '#b4a99e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(opt.emptyText, (r.left + r.right) / 2, (r.top + r.bottom) / 2);
      return null;
    }
    if (!groups.length) return null;

    const seriesCount = Math.max(1, groups[0].values.length);
    const innerGap = seriesCount > 1 ? 3 : 0;
    // 组距由可用宽度均分，柱宽由组距反推，保证 30 组和 13 组都排得开
    const pitch = r.plotW / groups.length;
    const groupGap = Math.min(6, Math.max(2, pitch * 0.22));
    const groupW = Math.max(2, pitch - groupGap);
    const barW = Math.max(1.5, (groupW - innerGap * (seriesCount - 1)) / seriesCount);

    // 选中过滤态：未选中的组整体降到 45%，被选中的组保持全亮
    const alphaFor = (gi) =>
      (opt.selectedIndex >= 0 && gi !== opt.selectedIndex ? 0.45 : 1);

    // 悬浮高亮带：给「这一列是哪一组」一个载体，也提升窄柱的命中感
    if (hoverIdx >= 0 && hoverIdx < groups.length) {
      ctx.fillStyle = rgba(cssVar('--surface-hi') || '#2f2924', 0.55);
      ctx.fillRect(r.left + hoverIdx * pitch, r.top, pitch, r.plotH);
    }

    const rects = [];
    for (let gi = 0; gi < groups.length; gi++) {
      const gx = r.left + gi * pitch + groupGap / 2;
      rects.push({ x0: r.left + gi * pitch, x1: r.left + (gi + 1) * pitch, index: gi });
      ctx.globalAlpha = alphaFor(gi);
      for (let si = 0; si < seriesCount; si++) {
        const v = groups[gi].values[si] || 0;
        const bh = Math.max(v > 0 ? 1 : 0, (Math.min(v, yMax) / yMax) * r.plotH);
        const x = gx + si * (barW + innerGap);
        ctx.fillStyle = colors[si] || colors[0];
        ctx.fillRect(x, r.bottom - bh, barW, bh);
      }
      ctx.globalAlpha = 1;
      if (opt.selectedIndex === gi) {
        ctx.fillStyle = cssVar('--down') || '#f0913f';
        ctx.fillRect(gx, r.top - 2, groupW, 2);
      }
    }

    // 月初那一根另标日期（§2.6）。用实测文字宽度避让两端标注，
    // 34px 的固定余量挡不住「9 月 1 日」这种 5 字标签，会和右端标注挤在一起。
    if (opt.tickLabels) {
      ctx.font = FONT_NUM;
      ctx.fillStyle = cssVar('--text-muted') || '#b4a99e';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const y = h - XLAB_H / 2 + 1;
      const endW = (s) => (s ? ctx.measureText(s).width : 0);
      const leftGuard = r.left + endW(opt.xLabels && opt.xLabels[0]) + 10;
      const rightGuard = r.right - endW(opt.xLabels && opt.xLabels[opt.xLabels.length - 1]) - 10;
      let lastRight = leftGuard;
      for (const t of opt.tickLabels) {
        const half = ctx.measureText(t.text).width / 2;
        const cx = r.left + (t.index + 0.5) * pitch;
        if (cx - half < lastRight || cx + half > rightGuard) continue;
        ctx.fillText(t.text, cx, y);
        lastRight = cx + half + 10;
      }
    }

    // 悬浮数值浮层：标签 + 各序列值（值经 opt.tipFormat 格式化，行色随序列色）
    if (hoverIdx >= 0 && hoverIdx < groups.length && opt.tipFormat) {
      const g = groups[hoverIdx];
      const arrows = seriesCount > 1 ? ['▼ ', '▲ '] : [''];
      ctx.font = FONT_NUM;
      const rows = [];
      for (let si = 0; si < seriesCount; si++) {
        rows.push({
          color: colors[si] || colors[0],
          text: (arrows[si] || '') + opt.tipFormat(g.values[si] || 0),
        });
      }
      const valW = Math.max(...rows.map((row) => ctx.measureText(row.text).width));
      const uiFont = '11px "Segoe UI Variable Text", "Segoe UI", system-ui, "Microsoft YaHei", sans-serif';
      ctx.font = uiFont;
      const label = String(g.label);
      const boxW = Math.max(valW, ctx.measureText(label).width) + 20;
      const boxH = 30 + rows.length * 16;
      let bx = r.left + (hoverIdx + 0.5) * pitch - boxW / 2;
      bx = Math.max(r.left, Math.min(bx, r.right - boxW));
      const by = r.top + 4;
      ctx.fillStyle = rgba(cssVar('--surface') || '#1e1a16', 0.92);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 8); else ctx.rect(bx, by, boxW, boxH);
      ctx.fill();
      ctx.strokeStyle = cssVar('--line') || 'rgba(255,255,255,0.1)';
      ctx.stroke();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.font = uiFont;
      ctx.fillStyle = cssVar('--text-muted') || '#b4a99e';
      ctx.fillText(label, bx + 10, by + 15);
      ctx.font = FONT_NUM;
      for (let i = 0; i < rows.length; i++) {
        ctx.fillStyle = rows[i].color;
        ctx.fillText(rows[i].text, bx + 10, by + 31 + i * 16);
      }
    }

    state.rects = rects;
    return {
      indexAt: (clientX) => barIndexAt(rects, canvas, clientX),
    };
  }

  // 坐标标注专用的紧凑格式。52px 的 y 轴槽在 11px 等宽下只放得下约 6 个字符，
  // 直接复用界面里的「10.00 MB/s」会从左侧被裁掉前几位数字，读成「00 MB/s」。
  function axisNum(v, suffix) {
    if (!(v > 0)) return '0';
    const units = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'K']];
    for (const [scale, tag] of units) {
      if (v >= scale) {
        const n = v / scale;
        return `${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 0 : 1)}${tag}${suffix}`;
      }
    }
    return `${Math.round(v)}${suffix}`;
  }

  const axisBytes = (v) => axisNum(v, '');
  const axisRate = (v) => axisNum(v, '/s');

  window.NetPeekCharts = { line, bars, rgba, cssVar, axisBytes, axisRate, niceMax };
})();
