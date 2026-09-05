using System.Collections.Concurrent;
using Microsoft.Diagnostics.Tracing.Parsers;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Tracing.Session;
using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Sources;

/// <summary>
/// ETW 数据源：订阅内核网络事件，按 payload PID 聚合 TCP/UDP 收发字节。
///
/// 关键规则（见 docs/技术选型.md 第 1 节）：
/// 1. 用事件 payload 的 PID，不能用事件头 PID —— TraceEvent 的 KernelTraceEventParser
///    已在 FixupData 中把 payload PID 写回 ProcessID，故 <c>data.ProcessID</c> 即为 payload PID。
/// 2. 忽略 "Protocol copied data on behalf of user"（Event ID 18，TcpIpTCPCopy / TcpIpTCPCopyIPV6），
///    它与 Data received 是同一批数据的两次观察，累加会导致下载量翻倍。
/// 3. 重传事件单独累计，不混入应用上传量。
///
/// 进程身份键 = PID + 进程启动时间：PID 被复用时清零重计，避免历史流量算到新进程头上。
/// 回调内只做累加；进程名/启动时间解析与字典清理都在快照线程完成。
/// </summary>
public sealed class EtwSnapshotSource : ISnapshotSource, IDisposable
{
    /// <summary>连续多少帧（约每秒一帧）无流量且进程已退出后，从字典移除该 PID。</summary>
    private const int PruneAfterSnapshots = 30;

    private const string SessionName = "NetPeek.Collector";

    private readonly ILogger<EtwSnapshotSource> _logger;
    private readonly ProcessMetadataCache _metadata;
    private readonly ProcessIconCache _icons;
    private readonly long _sessionStartedUnixMs;
    private readonly ConcurrentDictionary<uint, ProcessCounter> _counters = new();

    private TraceEventSession? _session;
    private Thread? _processThread;
    private volatile bool _started;
    private volatile bool _paused;
    private volatile bool _disposed;

    // 暂停状态的读-改-写需原子完成，否则并发的 toggle 命令会互相抵消。
    private readonly object _pauseGate = new();

    // ETW 启动失败的自动重试：系统启动早期抢跑、其他分析工具占用内核会话等
    // 瞬时失败只需低频重试即可自愈，不必重启整个服务。
    private const int RetryIntervalMs = 30_000;
    private Timer? _retryTimer;

    // EventsLost 是累计值且变化不频繁，无需每帧查询会话；缓存最近一次读数，按间隔刷新。
    private int _cachedEventsLost;
    private long _lastEventsLostReadMs;

    public bool IsPaused => _paused;

    public void Pause() => SetPaused(true);

    public void Resume() => SetPaused(false);

    public bool TogglePause()
    {
        lock (_pauseGate)
        {
            return SetPausedLocked(!_paused);
        }
    }

    private void SetPaused(bool paused)
    {
        lock (_pauseGate)
        {
            SetPausedLocked(paused);
        }
    }

    /// <summary>调用方需持有 <see cref="_pauseGate"/>。返回设置后的暂停状态。</summary>
    private bool SetPausedLocked(bool paused)
    {
        if (_paused == paused)
        {
            return _paused;
        }

        _paused = paused;
        _logger.LogInformation(paused ? "监控已暂停" : "监控已恢复");
        return _paused;
    }

    public EtwSnapshotSource(ILogger<EtwSnapshotSource> logger, ProcessMetadataCache metadata, ProcessIconCache icons)
    {
        _logger = logger;
        _metadata = metadata;
        _icons = icons;
        _sessionStartedUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        StartSession();
    }

