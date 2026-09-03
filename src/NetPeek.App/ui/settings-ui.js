// 设置面板交互层（阶段 4）：速率单位 / 保留期 / 开机自启 / 历史概览 / 服务状态。
// 状态结构（camelCase，与 Rust settings.json 一致）：
// { rateUnit: 'auto'|'kb'|'mb'|'gb', retentionDays: 7|30|90|365|0, autostart: bool, recordUnattributed: bool }
// 单位与保留期改动立即持久化；开机自启写入注册表（save_settings 内部同步）。

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    overlay: $('settingsOverlay'),
    btn: $('settingsBtn'),
    close: $('settingsClose'),
    rateUnit: $('setRateUnit'),
    autostart: $('setAutostart'),
    retention: $('setRetention'),
    histStats: $('histStats'),
    histRefresh: $('histRefresh'),
    histClear: $('histClear'),
    svcStatus: $('svcStatus'),
    svcEventsLost: $('svcEventsLost'),
    openThemeBtn: $('openThemeBtn'),
  };

  let state = {
    rateUnit: 'auto',
    retentionDays: 30,
    autostart: false,
    recordUnattributed: true,
  };

  const LS_KEY = 'netpeek-settings';

  function hasTauri() {
    return !!(window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke);
  }

  async function invoke(cmd, args) {
    if (!hasTauri()) throw new Error('非 Tauri 环境');
    return window.__TAURI__.core.invoke(cmd, args || {});
  }

  function notify() {
    // 通知 main.js 速率单位变化，重渲染表格与图表。
    window.dispatchEvent(new CustomEvent('netpeek-settingschange', {
      detail: { rateUnit: state.rateUnit },
    }));
  }

  async function load() {
    try {
      const raw = await invoke('load_settings');
      state = Object.assign(state, JSON.parse(raw || '{}'));
    } catch {
      // 浏览器预览降级：localStorage
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

  async function refreshHist() {
    try {
      const s = JSON.parse(await invoke('history_stats'));
      if (!s.rows) {
        els.histStats.textContent = '暂无历史数据（分钟聚合每整分钟落库一次）';
        return;
      }
      els.histStats.textContent =
        `${s.rows} 条 · ${fmtTs(s.firstTs)} ~ ${fmtTs(s.lastTs)} · ${fmtSize(s.bytes)}`;
    } catch {
      els.histStats.textContent = '历史概览不可用（浏览器预览模式）';
    }
  }

  function bind() {
    els.btn.addEventListener('click', () => {
      els.overlay.hidden = false;
      refreshHist();
      // 服务状态常驻更新，打开时也同步一次
      const snap = window.__netpeekLastSnap || null;
      if (snap) updateService(snap);
    });
    els.close.addEventListener('click', () => { els.overlay.hidden = true; });
    els.overlay.addEventListener('click', (e) => {
      if (e.target === els.overlay) els.overlay.hidden = true;
    });

    els.rateUnit.addEventListener('change', async () => {
      state.rateUnit = els.rateUnit.value;
      await save();
      notify();
    });

    els.retention.addEventListener('change', async () => {
      state.retentionDays = parseInt(els.retention.value, 10);
      await save();
      try { await invoke('set_retention', { days: state.retentionDays }); } catch { /* 降级不阻塞 */ }
      refreshHist();
    });

    els.autostart.addEventListener('change', async () => {
      state.autostart = els.autostart.checked;
      await save();
    });

    els.histRefresh.addEventListener('click', refreshHist);
    els.histClear.addEventListener('click', async () => {
      if (!confirm('确定清空全部历史数据？此操作不可恢复。')) return;
      try {
        await invoke('clear_history');
        refreshHist();
      } catch {
        alert('清空历史失败（浏览器预览模式不可用）');
      }
    });

    els.openThemeBtn.addEventListener('click', () => {
      els.overlay.hidden = true;
      const themeOverlay = document.getElementById('themeOverlay');
      if (themeOverlay) themeOverlay.hidden = false;
    });
  }

  // 服务状态：由 main.js 每次快照转发到这里（避免重复监听管道）。
  function updateService(snap) {
    const status = snap.Status;
    if (status === 'paused') {
      els.svcStatus.textContent = '采集服务：已暂停';
      els.svcStatus.className = 'tnote warn';
    } else if (status === 'ok') {
      els.svcStatus.textContent = '采集服务：运行中';
      els.svcStatus.className = 'tnote ok';
    } else {
      els.svcStatus.textContent = '采集服务：异常（需管理员权限）';
      els.svcStatus.className = 'tnote err';
    }
    const lost = snap.EventsLost || 0;
    els.svcEventsLost.textContent = lost > 0
      ? `ETW 丢事件：${lost} 条（显示数值可能不准）`
      : 'ETW 丢事件：0';
    els.svcEventsLost.className = lost > 0 ? 'tnote warn' : 'tnote ok';
  }

  function updateServiceOffline() {
    els.svcStatus.textContent = '采集服务：未连接';
    els.svcStatus.className = 'tnote';
    els.svcEventsLost.textContent = '';
  }

  function fillControls() {
    els.rateUnit.value = state.rateUnit || 'auto';
    els.retention.value = String(state.retentionDays ?? 30);
    els.autostart.checked = !!state.autostart;
  }

  window.NetPeekSettingsUI = {
    async init() {
      await load();
      fillControls();
      bind();
      notify();
    },
    // 供 main.js 快照渲染时同步服务状态
    updateService,
    updateServiceOffline,
  };
})();
