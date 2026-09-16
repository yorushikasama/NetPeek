// 历史屏（§2.6，功能清单屏 3）。这一屏不放折线图：历史要回答的是「哪天用得多」，
// 柱状图直接可比、可点；折线只是把同一份日聚合数据画得更含糊。
//
// 数据来自后端三档：
//   - 预设档（近 7/30/90 天）走 history_daily(days)；
//   - 自定义区间按天走 history_range_days(start, end)；
//   - 自定义区间按**小时**走 history_range(start, end, bucket=3600)。
// 前两条返回按「本地日期 × 应用」聚合的行，第三条返回按「本地整点 × 应用」聚合的行
// （后端那边本来就有，只是从来没人调用；自定义档过去只能靠天数近似，取回的数据
// 和所选窗口零重叠，柱图整片是空的 —— 所以它加过真正的起止边界）。
// 不拉分钟级原始行 —— 30 天 × 1440 分钟 × N 进程的 JSON 前端解析不动，
// 聚合在 SQL 里做完再过线。同一份数据同时喂三处：柱图、区间合计、应用排行。
//
// 粒度由区间长度自动定（planQuery）：≤ HOUR_MODE_MAX_HOURS 小时走小时柱，否则按天。
// 时刻框在按天档置灰 —— 悄悄忽略用户填的时刻，比当场置灰更糟。
//
// 槽位（slot）是全屏唯一的时间键：按天是 'YYYY-MM-DD'，按小时是 'YYYY-MM-DDTHH'。
// 骨架、过滤、合计、导出全走它。从前到处直接写 r.day，多一档粒度就要改十几处判断，
// 漏一处不会报错，只会静默错算。
//
// 检查栏的「30 天下载」窗口够用时复用，否则自己查一次 —— 它要的永远是最近 30 天，
// 和这一屏当前的档位不是一回事，见 dailyFor。

