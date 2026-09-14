// 采集端「重连首帧」契约校验（开发期工具，不属于发布物）。
//
// 校验的契约：**UI（重）连接后的第一帧不得报速率**。
//
// 为什么需要这条：快照里的 DownloadBytes/UploadBytes 是「距上一帧的增量」，
// 而增量基线只在 UI 连着时才推进。UI 断开期间 ETW 照收、累计值照涨，
// 于是重连首帧会把「断开期间攒下的全部存量」当成 1 秒的速率报出去。
// 一次假尖峰会同时打坏三处：实时带宽图的 y 轴量程被顶上去并锁死 60 秒、
// 历史库按分钟累加这笔假增量（实测污染到全天流量的 44%）、网速提醒被误触发。
//
// 判据（自校准，不依赖网速）：先断开并灌入已知字节数，再连上读 4 帧。
//   · 首帧速率 ≤ 灌入量 / 5        → 契约成立
//   · 首帧速率 ≈ 灌入量（即存量被当速率） → 契约被破坏
//
// 用法：
//   node scripts/verify-first-frame.mjs                     # 默认灌 8 MB，连上读 4 帧
//   node scripts/verify-first-frame.mjs --download 20       # 灌 20 MB
//   node scripts/verify-first-frame.mjs --no-download       # 不灌流量（只做冒烟）
//
// 需要采集端已在运行（scripts/dev-collector.ps1 启动）。本脚本只读管道，不改任何东西。

import net from 'node:net';
import https from 'node:https';

const PIPE = '\\\\.\\pipe\\NetPeekCollector';
// 故意用 Cloudflare 的测速端点：按 bytes 参数返回确定大小的响应体，
// 于是「灌了多少字节」是可核对的数字，不用靠猜。
const SINK = (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`;

function parseArgs(argv) {
  const a = { download: 8, frames: 4, pipe: PIPE, stream: 'down' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--no-download') a.download = 0;
    else if (k === '--download') a.download = Number(argv[++i]);
    else if (k === '--frames') a.frames = Number(argv[++i]);
    else if (k === '--pipe') a.pipe = argv[++i];
  }
  return a;
}

const fmt = (v) => {
  if (!(v > 0)) return '0';
  for (const [s, t] of [[1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']]) {
    if (v >= s) return `${(v / s).toFixed(2)} ${t}`;
  }
  return `${Math.round(v)} B`;
};

/** 灌入真实流量：断开状态下累积，重连时就能看出它有没有被当成一帧的增量。 */
function download(bytes) {
  return new Promise((resolve, reject) => {
    const req = https.get(SINK(bytes), (res) => {
      let got = 0;
      res.on('data', (c) => { got += c.length; });
      res.on('end', () => resolve(got));
    });
    req.on('error', reject);
    // 30 秒掐断：灌流量只是为了把存量做大，拿不到不该让整个校验挂住
    // （受限网络 / 代理环境里这一步会超时，脚本要能降级继续）。
    req.setTimeout(30000, () => { req.destroy(new Error('下载超时')); });
  });
}

/** 连上管道，逐帧读（4 字节小端长度前缀 + UTF-8 JSON）。 */
function connect(pipe) {
  const sock = net.connect(pipe);
  let buf = Buffer.alloc(0);
  // 帧队列 + 等待者：到达顺序不能丢。只用一个「下一个 resolve」的话，
  // 两帧挤在一次 read 里时后一帧会被丢掉，读数就错位了。
  const queue = [];
  const waiters = [];

  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) break;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const json = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      let value = null;
      try { value = JSON.parse(json); } catch { /* 单帧解析失败不影响后续 */ }
      const w = waiters.shift();
      if (w) w(value); else queue.push(value);
    }
  });
  const finish = () => waiters.splice(0).forEach((w) => w(null));
  sock.on('close', finish);
  sock.on('error', finish);

  return {
    ready: new Promise((res, rej) => {
      sock.once('connect', res);
      sock.once('error', rej);
    }),
    frame: () => new Promise((res) => {
      if (queue.length) res(queue.shift());
      else waiters.push(res);
    }),
    close: () => { try { sock.destroy(); } catch { /* 已关 */ } },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('='.repeat(76));
  console.log('采集端「重连首帧」契约校验');
  console.log('='.repeat(76));
  console.log(`管道 ${args.pipe}`);

  let poured = 0;
  if (args.download > 0) {
    const want = Math.round(args.download * 1e6);
    process.stdout.write(`灌入流量 ${args.download} MB（断开状态下累积）… `);
    const t = Date.now();
    try {
      poured = await download(want);
      console.log(`实收 ${fmt(poured)}，耗时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
    } catch (e) {
      // 拿不到就退回绝对判据。积压量本来就随时间增长，只要断开超过十几秒，
      // 存量一般已经远大于 1 MB/s 这条线，判定仍然有效。
      console.log(`失败（${e.message}）—— 退回「首帧 ≤ 1 MB/s」的绝对判据`);
      poured = 0;
    }
  } else {
    console.log('（跳过灌流量：--no-download）');
  }

  const c = connect(args.pipe);
  await c.ready;
  console.log('\n已连接，逐帧读数：');

  const frames = [];
  for (let i = 0; i < args.frames; i++) {
    const t = Date.now();
    const f = await c.frame();
    if (!f) { console.log(`  第 ${i + 1} 帧：管道关闭`); break; }
    const down = Number(f.TotalDownloadBytes) || 0;
    const up = Number(f.TotalUploadBytes) || 0;
    const procs = (f.Processes || []).length;
    frames.push({ down, up, status: f.Status, procs, ms: Date.now() - t });
    console.log(
      `  第 ${i + 1} 帧  状态 ${String(f.Status).padEnd(8)} 下载 ${fmt(down).padStart(10)}/s`
      + `  上传 ${fmt(up).padStart(10)}/s  进程 ${String(procs).padStart(3)}`
      + `   (间隔 ${Date.now() - t}ms)`
    );
  }
  c.close();

  // 只看「真正在报速率」的帧：状态不是 ok 的帧没有进程列表，速率恒为 0
  const live = frames.filter((f) => f.status === 'ok' && f.procs > 0);
  if (!live.length) {
    console.log('\n没有采到 ok 状态的帧 —— 采集服务没起来或 ETW 会话未就绪，本次判定无效。');
    return 2;
  }

  const first = live[0];
  const cap = poured > 0 ? poured / 5 : 1e6;
  const baselineFrames = live.filter((f) => f.down === 0 && f.up === 0).length;

  console.log('\n' + '-'.repeat(76));
  console.log(`首帧速率      ${fmt(first.down)}/s 下载、${fmt(first.up)}/s 上传`);
  console.log(`判据上限      ${fmt(cap)}/s（= 灌入量 / 5${poured ? '' : '，未灌流量时取 1 MB/s'}）`);
  console.log(`零速率帧数    ${baselineFrames} / ${live.length}`);
  const pass = first.down <= cap && first.up <= cap;
  console.log(pass
    ? '判定：**通过** —— 首帧只记基线、不报速率。'
    : '判定：**失败** —— 首帧把断开期间累积的存量当成了 1 秒的速率。');
  console.log('-'.repeat(76));
  return pass ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('\n校验无法进行：' + (e && e.message ? e.message : e));
  process.exit(2);
});