    private void StartSession()
    {
        // 声明在 try 外，任一步失败时 catch 都能释放已创建的会话对象（否则内核会话残留）。
        TraceEventSession? session = null;
        try
        {
            // 服务异常退出后可能残留同名会话，不清理的话重启会因会话已存在而失败。
            var residual = TraceEventSession.GetActiveSession(SessionName);
            if (residual != null)
            {
                _logger.LogWarning("检测到残留 ETW 会话，正在停止：{Session}", SessionName);
                residual.Stop();
                residual.Dispose();
            }

            session = new TraceEventSession(SessionName);
            session.EnableKernelProvider(KernelTraceEventParser.Keywords.NetworkTCPIP);

            var parser = new KernelTraceEventParser(session.Source);
            parser.TcpIpSend += OnTcpSend;
            parser.TcpIpRecv += OnTcpRecv;
            parser.UdpIpSend += OnUdpSend;
            parser.UdpIpRecv += OnUdpRecv;
            parser.UdpIpSendIPV6 += OnUdpSendV6;
            parser.UdpIpRecvIPV6 += OnUdpRecvV6;
            parser.TcpIpSendIPV6 += OnTcpSendV6;
            parser.TcpIpRecvIPV6 += OnTcpRecvV6;
            parser.TcpIpRetransmit += OnRetransmit;
            parser.TcpIpRetransmitIPV6 += OnRetransmitV6;
            // 刻意不订阅 TcpIpTCPCopy / TcpIpTCPCopyIPV6（Event ID 18），避免下载量翻倍。

            _session = session;
            _processThread = new Thread(() => session.Source.Process())
            {
                IsBackground = true,
                Name = "NetPeek.ETW",
            };
            _processThread.Start();

            _started = true;
            _retryTimer?.Dispose();
            _retryTimer = null;
            _logger.LogInformation("ETW 会话已启动：{Session}", SessionName);
        }
        catch (Exception ex)
        {
            _started = false;
            _logger.LogError(ex, "ETW 会话启动失败（需要管理员权限），{Seconds} 秒后重试。", RetryIntervalMs / 1000);
            session?.Dispose();
            _session = null;

            // 一次性定时器：每次失败重新排程，成功后清掉。
            if (!_disposed && _retryTimer == null)
            {
                _retryTimer = new Timer(_ => RetryStartSession(), null, RetryIntervalMs, Timeout.Infinite);
            }
        }
    }

    private void RetryStartSession()
    {
        _retryTimer?.Dispose();
        _retryTimer = null;

        if (_disposed || _started)
        {
            return;
        }

        _logger.LogInformation("重试启动 ETW 会话…");
        StartSession();
    }

    private void OnTcpSend(TcpIpSendTraceData data) => Add(data.ProcessID, data.size, isUpload: true);
    private void OnTcpRecv(TcpIpTraceData data) => Add(data.ProcessID, data.size, isUpload: false);
    private void OnUdpSend(UdpIpTraceData data) => Add(data.ProcessID, data.size, isUpload: true);
    private void OnUdpRecv(UdpIpTraceData data) => Add(data.ProcessID, data.size, isUpload: false);
    // 注意：库把 IPv6 UDP 的类名拼成了 UpdIpV6TraceData（少了一个 d），这是 TraceEvent 3.2.6 的既有拼写。
    private void OnUdpSendV6(UpdIpV6TraceData data) => Add(data.ProcessID, data.size, isUpload: true);
    private void OnUdpRecvV6(UpdIpV6TraceData data) => Add(data.ProcessID, data.size, isUpload: false);
    private void OnTcpSendV6(TcpIpV6SendTraceData data) => Add(data.ProcessID, data.size, isUpload: true);
    private void OnTcpRecvV6(TcpIpV6TraceData data) => Add(data.ProcessID, data.size, isUpload: false);
    private void OnRetransmit(TcpIpTraceData data) => AddRetransmit(data.ProcessID, data.size);
    private void OnRetransmitV6(TcpIpV6TraceData data) => AddRetransmit(data.ProcessID, data.size);

    private void Add(int pid, int size, bool isUpload)
    {
        if (_paused || pid <= 0 || size <= 0)
        {
            return;
        }

        var counter = _counters.GetOrAdd((uint)pid, static _ => new ProcessCounter());
        if (isUpload)
        {
            Interlocked.Add(ref counter.UploadTotal, size);
        }
        else
        {
            Interlocked.Add(ref counter.DownloadTotal, size);
        }
    }

    private void AddRetransmit(int pid, int size)
    {
        if (_paused || pid <= 0 || size <= 0)
        {
            return;
        }

        var counter = _counters.GetOrAdd((uint)pid, static _ => new ProcessCounter());
        Interlocked.Add(ref counter.RetransmitTotal, size);
    }

