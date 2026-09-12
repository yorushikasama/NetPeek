// 设置屏交互层（v2）：左分区导航（snav）+ 右表单（sgroup），点分区切换显隐。
// 破坏性动作（清空历史）原地二次确认，不弹模态框，5 秒无操作自动收回。
//
// 状态结构（camelCase，与 Rust settings.json 一致）：
// { rateUnit: 'auto'|'kb'|'mb'|'gb', retentionDays: 7|30|90|365|0, autostart: bool, recordUnattributed: bool }

(function () {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = 'netpeek-settings';
  const CONFIRM_TIMEOUT = 5000;

  const els = {
    snav: $('settingsNav'),
    rateUnit: $('setRateUnit'),
    autostart: $('setAutostart'),
    recordUnattributed: $('setRecordUnattributed'),
    downAlert: $('setDownAlert'),
    upAlert: $('setUpAlert'),
    retention: $('setRetention'),
    histStats: $('histStats'),
    histRefresh: $('histRefresh'),
    histClear: $('histClear'),
    histClearConfirm: $('histClearConfirm'),
    histClearYes: $('histClearYes'),
    histClearNo: $('histClearNo'),
    svcStatus: $('svcStatus'),
    svcEventsLost: $('svcEventsLost'),
    svcPause: $('svcPause'),
    svcLog: $('svcLog'),
    svcLogPath: $('svcLogPath'),
    geoDbInfo: $('geoDbInfo'),
    geoDbPick: $('geoDbPick'),
    geoDbReset: $('geoDbReset'),
    aboutDataDir: $('aboutDataDir'),
  };

  let state = {
    rateUnit: 'auto',
    retentionDays: 30,
    autostart: false,
    recordUnattributed: true,
  };

  // 最近一次 history_stats 结果，检查栏总览态的「历史库占用」直接读这里
  let stats = null;
  let confirmTimer = null;
  // 采集是否已暂停。真值来自快照的 Status，按钮只发命令、不自己翻状态。
  let paused = false;

  function hasTauri() {
    return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  }

  async function invoke(cmd, args) {
    if (!hasTauri()) throw new Error('非 Tauri 环境');
    return window.__TAURI__.core.invoke(cmd, args || {});
  }

  function notify() {
    window.dispatchEvent(new CustomEvent('netpeek-settingschange', {
      detail: { rateUnit: state.rateUnit, retentionDays: state.retentionDays },
    }));
  }

  async function load() {
    try {
      state = Object.assign(state, JSON.parse(await invoke('load_settings') || '{}'));
    } catch {
      try {
        state = Object.assign(state, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
      } catch { /* 保持默认 */ }
    }
  }

  async function save() {
    try {
      await invoke('save_settings', { json: JSON.stringify(state) });
      flashSaved();
    } catch {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    }
  }

  // 保存回执：设置全是防抖自动写盘、没有「保存」按钮，用户改完唯一的问题就是
  // 「存住了吗」。一个 2 秒淡出的 status（aria-live=polite，不抢焦点）回答它。
  let saveHintTimer = null;
  function flashSaved() {
    const el = $('saveHint');
    if (!el) return;
    el.innerHTML = window.NetPeekCommon.icon('check') + '已自动保存';
    el.classList.add('is-show');
    clearTimeout(saveHintTimer);
    saveHintTimer = setTimeout(() => el.classList.remove('is-show'), 2000);
  }

  // 写盘防抖：save_settings 每次都要重写 settings.json，并按 autostart 起一次 reg 子进程。
  // 拖动保留期数字框、连续改几项时，每一下都落盘纯属浪费——尾部防抖 400ms，
  // 中间值不丢，只是晚一点写。autostart 不走这条路（见 bind 里的注释）。
  const debouncedSave = (window.NetPeekCommon && window.NetPeekCommon.debounce)
    ? window.NetPeekCommon.debounce(save, 400)
    : { schedule: save, flush: save, pending: false };

  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  function fmtTs(tsSecs) {
    if (!tsSecs) return '';
    const d = new Date(tsSecs * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // 「41822 条 · — ~ — · 7.3 MB」这种串是把缺失值当成值印出去了：
  // 两端都取不到时间戳就不摆这一段，只报条数和占用。
  function fmtRange(firstTs, lastTs) {
    const a = fmtTs(firstTs);
    const b = fmtTs(lastTs);
    if (a && b) return `${a} ~ ${b}`;
    return a || b || '';
  }

  async function refreshStats() {
    try {
      stats = JSON.parse(await invoke('history_stats'));
      const range = stats.rows ? fmtRange(stats.firstTs, stats.lastTs) : '';
      els.histStats.textContent = stats.rows
        ? [`${stats.rows} 条`, range, fmtSize(stats.bytes)].filter(Boolean).join(' · ')
        : '暂无历史数据（分钟聚合每整分钟落库一次）';
      els.histStats.className = 'note';
    } catch {
      stats = null;
      els.histStats.textContent = '历史概览不可用（浏览器预览模式）';
      els.histStats.className = 'note is-warn';
    }
    window.dispatchEvent(new CustomEvent('netpeek-historystats', { detail: { stats } }));
  }

  function closeConfirm() {
    clearTimeout(confirmTimer);
    confirmTimer = null;
    els.histClearConfirm.hidden = true;
    els.histClear.hidden = false;
  }

  // 分区切换：snav 选中态 + sgroup 显隐。切分区不重置任何状态，
  // 回到设置屏时停在离开前的那一区更顺手。
  function selectSection(sec) {
    if (!els.snav) return;
    for (const b of els.snav.querySelectorAll('button[data-sec]')) {
      const on = b.dataset.sec === sec;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const g of document.querySelectorAll('.sgroup[data-sec]')) {
      g.hidden = g.dataset.sec !== sec;
    }
  }

  function bind() {
    if (els.snav) {
      els.snav.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-sec]');
        if (btn) selectSection(btn.dataset.sec);
      });
    }

    els.rateUnit.addEventListener('change', () => {
      state.rateUnit = els.rateUnit.value;
      debouncedSave.schedule();
      // 单位切换必须立刻反映到屏幕上，不能被防抖拖住，所以通知照发不误
      notify();
    });

    els.retention.addEventListener('change', async () => {
      state.retentionDays = parseInt(els.retention.value, 10);
      debouncedSave.schedule();
      // 修剪历史是独立命令，和写设置没有先后依赖，不必跟着防抖一起等
      try { await invoke('set_retention', { days: state.retentionDays }); } catch { /* 降级不阻塞 */ }
      refreshStats();
      notify();
    });

    // autostart 刻意不走防抖：注册表才是真实生效点，写完必须立刻回读确认，
    // 否则防抖窗口内回读到的还是旧状态，勾选框会自己弹回去。
    els.autostart.addEventListener('change', async () => {
      state.autostart = els.autostart.checked;
      await save();
      try { els.autostart.checked = await invoke('get_autostart'); } catch { /* 保持勾选态 */ }
    });

    els.recordUnattributed.addEventListener('change', () => {
      state.recordUnattributed = els.recordUnattributed.checked;
      debouncedSave.schedule();
    });

    // 阈值提醒：输入即存（防抖）。非法输入（负数/非数字）回落 0 = 关闭，回显归零。
    const bindAlert = (key) => () => {
      let v = parseFloat(els[key].value);
      if (!Number.isFinite(v) || v < 0) v = 0;
      els[key].value = v;
      state[key === 'downAlert' ? 'downAlertMb' : 'upAlertMb'] = v;
      debouncedSave.schedule();
    };
    els.downAlert.addEventListener('change', bindAlert('downAlert'));
    els.upAlert.addEventListener('change', bindAlert('upAlert'));

    // 离开设置屏 / 窗口失焦 / 关窗之前把挂起的写入落掉：防抖只有 400ms，
    // 但用户完全可能改完立刻关窗，那次改动不能停在定时器里。
    const flush = () => { void debouncedSave.flush(); };
    window.addEventListener('blur', flush);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flush();
    });

    els.histRefresh.addEventListener('click', refreshStats);

    els.histClear.addEventListener('click', () => {
      const size = stats && stats.bytes ? fmtSize(stats.bytes) : '全部历史';
      els.histClearYes.textContent = `确认清空 ${size}？`;
      els.histClear.hidden = true;
      els.histClearConfirm.hidden = false;
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(closeConfirm, CONFIRM_TIMEOUT);
    });

    els.histClearNo.addEventListener('click', closeConfirm);

    els.histClearYes.addEventListener('click', async () => {
      closeConfirm();
      try {
        await invoke('clear_history');
        await refreshStats();
      } catch {
        els.histStats.textContent = '清空失败（浏览器预览模式不可用）';
        els.histStats.className = 'note is-error';
      }
    });

    // 暂停/恢复采集：命令走控制管道，按钮文字等下一帧快照回来才翻，
    // 免得管道没送到却先显示成已暂停。
    els.svcPause.addEventListener('click', async () => {
      els.svcPause.disabled = true;
      try {
        await invoke('send_control_command', { command: paused ? 'resume' : 'pause' });
      } catch {
        els.svcPause.disabled = false;
        els.svcStatus.textContent = '采集服务：控制命令发送失败（管道未连接）';
        els.svcStatus.className = 'note is-error';
      }
    });

    // 打开采集服务日志：服务以 LocalSystem 运行、没有控制台输出，
    // 出问题时这是用户唯一能拿到的一手线索，所以入口放在服务状态旁边。
    els.svcLog.addEventListener('click', async () => {
      try {
        await invoke('open_collector_log');
      } catch (e) {
        els.svcLogPath.textContent = String(e);
        els.svcLogPath.className = 'note is-error';
      }
    });

    // 换国家库：选文件 → 校验 → 落设置 → 立即生效，全在 Rust 侧一次完成；
    // 前端只负责把结果反映出来。取消选择时后端返回空串。
    els.geoDbPick.addEventListener('click', async () => {
      els.geoDbPick.disabled = true;
      try {
        await invoke('pick_country_db');
        await refreshGeoDb();
      } catch (e) {
        els.geoDbInfo.textContent = `换库失败：${e}`;
        els.geoDbInfo.className = 'note is-error';
      } finally {
        els.geoDbPick.disabled = false;
      }
    });

    els.geoDbReset.addEventListener('click', async () => {
      els.geoDbReset.disabled = true;
      try {
        await invoke('set_country_db', { path: '' });
        await refreshGeoDb();
      } catch (e) {
        els.geoDbInfo.textContent = `切回内置库失败：${e}`;
        els.geoDbInfo.className = 'note is-error';
      }
    });
  }

  // 国家库状态文案（纯函数，便于单测）。内嵌库「发版即冻结」，所以要把
  // 实际生效的是哪一个、库构建于哪天说明白——用户才能判断该不该换一个更新的。
  // mode: builtin | custom | broken（Rust 侧 geo::DbInfo）
  function geoDbLabel(info) {
    if (!info || typeof info !== 'object') {
      return { text: '国家库状态不可用', className: 'note is-warn', title: '', canReset: false };
    }
    const kind = info.database_type || '未知类型';
    const date = info.build_date ? `构建于 ${info.build_date}` : '';
    if (info.mode === 'custom') {
      return {
        text: `自定义库：${kind}${date ? ` · ${date}` : ''}`,
        className: 'note is-ok',
        title: info.path || '',
        canReset: true,
      };
    }
    if (info.mode === 'broken') {
      return {
        text: '内嵌国家库不可用，对端国家将全部显示为未知',
        className: 'note is-error',
        title: '',
        canReset: false,
      };
    }
    return {
      text: `内嵌 DB-IP 库${date ? ` · ${date}` : ''}`,
      className: 'note',
      title: '随应用版本发布，不会自动更新',
      canReset: false,
    };
  }

  async function refreshGeoDb() {
    let view;
    try {
      view = geoDbLabel(JSON.parse(await invoke('country_db_info')));
    } catch {
      view = { text: '国家库状态不可用（浏览器预览模式）', className: 'note is-warn', title: '', canReset: false };
    }
    els.geoDbInfo.textContent = view.text;
    els.geoDbInfo.className = view.className;
    els.geoDbInfo.title = view.title;
    els.geoDbReset.disabled = !view.canReset;
  }

  // 服务状态：由 main.js 每次快照转发，避免重复监听管道。
  // 措辞和顶栏状态胶囊共用一套（监控中 / 已暂停 / 异常），否则同一个信号在两个岛上叫两个名字。
  function updateService(snap) {
    const status = snap.Status;
    if (status === 'paused') {
      els.svcStatus.textContent = '采集服务：已暂停';
      els.svcStatus.className = 'note is-warn';
    } else if (status === 'ok') {
      els.svcStatus.textContent = '采集服务：监控中';
      els.svcStatus.className = 'note is-ok';
    } else {
      els.svcStatus.textContent = '采集服务：异常（ETW 会话需要管理员权限）';
      els.svcStatus.className = 'note is-error';
    }
    const lost = snap.EventsLost || 0;
    els.svcEventsLost.textContent = lost > 0
      ? `ETW 丢事件：${lost} 条 · 实际用量可能高于显示值`
      : 'ETW 丢事件：无丢失';
    els.svcEventsLost.className = lost > 0 ? 'note is-warn' : 'note is-ok';
    paused = status === 'paused';
    els.svcPause.textContent = paused ? '恢复采集' : '暂停采集';
    els.svcPause.disabled = false;
  }

  function updateServiceOffline() {
    els.svcStatus.textContent = '采集服务：未连接';
    els.svcStatus.className = 'note';
    els.svcEventsLost.textContent = '';
    els.svcPause.disabled = true;
  }

  function fillControls() {
    els.rateUnit.value = state.rateUnit || 'auto';
    els.retention.value = String(state.retentionDays ?? 30);
    els.autostart.checked = !!state.autostart;
    els.recordUnattributed.checked = state.recordUnattributed !== false;
    els.downAlert.value = String(state.downAlertMb ?? 0);
    els.upAlert.value = String(state.upAlertMb ?? 0);
  }

  window.NetPeekSettingsUI = {
    async init() {
      await load();
      fillControls();
      bind();
      notify();
      // 注册表是开机自启的真实状态，settings.json 可能过时
      try { els.autostart.checked = await invoke('get_autostart'); } catch { /* 保持文件值 */ }
      try {
        // \ 后插零宽空格：换行断在目录分隔符上，不会把 com.netpeek.app 劈成两截
        const dir = await invoke('data_dir_path');
        els.aboutDataDir.textContent = String(dir).replace(/\\/g, '\\\u200b');
      } catch { /* 浏览器预览：保留 HTML 里的占位路径 */ }
      try {
        els.svcLogPath.textContent = String(await invoke('collector_log_path'));
      } catch { /* 浏览器预览：留空即可 */ }
      await refreshGeoDb();
      await refreshStats();
    },
    // 进入设置屏时刷新一次概览
    onEnter: refreshStats,
    getStats: () => stats,
    fmtSize,
    geoDbLabel,
    updateService,
    updateServiceOffline,
  };
})();

