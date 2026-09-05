// 设置屏交互层（§2.7）：和外观屏一样是「屏」而不是覆盖层。
// 数据岛放三列可操作项（常规 / 历史数据 / 采集服务），检查栏放不可操作的说明（关于 / 归因边界）。
// 破坏性动作（清空历史）原地二次确认，不弹模态框，5 秒无操作自动收回。
//
// 状态结构（camelCase，与 Rust settings.json 一致）：
// { rateUnit: 'auto'|'kb'|'mb'|'gb', retentionDays: 7|30|90|365|0, autostart: bool, recordUnattributed: bool }

(function () {
  const $ = (id) => document.getElementById(id);
  const LS_KEY = 'netpeek-settings';
  const CONFIRM_TIMEOUT = 5000;

  const els = {
    rateUnit: $('setRateUnit'),
    autostart: $('setAutostart'),
    recordUnattributed: $('setRecordUnattributed'),
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
    } catch {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    }
  }

  function fmtSize(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  function fmtTs(tsSecs) {
    if (!tsSecs) return '—';
    const d = new Date(tsSecs * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function refreshStats() {
    try {
      stats = JSON.parse(await invoke('history_stats'));
      els.histStats.textContent = stats.rows
        ? `${stats.rows} 条 · ${fmtTs(stats.firstTs)} ~ ${fmtTs(stats.lastTs)} · ${fmtSize(stats.bytes)}`
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

  function bind() {
    els.rateUnit.addEventListener('change', async () => {
      state.rateUnit = els.rateUnit.value;
      await save();
      notify();
    });

    els.retention.addEventListener('change', async () => {
      state.retentionDays = parseInt(els.retention.value, 10);
      await save();
      try { await invoke('set_retention', { days: state.retentionDays }); } catch { /* 降级不阻塞 */ }
      refreshStats();
      notify();
    });

    els.autostart.addEventListener('change', async () => {
      state.autostart = els.autostart.checked;
      await save();
      // 注册表是真实生效点，写完回读一次确认，避免 UI 与系统不一致
      try { els.autostart.checked = await invoke('get_autostart'); } catch { /* 保持勾选态 */ }
    });

    els.recordUnattributed.addEventListener('change', async () => {
      state.recordUnattributed = els.recordUnattributed.checked;
      await save();
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
      await refreshStats();
    },
    // 进入设置屏时刷新一次概览
    onEnter: refreshStats,
    getStats: () => stats,
    fmtSize,
    updateService,
    updateServiceOffline,
  };
})();

