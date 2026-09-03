// NetPeek 小窗（屏 2）：能量球 ⇄ 迷你窗 双形态交互。
// - 数据：监听主进程广播的 snapshot 事件（app.emit 广播到所有窗口）。
// - 形态：能量球 100x100 → 点击展开迷你窗 320x300（set_mini_size），再点「—」收起。
// - 主题：跟随主界面 CSS 变量（主界面 setTheme 会同步到所有窗口的 documentElement）。

(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    orb: $('orb'),
    orbDown: $('orbDown'),
    orbUp: $('orbUp'),
    orbPause: $('orbPause'),
    panel: $('panel'),
    panelStatus: $('panelStatus'),
    ptDown: $('ptDown'),
    ptUp: $('ptUp'),
    panelList: $('panelList'),
    btnCollapse: $('btnCollapse'),
    btnClose: $('btnClose'),
    btnPause: $('btnPause'),
    btnMain: $('btnMain'),
    btnQuit: $('btnQuit'),
  };

  const ORB_W = 100, ORB_H = 100;
  const PANEL_W = 320, PANEL_H = 300;
  const DRAG_THRESHOLD = 5; // 像素；超过才算拖动，否则视为点击

  let shape = 'orb'; // 'orb' | 'panel'
  let paused = false;

  const { listen, invoke } = window.__TAURI__
    ? { listen: window.__TAURI__.event.listen, invoke: window.__TAURI__.core.invoke }
    : { listen: () => Promise.resolve(() => {}), invoke: () => Promise.resolve(null) };

  // ---------- 工具 ----------

  function fmtRate(bps) {
    if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' GB/s';
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
    if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' KB/s';
    return bps + ' B/s';
  }

  function fmtBytes(b) {
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    if (b >= 1e3) return (b / 1e3).toFixed(1) + ' KB';
    return b + ' B';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ---------- 形态切换 ----------

  // 展开/收起：窗口尺寸与位置由 Rust 侧 set_mini_shape 调整（保持中心、夹屏幕）。
  async function setShape(next) {
    if (next === shape) return;
    shape = next;
    try {
      await invoke('set_mini_shape', { shape: next });
    } catch { /* 非 Tauri 环境忽略 */ }
    els.orb.hidden = next !== 'orb';
    els.panel.hidden = next !== 'panel';
  }

  // ---------- 渲染 ----------

  // 按应用聚合 Top 3（同主界面 topApps 逻辑的轻量版）
  function topApps(snap, n) {
    const map = new Map();
    for (const p of snap.Processes || []) {
      const name = (p.Name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let agg = map.get(key);
      if (!agg) {
        agg = { Name: name, IconBase64: '', DownBytes: 0, UpBytes: 0, DownTotal: 0, UpTotal: 0 };
        map.set(key, agg);
      }
      agg.DownBytes += p.DownloadBytes || 0;
      agg.UpBytes += p.UploadBytes || 0;
      agg.DownTotal += p.DownloadTotal || 0;
      agg.UpTotal += p.UploadTotal || 0;
      if (!agg.IconBase64 && p.IconBase64) agg.IconBase64 = p.IconBase64;
    }
    const apps = Array.from(map.values());
    apps.sort((a, b) => (b.DownTotal + b.UpTotal) - (a.DownTotal + a.UpTotal));
    return apps.slice(0, n);
  }

  function render(snap) {
    const down = snap.TotalDownloadBytes || 0;
    const up = snap.TotalUploadBytes || 0;
    paused = snap.Status === 'paused';

    els.orbDown.textContent = '↓ ' + fmtRate(down);
    els.orbUp.textContent = '↑ ' + fmtRate(up);
    els.orbPause.hidden = !paused;

    els.ptDown.textContent = fmtRate(down);
    els.ptUp.textContent = fmtRate(up);

    const lost = snap.EventsLost || 0;
    els.panelStatus.textContent = paused ? '已暂停'
      : snap.Status !== 'ok' ? '采集异常'
      : lost > 0 ? `丢事件 ${lost}` : '监控中';
    els.panelStatus.className = 'panel-status ' + (paused || lost > 0 ? 'warn'
      : snap.Status !== 'ok' ? 'err' : 'ok');

    els.btnPause.textContent = paused ? '继续' : '暂停';

    const apps = topApps(snap, 3);
    els.panelList.replaceChildren(
      ...apps.map((a) => {
        const row = document.createElement('div');
        row.className = 'pitem';
        row.innerHTML = `
          ${a.IconBase64
            ? `<img src="${a.IconBase64}" alt="" />`
            : '<span class="pname">?</span>'}
          <span class="pname">${esc(a.Name)}</span>
          <span class="prate down">↓ ${fmtRate(a.DownBytes)}</span>
          <span class="prate up">↑ ${fmtRate(a.UpBytes)}</span>`;
        return row;
      })
    );
  }

  // ---------- 事件 ----------

  // 自定义拖拽：按下后位移超过阈值才进入系统拖动，否则算点击（能量球点开/面板收起）。
  // 必须自己判断按键是否还按着：startDragging() 之后 WebView 收不到 mouseup，
  // 只靠 dragging 标记会让「上次点击后的普通 hover」也触发拖动。
  function bindDrag(el) {
    let sx = 0, sy = 0, pressed = false, dragging = false;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      sx = e.screenX; sy = e.screenY; pressed = true; dragging = false;
    });
    el.addEventListener('mousemove', async (e) => {
      if (!pressed || dragging) return;
      // 按键已松开（mouseup 丢在窗口外）时复位，避免空手拖窗
      if ((e.buttons & 1) === 0) { pressed = false; return; }
      if (Math.hypot(e.screenX - sx, e.screenY - sy) > DRAG_THRESHOLD) {
        dragging = true;
        pressed = false;
        try { await window.__TAURI__.window.getCurrentWindow().startDragging(); } catch { /* ignore */ }
      }
    });
    el.addEventListener('mouseup', () => { pressed = false; });
    el.addEventListener('mouseleave', () => { pressed = false; });
  }
  bindDrag(els.orb);
  bindDrag(els.panel.querySelector('.panel-head'));

  els.orb.addEventListener('click', () => setShape('panel'));

  els.btnCollapse.addEventListener('click', () => setShape('orb'));

  els.btnClose.addEventListener('click', async () => {
    try { await invoke('toggle_mini'); } catch { /* ignore */ }
  });

  els.btnPause.addEventListener('click', async () => {
    paused = !paused;
    els.btnPause.textContent = paused ? '继续' : '暂停';
    try { await invoke('send_control_command', { command: paused ? 'pause' : 'resume' }); } catch { /* ignore */ }
  });

  els.btnMain.addEventListener('click', async () => {
    try { await invoke('show_main_window'); } catch { /* ignore */ }
  });

  els.btnQuit.addEventListener('click', async () => {
    try { await invoke('quit_app'); } catch { /* ignore */ }
  });

  // ---------- 启动 ----------

  listen('snapshot', (e) => render(e.payload));
  listen('pipe-status', (e) => {
    if (e.payload !== 'connected') {
      els.panelStatus.textContent = '未连接采集服务';
      els.panelStatus.className = 'panel-status err';
      els.orbDown.textContent = '↓ --';
      els.orbUp.textContent = '↑ --';
    }
  });
})();