    public TrafficSnapshot GetSnapshot()
    {
        var paused = _paused;
        var snapshot = new TrafficSnapshot
        {
            TimestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Status = !_started ? "error" : (paused ? "paused" : "ok"),
            EventsLost = (ulong)ReadEventsLost(),
            SessionStartedUnixMs = _sessionStartedUnixMs,
        };

        if (!_started)
        {
            return snapshot; // 空进程列表 + error 状态，UI 据此显示“服务异常”。
        }

        var processes = new List<ProcessTraffic>(_counters.Count);
        ulong totalDown = 0, totalUp = 0;

        foreach (var (pid, counter) in _counters)
        {
            long down = Interlocked.Read(ref counter.DownloadTotal);
            long up = Interlocked.Read(ref counter.UploadTotal);

            long downDelta, upDelta;
            if (paused)
            {
                // 暂停时冻结增量：不推进 LastTotal，速率显示 0，但累计值保持。
                // 暂停期间 Add 已短路，计数不会再增长；恢复后增量从冻结点继续。
                downDelta = 0;
                upDelta = 0;
            }
            else
            {
                // 元数据解析与 PID 复用检测放到快照线程，回调内不做进程查询。
                var meta = _metadata.Get(pid);
                if (meta.Alive
                    && counter.StartTimeUtcFileTime != 0
                    && meta.StartTimeUtcFileTime != counter.StartTimeUtcFileTime)
                {
                    _logger.LogInformation("PID {Pid} 被新进程复用，重置计数", pid);
                    Interlocked.Exchange(ref counter.DownloadTotal, 0);
                    Interlocked.Exchange(ref counter.UploadTotal, 0);
                    Interlocked.Exchange(ref counter.RetransmitTotal, 0);
                    down = 0;
                    up = 0;
                }

                counter.StartTimeUtcFileTime = meta.StartTimeUtcFileTime;
                if (!string.IsNullOrEmpty(meta.Name))
                {
                    counter.Name = meta.Name;
                }

                if (!string.IsNullOrEmpty(meta.Path))
                {
                    counter.Path = meta.Path;
                }

                downDelta = down - counter.LastDownloadTotal;
                upDelta = up - counter.LastUploadTotal;
                counter.LastDownloadTotal = down;
                counter.LastUploadTotal = up;

                // 进程已退出且连续多帧无流量时移除，避免字典随会话无限增长。
                if (!meta.Alive && downDelta == 0 && upDelta == 0)
                {
                    if (++counter.StaleFrames >= PruneAfterSnapshots)
                    {
                        _counters.TryRemove(pid, out _);
                        continue;
                    }
                }
                else
                {
                    counter.StaleFrames = 0;
                }
            }

            // 图标内容静态：这里始终填上，由管道层按连接去重后只传首次那一帧。
            var icon = _icons.Get(counter.Path);

            processes.Add(new ProcessTraffic
            {
                Pid = pid,
                Name = counter.Name,
                Path = counter.Path,
                IconId = icon.Id,
                IconBase64 = icon.DataUrl,
                StartTimeUnixMs = counter.StartTimeUtcFileTime > 0
                    ? (counter.StartTimeUtcFileTime - 116444736000000000) / 10000
                    : 0,
                DownloadBytes = (ulong)Math.Max(0, downDelta),
                UploadBytes = (ulong)Math.Max(0, upDelta),
                DownloadTotal = (ulong)down,
                UploadTotal = (ulong)up,
                RetransmitTotal = (ulong)Interlocked.Read(ref counter.RetransmitTotal),
            });

            totalDown += (ulong)Math.Max(0, downDelta);
            totalUp += (ulong)Math.Max(0, upDelta);
        }

        // 按累计流量降序，方便 UI 直接取 Top N。
        processes.Sort(static (a, b) =>
            (b.DownloadTotal + b.UploadTotal).CompareTo(a.DownloadTotal + a.UploadTotal));

        snapshot.TotalDownloadBytes = totalDown;
        snapshot.TotalUploadBytes = totalUp;
        snapshot.Processes = processes;
        return snapshot;
    }

    private int ReadEventsLost()
    {
        // 仅快照线程调用（GetSnapshot 由管道服务端单客户端串行调用），无并发写。
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - _lastEventsLostReadMs < 5000)
        {
            return _cachedEventsLost;
        }

        var session = _session;
        if (session == null)
        {
            return 0;
        }

        try
        {
            var lost = session.EventsLost;
            var value = lost > 0 ? lost : 0;
            _cachedEventsLost = value;
            _lastEventsLostReadMs = now;
            return value;
        }
        catch
        {
            return 0;
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _started = false;

        _retryTimer?.Dispose();
        _retryTimer = null;

        var session = _session;
        _session = null;
        if (session != null)
        {
            try
            {
                session.Stop();
            }
            catch
            {
                // 会话可能已自行退出。
            }

            try
            {
                session.Dispose();
            }
            catch
            {
                // 忽略释放失败。
            }
        }

        var thread = _processThread;
        _processThread = null;
        if (thread != null && thread.IsAlive && thread != Thread.CurrentThread)
        {
            thread.Join(TimeSpan.FromSeconds(2));
        }

        _logger.LogInformation("ETW 会话已停止：{Session}", SessionName);
    }

    /// <summary>每个 PID 的累计计数与快照增量辅助状态。</summary>
    private sealed class ProcessCounter
    {
        // 累计值：由 ETW 回调线程用 Interlocked 更新，快照线程读取。
        public long DownloadTotal;
        public long UploadTotal;
        public long RetransmitTotal;

        // 以下字段仅在快照线程访问（GetSnapshot 单线程调用）。
        public long LastDownloadTotal;
        public long LastUploadTotal;
        public long StartTimeUtcFileTime;
        public string Name = "";
        public string Path = "";
        public int StaleFrames;
    }
}