(function () {
  const $ = (id) => window.NetPeekCommon.byId(id, 'history-ui');
  const C = window.NetPeekCharts;
  // 排行条数上限。这里曾经是 8，且不是被空间逼出来的 —— .rank-list 本身
  // overflow-y:auto，snapRankHeight 还专门把高度取整到整行好让它干净地滚动，
  // 也就是说滚动能力早就建好了却用不上。那个 8 是旧布局（合计还在右栏里）
  // 留下的常量：布局把合计挪进工具栏后，右栏空间多出来一大截，上限没跟着放。
  // 用户的原话是「监控页面看到的不止这么点应用」—— 实时屏那边压根不设上限。
  // 现在给一个只防炸的量级：真实进程数远到不了，列表自己滚。
  const TOP_N = 200;
  // 默认档。onEnter 要定位到今天时会主动回到这一档（见那里的理由），
  // 写死两处数字迟早对不上，所以留一个常量，HTML 上那个 is-active 与它同值。
  const DEFAULT_DAYS = 30;
  const WEEK_AGG_THRESHOLD = 60; // 超过这个天数按周聚合：90 根 3px 宽的柱读不出也点不中
  // 自定义区间的长度上限。日期框里能敲出 1900 年，而 buildBuckets 会给区间里
  // 每一天都排一根柱 —— 没有上限的话，一次误输入就能让画布去画几万根柱。
  const MAX_RANGE_DAYS = 3660; // ≈10 年，按周聚合后约 523 组，画得动也读得出
  // 超过这个小时数就退回按天：72 根小时柱和 90 根日柱是同一量级的可读性，
  // 再长下去 x 轴就得靠 hideOverlap 大面积丢标签，读不出是哪一段。
  const HOUR_MODE_MAX_HOURS = 72;
  // 小时骨架的兜底上限。正常走不到（上面的门槛已经把区间卡在 73 格以内），
  // 它只防「区间两端的时刻被手敲坏」这类输入把画布喂爆。
  const MAX_RANGE_HOURS = 240;
  const HOUR_MS = 3_600_000;

  const els = {
    range: $('histRange'),
    aggNote: $('histAggNote'),
    exportBtn: $('histExport'),
    canvas: $('histChart'),
    customToggle: $('histCustomToggle'),
    customForm: $('histCustomRange'),
    startDate: $('histStartDate'),
    endDate: $('histEndDate'),
    startTime: $('histStartTime'),
    endTime: $('histEndTime'),
    // 时刻框外面那层。粒度不够时整体收起的是它，不是 input 自己 ——
    // input 隐藏了，「全天」占位那层还得跟着一起走。
    startTimeWrap: $('histStartTimeWrap'),
    endTimeWrap: $('histEndTimeWrap'),
    granNote: $('histGranNote'),
    customCancel: $('histCustomCancel'),
    rangeError: $('histRangeError'),
    rangeTitle: $('histRangeTitle'),
    rangeSub: $('histRangeSub'),
    sumDown: $('histSumDown'),
    sumUp: $('histSumUp'),
    sumAll: $('histSumAll'),
    rankTitle: $('histRankTitle'),
    rankCount: $('histRankCount'),
    rank: $('histRank'),
  };

  // 「其余应用」那一行要用的区间总量（当前排行作用域内的全量合计）。
  // renderSide 每次算排行时更新，renderRank 用它和已列出的部分做差。
  let rankTotals = { down: 0, up: 0 };

  let days = DEFAULT_DAYS;
  // 自定义区间：start/end 是 'YYYY-MM-DD'，startTime/endTime 是 'HH:MM'。
  // 时刻只在按小时档生效（planQuery 判），按天档一律当 00:00 / 23:59 看。
  let customRange = null;
  let unit = 'day';       // 'day' | 'hour'：当前生效的粒度，由 planQuery 定
  let hourWin = null;     // 按小时档的实际窗口 { startMs, endMs }（上界已夹到「现在」）
  let rows = [];          // [{ slot, name, down, up }]
  let windowDays = 0;     // rows 覆盖的「最近 N 天」天数；自定义区间时为 0
  let inspectorRows = null; // 检查栏 30 天曲线的独立缓存，理由见 dailyFor
  let inspectorSpan = 0;
  let buckets = [];       // 图上每一组：{ key, label, full, slots: [slot], down, up }
  let selected = -1;      // 选中的柱索引，-1 = 看整个区间
  let hit = null;         // charts.bars 返回的命中测试
  let loaded = false;
  let loading = false;    // loadRows 进行中，柱图降透明 + 排行空态显示读取中
  let firstDay = null;    // 历史库最早有数据的本地日期（YYYY-MM-DD），打开浮层时从 history_stats 取
  // 「从实时屏的今日卡点进来」要定位的那一天。它必须活过一次 loadRows：
  // 选中态是在数据回来、骨架建好之后才能定的，先进来的请求先把它记下来。
  let pendingFocusDay = null;

  // 图标向主界面借：历史库只存名字，不存图标。
  //
  // 先查 main.js 的会话级「名称 -> 图标」记忆，查不到再退回扫最近一帧快照。
  // 只扫当前帧是不够的：历史屏列的是过去 7/30/90 天用过网的应用，其中相当一部分
  // 此刻已经退出了，而排行恰恰按流量降序 —— 昨天下载最多的那个装机程序排在第一行
  // 却只有一个首字母徽标。记忆表在 onSnapshot 里只增不减，本次会话见过一次就够。
  function iconFor(name) {
    const live = window.NetPeekLive;
    if (!live) return '';
    if (live.iconForName) {
      const remembered = live.iconForName(name);
      if (remembered) return remembered;
    }
    // 兜底扫当前帧：记忆表是本次会话攒的，刚启动时几乎是空的，
    // 而这一帧里的进程可能已经带上了图标（IconUpdates 先到、记忆后填）。
    const snap = live.lastSnapshot && live.lastSnapshot();
    if (!snap) return '';
    const key = String(name).toLowerCase();
    for (const p of snap.Processes || []) {
      if ((p.Name || '').toLowerCase() === key) {
        const icon = live.iconOf(p);
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

  // ---------- 槽位 ----------
  // 时间键只有这两种形状。按小时时用 'YYYY-MM-DDTHH'：T 分隔符是 ISO 的老规矩，
  // 而且它让「同一天的小时槽」在前缀上就聚在一起，排序和 startsWith 切片都省事。

  function hourKey(d) {
    return `${dayKey(d)}T${String(d.getHours()).padStart(2, '0')}`;
  }

  function isHourSlot(slot) {
    return typeof slot === 'string' && slot.length === 13;
  }

  /** 把毫秒时间戳夹到它所在的本地整点。 */
  function floorHour(ms) {
    const d = new Date(ms);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }

  // 按小时档的骨架：从起点所在整点到「最后一个有数据的整点」。
  // 结束时刻正好压在整点上时要退一格 —— 「08:00 ~ 12:00」是 08/09/10/11 四根柱，
  // 不是五根：最后一根覆盖 [12:00, 12:00) 恒为空，画出来像掉数据。
  function hourKeysBetween(startMs, endMs) {
    const out = [];
    let last = floorHour(endMs);
    const e = new Date(endMs);
    if (e.getMinutes() === 0 && e.getSeconds() === 0 && e.getMilliseconds() === 0) last -= HOUR_MS;
    const d = new Date(floorHour(startMs));
    while (d.getTime() <= last && out.length < MAX_RANGE_HOURS) {
      out.push(hourKey(d));
      d.setHours(d.getHours() + 1);
    }
    return out;
  }

  /** 槽位所属的本地日期（两种槽位都取前 10 个字符）。 */
  function dayOfSlot(slot) {
    return String(slot).slice(0, 10);
  }

  // 自定义区间两端的本地时刻。用带时间的字面量构造 —— 裸的 'YYYY-MM-DD'
  // 会被 Date 当成 UTC 解析，同样会错一格。时刻缺失时补成整日边界。
  function rangeBounds(r) {
    const a = new Date(`${r.start}T${r.startTime || '00:00'}:00`);
    const b = new Date(`${r.end}T${r.endTime || '23:59'}:00`);
    return { a, b };
  }

  /**
   * 当前区间该用哪种粒度、查哪一段。这是「档位」唯一的判定处：
   * loadRows 用它发查询，骨架/标题/导出也都读它落下来的 unit 与 hourWin。
   *
   * 上界夹到「现在」：库里按分钟落盘，未来时段必然为空，画出来是一排空柱，
   * 读起来像掉数据。夹完仍按整点骨架排，最后一根就是当前这一小时。
   */
  function planQuery(range) {
    if (!range) return { unit: 'day', startMs: 0, endMs: 0 };
    const { a, b } = rangeBounds(range);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return { unit: 'day', startMs: 0, endMs: 0 };
    const endMs = Math.min(b.getTime(), Date.now());
    const startMs = a.getTime();
    const hours = (endMs - startMs) / HOUR_MS;
    if (hours <= 0 || hours > HOUR_MODE_MAX_HOURS) return { unit: 'day', startMs: 0, endMs: 0 };
    return { unit: 'hour', startMs, endMs };
  }

  // 区间在界面上的说法（卡头标题、CSV 文件名）。两种粒度写法不同不是洁癖：
  // 整日档把 00:00 ~ 23:59 写出来是「全天」的同义反复，纯噪音；
  // 小时档则非写不可 —— 否则「8 月 18 日 ~ 8 月 18 日」读起来像一个空区间。
  function rangeText(r, gran) {
    if (gran === 'hour') {
      return `${labelOf(r.start)} ${r.startTime || '00:00'} ~ ${labelOf(r.end)} ${r.endTime || '23:59'}`;
    }
    return r.start === r.end ? labelOf(r.start) : `${labelOf(r.start)} ~ ${labelOf(r.end)}`;
  }

  // 一天 / 一小时的短文案（轴标签、刻度用），以及带上月份的完整文案
  // （悬浮卡、侧栏标题用）。两种粒度共用一个形状，调用方不必各自判断。
  function slotLabel(slot) {
    if (!isHourSlot(slot)) return labelOf(slot);
    return `${String(Number(slot.slice(11, 13))).padStart(2, '0')}:00`;
  }

  function slotFullLabel(slot) {
    if (!isHourSlot(slot)) return labelOf(slot);
    return `${labelOf(dayOfSlot(slot))} ${slotLabel(slot)}`;
  }

  function labelOf(dayStr) {
    const [, m, d] = dayStr.split('-');
    return `${Number(m)} 月 ${Number(d)} 日`;
  }

  function weekdayOf(dayStr) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(`${dayStr}T00:00:00`).getDay()] || '';
  }

  // 按天 / 按小时 / 按周分组。按周时组标签用组内第一天。
  //
  // 周分组只出现在按天档（骨架长于 WEEK_AGG_THRESHOLD 时）—— 按小时档最多 73 格，
  // 再聚一次就是「每 168 小时一根」，读不出任何东西。
  //
  // 周分组对齐自然周（周一起）。老实现从区间起点每 7 天切一刀，于是悬浮卡写着
  // 「9 月 3 日 当周」而实际是「从 9 月 3 日起数 7 天」—— 用户读到「当周」
  // 会理解成日历周。第一组和最后一组因此可能不足 7 天，slots 数组照实给，
  // tipTitle 与侧栏标题都按 slots.length 说话，不会把半周说成整周。
  // 后端 history_range 的周桶本来就接受前端传入 anchor 来对齐本地周一，
  // 说明「对齐自然周」这个口径在项目里已经定了，这一屏只是没跟上。
  function buildBuckets() {
    const keys = activeSlotKeys();
    const perSlot = new Map();
    for (const k of keys) perSlot.set(k, { down: 0, up: 0 });
    for (const r of rows) {
      const slot = perSlot.get(r.slot);
      if (slot) { slot.down += r.down; slot.up += r.up; }
    }

    if (unit === 'hour') {
      els.aggNote.hidden = true;
      return keys.map((k) => ({
        key: k, label: slotLabel(k), full: slotFullLabel(k), slots: [k],
        down: perSlot.get(k).down, up: perSlot.get(k).up,
      }));
    }

    const weekly = keys.length > WEEK_AGG_THRESHOLD;
    els.aggNote.hidden = !weekly;
    if (!weekly) {
      return keys.map((k) => ({
        key: k, label: labelOf(k), full: labelOf(k), slots: [k],
        down: perSlot.get(k).down, up: perSlot.get(k).up,
      }));
    }
    // 按「所属自然周的周一」归组：同一周的日期落进同一个桶，与切片位置无关。
    const groups = new Map();
    for (const k of keys) {
      const monday = mondayOf(k);
      let g = groups.get(monday);
      if (!g) { g = { key: monday, slots: [], down: 0, up: 0 }; groups.set(monday, g); }
      g.slots.push(k);
      g.down += perSlot.get(k).down;
      g.up += perSlot.get(k).up;
    }
    // 标签用**组内第一天**而不是周一：区间起点通常落在某周中间，那一组的周一
    // 在区间之外，拿它当标签会显示一个用户没选的日期（近 90 天档几乎必然如此）。
    // key 仍是周一 —— 它是分组身份，tickLabels 按它判月份归属。
    // Map 按插入序，而 keys 本身升序，所以组也是升序 —— 不必再排一次。
    return Array.from(groups.values(), (g) => {
      const label = labelOf(g.slots[0]);
      return { ...g, label, full: label };
    });
  }

  // 某个本地日期所属自然周的周一（YYYY-MM-DD）。getDay() 里周日是 0，
  // 换成「距周一几天」要把 0 当 7 处理，否则周日会被归到下一周。
  function mondayOf(dayStr) {
    const d = new Date(`${dayStr}T00:00:00`);
    const shift = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - shift);
    return dayKey(d);
  }

  // x 轴只标两端和稀疏刻度（§2.6）。
  //
  // 按天：标「每个月的第一根柱」。不能只认 key 的日号是否为 01：周聚合后组键是周一，
  // 极少正好落在月初，于是 90 天档（必定走周聚合，见 WEEK_AGG_THRESHOLD）通常只剩
  // 首末两个标签，中间一片没有时间基准 —— 恰好是最需要刻度的那一档。
  // 改成按月份变化取第一根：日聚合下与老行为等价（1 号那天就是当月第一根），
  // 周聚合下每个月给一根，标签仍然稀疏但读得出走到哪个月了。
  //
  // 按小时：每 6 小时一根，跨天处改写成日期。「每 6 小时」不是随手取的 —— 72 格
  // 下正好 12 根，密度与按天档同一个量级；再密就得靠 hideOverlap 丢标签，
  // 丢到哪几根不可控，反而读不出节奏。
  function tickLabels() {
    const ticks = [];
    if (unit === 'hour') {
      for (let i = 1; i < buckets.length; i++) {
        const slot = buckets[i].slots[0];
        const h = Number(slot.slice(11, 13));
        if (h % 6 !== 0) continue;
        ticks.push({ index: i, text: h === 0 ? labelOf(dayOfSlot(slot)) : `${slotLabel(slot)}` });
      }
      return ticks;
    }
    let lastMonth = '';
    for (let i = 0; i < buckets.length; i++) {
      // 按组内第一天判月份、也用它做文案：周聚合时 key 是周一，可能落在上个月，
      // 拿它标注会给出一个区间里根本没有的日期。
      const first = buckets[i].slots[0];
      const ym = first.slice(0, 7);
      if (ym !== lastMonth) {
        lastMonth = ym;
        // 第一根柱已经由 xLabels 标了，重复标一次只会和它叠字
        if (i > 0) ticks.push({ index: i, text: labelOf(first) });
      }
    }
    return ticks;
  }

  function drawChart() {
    if (!buckets.length) return;
    hit = C.bars(els.canvas, {
      // slots 跟着 group 走：tipTitle 要用它区分「单格」和「周聚合」。
      // 这里曾经是悬浮读数的一个静默炸弹 —— tipTitle 读 b.slots，而 group
      // 只有 {label, values}，TypeError 发生在 mousemove 处理器里，
      // 悬浮小卡从来弹不出来，界面上却没有任何报错痕迹。
      groups: buckets.map((b) => ({ label: b.label, values: [b.down, b.up], slots: b.slots, full: b.full })),
      formatY: C.axisBytes,
      xLabels: [buckets[0].label, buckets[buckets.length - 1].label],
      tickLabels: tickLabels(),
      selectedIndex: selected,
      // 悬停小卡：两个系列的名称。周聚合的标题必须说清是一组天数而不是某一天，
      // 否则一周的合计会被读成单日用量（差 7 倍）。组已对齐自然周，但首尾两组
      // 可能不足 7 天，所以标题按 slots 的实际长度说话，不写死「当周」。
      // 按小时档每格恒为一小时，full 自己就说明了是哪一小时这天的几点。
      seriesNames: ['下载', '上传'],
      tipTitle: (b) => (b.slots.length > 1 ? `${b.full}（${b.slots.length} 天合计）` : b.full),
    });
  }

  function renderSide() {
    const scope = selected >= 0 ? [buckets[selected]] : buckets;
    const slotFilter = selected >= 0 ? new Set(buckets[selected].slots) : null;

    let down = 0;
    let up = 0;
    for (const b of scope) { down += b.down; up += b.up; }
    setTotal(els.sumDown, down);
    setTotal(els.sumUp, up);
    setTotal(els.sumAll, down + up);
    // 「其余 N 个应用」那一行要拿它做差。用柱图的合计而不是再遍历一次 pool：
    // 顶部三个数就是从 buckets 来的，同源才能保证「列出的 + 其余 = 顶部合计」对得上。
    rankTotals = { down, up };

    if (selected >= 0) {
      const b = buckets[selected];
      const many = b.slots.length > 1;
      // 标题带上实际天数：首尾两组可能被区间边界截短，说「一周」会多算。
      // 单格时补星期几 —— 单看「9 月 16 日」推不出是工作日还是周末。
      const day = dayOfSlot(b.slots[0]);
      els.rangeTitle.textContent = many
        ? `${b.full} · ${b.slots.length} 天`
        : `${b.full} · ${weekdayOf(day)}`;
      els.rangeSub.textContent = '点柱状图空白处取消选中';
      // 单位跟着粒度走 —— 写死「当日」在按小时档会把一小时说成一天。
      els.rankTitle.textContent = many ? '这几天的应用排行' : (unit === 'hour' ? '这一小时的应用排行' : '当日应用排行');
    } else if (customRange) {
      // 自定义区间不能再说「近 N 天」：区间可能整段在过去，而且它不是从今天倒数的。
      els.rangeTitle.textContent = rangeText(customRange, unit);
      // 格数按 slots 求和，不按 buckets.length：按天档走过周聚合时一组是多天，
      // 数组长度会把 90 天说成 13 天。
      const slotCount = buckets.reduce((n, b) => n + b.slots.length, 0);
      els.rangeSub.textContent = unit === 'hour'
        ? `共 ${slotCount} 小时 · 点某一小时可只看那一小时`
        : `共 ${slotCount} 天 · 点某一天可只看那一天`;
      els.rankTitle.textContent = '应用排行';
    } else {
      els.rangeTitle.textContent = `近 ${days} 天`;
      els.rangeSub.textContent = '点柱状图上的某一天可只看那天';
      els.rankTitle.textContent = '应用排行';
    }

    // 应用排行：按「上传 + 下载」降序，行背景一条极淡的琥珀渐变表示占比（同 §2.5）。
    // 未选中柱时按整个当前区间过滤 —— 不能直接遍历 rows：history_daily 的截断点是
    // 「现在往前推 N 天」，跨天的那个窗口比 dayKeys(N) 多出小半天，排行会比柱图多算一截。
    //
    // 排序键从「只看下载」改成合计：这张卡有 TOP_N 截断（见文件头的 200），按下载排
    // 会把上传重、下载轻的应用（网盘同步、直播推流、做种、备份）**真的挤出榜外** ——
    // 不是排序喜好问题，是少了几行，而卡头那三个字「按下载」推断不出「有应用因此
    // 被隐掉了」。注意别把这句话套到实时屏上：实时屏不截断（`renderTable` 全量建行），
    // 那边按下载排只是让它沉到视口外，一行都不少。实时屏的默认顺序与整行占比条在
    // §49 也统一到了合计口径，理由是同一条（「占带宽」是双向的），不是同一个后果。
    //
    // 分组键归一到小写：库里同一个应用可能存过 Chrome.exe 和 chrome.exe 两种写法
    //（进程名来自采集端，大小写不保证稳定），不归一就会拆成两行各分走一半流量，
    // 于是两行都可能被挤出榜。实时屏的应用聚合视图（main.js viewMode==='app'）
    // 用的就是小写键，这里对齐它。未归因流量在库里是空串，一并在聚合前归一到
    // UNATTR 标签 —— 老实现靠渲染时 `app.name || unattrName()` 兜，
    // 那会让空串和真的叫这个名字的应用分到两行。
    const pool = selected >= 0 ? rows.filter((r) => slotFilter.has(r.slot)) : filteredRows();
    const byApp = new Map();
    for (const r of pool) {
      const label = r.name || unattrName();
      const key = String(label).toLowerCase();
      const cur = byApp.get(key) || { name: label, down: 0, up: 0 };
      cur.down += r.down;
      cur.up += r.up;
      byApp.set(key, cur);
    }
    const all = Array.from(byApp.values()).sort((a, b) => (b.down + b.up) - (a.down + a.up));
    const ranked = all.slice(0, TOP_N);
    // 占比条按合计取，与排序键同源；否则「最长的条」不是第一行，读起来像排错了。
    const peak = ranked.length ? ranked[0].down + ranked[0].up : 0;
    renderRank(ranked, peak, all.length);
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

  // total = 归组后的应用总数（可能多于 list.length）。截断必须说出来：
  // 顶部合计是按整个区间**所有**应用算的，把列出的这些行加起来永远凑不出那个数，
  // 而界面不解释差额从哪来时，最自然的解读是「数据错了」。
  function renderRank(list, peak, total) {
    els.rankCount.textContent = total ? `${total} 个应用` : '';
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
      const share = peak > 0 ? Math.round(((app.down + app.up) / peak) * 100) : 0;
      row.style.setProperty('--share', `${share}%`);
      // 条色跟着主方向走（与实时屏同一条规矩，§49）：这张卡按合计排序、条也按合计画，
      // 只涂下载色会让「上传 8 GB / 下载 20 MB」那种应用看起来毫无分量 —— 它凭什么
      // 排在前面，靠的就是那条上传色的满格条。行重建时无条件写，不必比较。
      row.style.setProperty('--share-color', app.down >= app.up ? 'var(--down)' : 'var(--up)');
      const icon = iconFor(app.name);
      // 上传与下载分两列给：只显示下载时，一个上传 8 GB、下载 20 MB 的应用
      // 在榜上显示「20 MB」，看不出它凭什么排在前面。
      row.innerHTML = `
        ${icon
          ? `<img class="rank-icon" src="${icon}" alt="" />`
          : `<span class="rank-icon is-placeholder">${escapeHtml(initial(app.name))}</span>`}
        <span class="rank-name" title="${escapeHtml(app.name)}">${escapeHtml(app.name)}</span>
        <span class="rank-value is-down" title="下载 ${escapeHtml(fmt(app.down))}">${valueHtml(app.down)}</span>
        <span class="rank-value is-up" title="上传 ${escapeHtml(fmt(app.up))}">${valueHtml(app.up)}</span>`;
      frag.appendChild(row);
    }
    if (list.length < total) {
      // 余下应用的合计也给出来，让「列出的 + 其余 = 顶部合计」这笔账能对上。
      const restDown = restOf(list, 'down');
      const restUp = restOf(list, 'up');
      frag.appendChild(Object.assign(document.createElement('div'), {
        className: 'hint-row is-rest',
        textContent: `其余 ${total - list.length} 个应用 · ↓ ${fmt(restDown)} ↑ ${fmt(restUp)}`,
      }));
    }
    els.rank.replaceChildren(frag);
    requestAnimationFrame(snapRankHeight);
  }

  // 「其余应用」那一行的合计：区间总量减去已列出的部分。直接用总量做差，
  // 不再遍历一遍 pool —— 两处各算一次迟早在某个过滤条件上漂移。
  function restOf(list, field) {
    const listed = list.reduce((s, a) => s + a[field], 0);
    return Math.max(0, rankTotals[field] - listed);
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

  // 当前生效的时间骨架（槽位串列表）。骨架、过滤、导出的**唯一**取键处：
  // 这里是 hourly / daily / weekly 三档分岔的地方，别处再算一遍必然漂移。
  function activeSlotKeys() {
    if (!customRange) return dayKeys(days);
    if (unit === 'hour' && hourWin) return hourKeysBetween(hourWin.startMs, hourWin.endMs);
    return dayKeysBetween(customRange.start, customRange.end);
  }

  function filteredRows() {
    const keys = new Set(activeSlotKeys());
    return rows.filter((row) => keys.has(row.slot));
  }

  // 查询代号。连点「近 7 天 → 近 90 天」时两次 invoke 并发，先发的可能后回；
  // 而 await 之后的 buildBuckets 读的是**当前**的 days/customRange，rows 却是
  // 过期那次的结果 —— 柱图会按 90 天排格子却填 7 天的数据，合计和排行一起错，
  // 且没有任何报错。只认最后一次发出的查询，过期结果整份丢掉。
  // （main.js 的 render30Day 早就有同一套守卫，这里是漏的那处。）
  let loadSeq = 0;

  async function loadRows() {
    const seq = ++loadSeq;
    // 加载态：柱图降透明，排行区如果还空着就把提示换成「读取中」。
    // 有旧数据时保留旧图不动 —— 换档期间闪一帧空图比沿用旧图更糟。
    loading = true;
    els.canvas.classList.add('is-loading');
    if (!els.rank.querySelector('.rank-row')) renderRank([], 0, 0);
    // 档位在发请求这一刻就固定下来，不留到 await 之后再读全局：
    // 结果回来时全局可能已经是下一次点击的档位了。
    const forRange = customRange;
    const forDays = days;
    const plan = planQuery(forRange);
    // 三条路的返回形状不同，进来先归一成同一种行：{ slot, name, down, up }。
    // 按小时的 ts 是**桶起点**（本地整点对齐，见 history.rs 的 query_range_buckets），
    // 转成本地时刻串就得到与骨架同源的键 —— 别拿 ts 直接拼字符串，
    // UTC+8 下会整体偏 8 小时、一根柱都填不上。
    let next;
    try {
      let raw;
      if (plan.unit === 'hour') {
        raw = await window.__TAURI__.core.invoke('history_range', {
          start: Math.floor(plan.startMs / 1000),
          end: Math.ceil(plan.endMs / 1000),
          bucket: 3600,
          anchor: 0,
        });
        next = JSON.parse(raw || '[]').map((row) => ({
          slot: hourKey(new Date(row.ts * 1000)), name: row.name, down: row.down, up: row.up,
        }));
      } else if (forRange) {
        // 自定义区间必须走 history_range_days：history_daily 只认「从今天往前数 N 天」，
        // 拿它查一个过去的区间只会取回与所选窗口零重叠的数据，柱图整片是空的。
        raw = await window.__TAURI__.core.invoke('history_range_days', {
          start: forRange.start,
          end: forRange.end,
        });
        next = JSON.parse(raw || '[]').map((row) => ({
          slot: row.day, name: row.name, down: row.down, up: row.up,
        }));
      } else {
        raw = await window.__TAURI__.core.invoke('history_daily', { days: forDays });
        next = JSON.parse(raw || '[]').map((row) => ({
          slot: row.day, name: row.name, down: row.down, up: row.up,
        }));
      }
      next = next.filter((row) => row && typeof row.slot === 'string');
    } catch {
      next = []; // 浏览器预览或库不可用：画空坐标轴，不报错弹窗
    }
    if (seq !== loadSeq) return; // 期间又换了档位，这份结果作废（loading 态交给后发的那次收）
    rows = next;
    windowDays = forRange ? 0 : forDays;
    unit = plan.unit;
    hourWin = plan.unit === 'hour' ? { startMs: plan.startMs, endMs: plan.endMs } : null;
    loading = false;
    els.canvas.classList.remove('is-loading');
    loaded = true;
    buckets = buildBuckets();
    selected = -1;
    // 从实时屏的今日卡点进来时定位到今天。放在骨架建好之后 —— 桶索引得先存在，
    // 而 buckets 是这次查询结果的函数，提前算出来的索引可能指向别的一天。
    // 作用域不含今天的情况（自定义区间整段在过去）由 onEnter 先兜掉了。
    if (pendingFocusDay) {
      const want = pendingFocusDay;
      pendingFocusDay = null;
      const idx = buckets.findIndex((b) => b.slots.includes(want));
      if (idx >= 0) selected = idx;
    }
    drawChart();
    renderSide();
  }

  // 导出跟随屏幕上当前看到的范围。选中某一天后原来仍导出整个区间：
  // 屏幕显示的是那一天的合计和排行，下载下来的却是 90 天，而文件名里也看不出来。
  function exportCsv() {
    const scopeKeys = selected >= 0 ? buckets[selected].slots : activeSlotKeys();
    const keySet = new Set(scopeKeys);
    const exportRows = rows.filter((r) => keySet.has(r.slot));
    // 表头跟着粒度走：按小时档第一列是「2026-09-16T08」，仍写「日期」会让人
    // 以为一天一行、把 24 行读成 24 天。
    const header = unit === 'hour' ? '小时,应用,下载字节,上传字节' : '日期,应用,下载字节,上传字节';
    const lines = exportRows.map((r) => `${r.slot},"${String(r.name).replace(/"/g, '""')}",${r.down},${r.up}`);
    const blob = new Blob([`\ufeff${[header, ...lines].join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    // 文件名说清导出的到底是哪一段：单格给槽位，多格给起止，预设档给天数。
    // 小时槽位里的 T 换成下划线 —— 「…-08T00_…-12T00」读起来像两个文件名。
    const tag = (slot) => slot.replace(/T/g, '_');
    let suffix;
    if (scopeKeys.length === 1) {
      suffix = tag(scopeKeys[0]);
    } else if (selected >= 0 || customRange) {
      suffix = `${tag(scopeKeys[0])}_${tag(scopeKeys[scopeKeys.length - 1])}`;
    } else {
      suffix = `${days}d`;
    }
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
      // 默认值：已经选中某一格时收窄到那一格本身，否则落**今天**。
      // 不给整个可见区间（近 90 天）当默认值：那个长度按定义就走整日聚合，
      // 一打开就是一组用不上的时刻框，还得先把两个日期都改掉才轮到「具体时间段」——
      // 而点开自定义档的人，十次有九次就是想切某一天的某几个小时。
      // 落在今天则天然是小时档，默认那句回执就把这一档能干什么说清楚了。
      // 已经有自定义区间时沿用上次那一段，不把它冲掉。
      const picked = selected >= 0 ? dayOfSlot(buckets[selected].slots[0]) : dayKeys(1)[0];
      els.startDate.value = customRange ? customRange.start : picked;
      els.endDate.value = customRange ? customRange.end : picked;
      // 留空 = 全天。存的就是空串，不在这里补 00:00 / 23:59 ——
      // 补过一次以后重新打开这一档，字段里会写着「你上次明确选了 00:00 和 23:59」，
      // 而用户其实什么都没填。归一交给 rangeBounds，它本来就认空值。
      els.startTime.value = customRange ? customRange.startTime : '';
      els.endTime.value = customRange ? customRange.endTime : '';
      applyDateBounds();
      syncGranularity();
      els.startDate.focus();
    }
  });

  // 粒度在这里决定整张表单长什么样，但它**不是**一个表单状态：用户只填「从哪到哪」，
  // 画多少根柱由区间长度自己定（planQuery）。
  // 时刻字段是一对比日期框窄的主题化下拉，25 个取值里第一个是空值「全天」——
  // 「什么都没填」在这里是一个有意义的选择，下拉自己就把这句话说清楚了
  //（原来那版是个 <input type="time">，空值显示 --:--，读起来像「还没填」，
  // 还得自己叠一层占位；而且它的弹层是 Chromium 的 PagePopup，改不了色）。
  // 这里只做一件事：区间短到画得下小时柱时露出时刻字段，超了就把它收起。
  // 收起而不是 disabled：灰控件读作「坏了/没权限」，而这里的事实是
  // 「这一档用不上时刻」—— 那是回执该说的话（第二行那行字），不是控件的状态。
  // 被收起的字段**不清空**：把结束日期拉回来，上次选的那个整点原样还在。
  function syncGranularity() {
    const start = els.startDate.value;
    const end = els.endDate.value;
    if (!start || !end) {
      els.startTimeWrap.hidden = true;
      els.endTimeWrap.hidden = true;
      els.granNote.textContent = '';
      return;
    }
    // 回执读的是**将要画出来的那一份**，不是把 planQuery 的输入重念一遍：
    // 小时数走 hourKeysBetween（同一套骨架），天数走 dayKeysBetween 的计数口径，
    // 于是「共 N 小时」和点完之后柱图上真有的根数永远一致。
    const plan = planQuery({ start, end, startTime: els.startTime.value, endTime: els.endTime.value });
    const hourly = plan.unit === 'hour';
    els.startTimeWrap.hidden = !hourly;
    els.endTimeWrap.hidden = !hourly;
    if (hourly) {
      els.granNote.textContent = `按小时聚合 · 共 ${hourKeysBetween(plan.startMs, plan.endMs).length} 小时`;
      return;
    }
    // 按天档还分天/周两级，判据与 buildBuckets 同一处门槛 —— 回执说的必须是
    // 柱图上真画出来的那一档。区间长到按周了还说「按天」是错的，
    // 而工具栏那个「按周聚合」的胶囊讲的是整屏、不是这一段自定义区间。
    const span = spanDays(start, end);
    const agg = span > WEEK_AGG_THRESHOLD ? '周' : '天';
    els.granNote.textContent = `按${agg}聚合 · 共 ${span} 天（超过 3 天，时刻不参与）`;
  }

  // 日期框（含 date-picker.js 的浮层写回）与两个时刻下拉有任何改动都重判一次粒度。
  // 挂在 form 上而不是逐个控件：这两个浮层都不是原生 input 的事件源，逐个绑容易漏。
  // 必须**同时**听 input 和 change —— select-menu.js 选完只冒泡 change（它写的是
  // select.value，程序化赋值连 input 都不会有）。只绑 input 的话，改时刻不会重算粒度，
  // 而这一版粒度又决定时刻字段在不在场，是条会互相咬住的回路。
  els.customForm.addEventListener('input', syncGranularity);
  els.customForm.addEventListener('change', syncGranularity);

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
    // 收起字段不会清掉它的 value（这是故意的，见 syncGranularity），读之前先按当前
    // 粒度归一：整日档一律交空串，让 rangeBounds 补整日边界，否则上一次填的 08:00
    // 会被当成这次的选择 —— 屏幕上那个字段当时根本不在。
    const hourly = !els.startTimeWrap.hidden;
    const startTime = hourly ? els.startTime.value : '';
    const endTime = hourly ? els.endTime.value : '';
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
    // 日期级的检查全过了才轮到时刻：同一天里 18:00 ~ 08:00 是「日期没问题、区间反了」，
    // 让它在日期那几条里报错会指向一个根本不成立的字段。
    const draft = { start, end, startTime, endTime };
    const bound = rangeBounds(draft);
    if (bound.a > bound.b) {
      showRangeError('开始时刻不能晚于结束时刻。');
      return;
    }
    if (bound.a.getTime() > Date.now()) {
      showRangeError('开始时间不能晚于当前时间。');
      return;
    }
    customRange = draft;
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

  // 设置屏「清空历史」之后，这一屏缓存的三样东西全部过期，而它们都没有自然的失效点：
  //   - firstDay 一旦取到就永久留着（applyDateBounds 有 `if (firstDay) return` 的快路径），
  //     于是日期框的 min 还锁在已被删掉的那一天，提交校验还会说「历史库最早记录是 X」；
  //   - inspectorRows / inspectorSpan 是检查栏 30 天曲线的独立缓存，同样不会自己重查。
  // 清完之后如果人还在历史屏，顺手重拉一次，别让屏上继续摆着已经删掉的数据。
  window.addEventListener('netpeek-historycleared', () => {
    firstDay = null;
    inspectorRows = null;
    inspectorSpan = 0;
    loadRows();
  });

  window.NetPeekHistoryUI = {
    // 进入历史屏时拉一次；库每整分钟才落一次，不需要更勤。
    // opts.focusToday：从实时屏「今日」卡上的「详情」进来时要定位到今天 ——
    // 那个入口的全部语义就是「看今天的账」，落在一屏默认的「近 30 天、未选中」
    // 上等于让用户自己再找一遍。
    async onEnter(opts) {
      if (opts && opts.focusToday) {
        const today = dayKeys(1)[0];
        // 作用域必须先含今天，否则选中必然落空：自定义区间可能整段在过去。
        // 回默认档而不是「把区间往今天挪」—— 后者会悄悄改掉用户挑的区间。
        if (customRange && (today < customRange.start || today > customRange.end)) {
          days = DEFAULT_DAYS;
          customRange = null;
          closeCustomRange();
          els.range.querySelectorAll('button[data-days]')
            .forEach((b) => b.classList.toggle('is-active', b.dataset.days === String(DEFAULT_DAYS)));
        }
        pendingFocusDay = today;
      }
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
    //     拿它画「最近 30 天」等于把曲线清空；
    //   - 切到小时档时 rows 的键根本不是日期，一条都对不上（windowDays 归 0，
    //     所以那条复用分支也不会被走到，这里是第二道保险）。
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
          inspectorRows = JSON.parse(raw || '[]').map((row) => ({
            slot: row.day, name: row.name, down: row.down, up: row.up,
          }));
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
        if (perDay.has(r.slot)) perDay.set(r.slot, perDay.get(r.slot) + r.down);
      }
      return keys.map((k) => ({ key: k, label: labelOf(k), value: perDay.get(k) }));
    },
  };
})();
