// NetPeek 占位前端。
// 阶段 3 接入命名管道后，这里会改成监听 Tauri event 并渲染真实快照。
// 当前用本地假数据验证界面结构。

const rowsEl = document.getElementById('rows');
const totalDownEl = document.getElementById('totalDown');
const totalUpEl = document.getElementById('totalUp');
const statusEl = document.getElementById('status');

const apps = [
  { name: 'chrome.exe', pid: 8124 },
  { name: 'Discord.exe', pid: 4296 },
  { name: 'steam.exe', pid: 11732 },
];

function fmtRate(bytesPerSec) {
  if (bytesPerSec >= 1e6) return (bytesPerSec / 1e6).toFixed(1) + ' MB/s';
  if (bytesPerSec >= 1e3) return (bytesPerSec / 1e3).toFixed(1) + ' KB/s';
  return bytesPerSec + ' B/s';
}
function fmtBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + ' KB';
  return bytes + ' B';
}

const totals = apps.map(() => ({ down: 0, up: 0 }));

function tick() {
  let totalDown = 0;
  let totalUp = 0;
  const frag = document.createDocumentFragment();

  apps.forEach((app, i) => {
    const down = Math.floor(Math.random() * 200000);
    const up = Math.floor(Math.random() * 40000);
    totals[i].down += down;
    totals[i].up += up;
    totalDown += down;
    totalUp += up;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${app.name}</td>
      <td class="num">${app.pid}</td>
      <td class="num down">${fmtRate(down)}</td>
      <td class="num up">${fmtRate(up)}</td>
      <td class="num">${fmtBytes(totals[i].down)}</td>
      <td class="num">${fmtBytes(totals[i].up)}</td>`;
    frag.appendChild(tr);
  });

  rowsEl.replaceChildren(frag);
  totalDownEl.textContent = fmtRate(totalDown);
  totalUpEl.textContent = fmtRate(totalUp);
}

setInterval(tick, 1000);
tick();
