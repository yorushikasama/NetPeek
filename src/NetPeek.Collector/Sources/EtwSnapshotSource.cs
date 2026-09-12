using System.Collections.Concurrent;
using System.Net;
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

    // 已随 IconUpdates 下发过图标的路径。图标按路径缓存后终生不变，一条路径只发一次；
    // UI 重连时 CollectorService 调 ResetIconStream 清空，下一帧重发全量。
    // 只在快照线程（GetSnapshot）与连接切换间隙访问，二者严格串行。
    private readonly HashSet<string> _iconPathsSent = new(StringComparer.OrdinalIgnoreCase);

    private TraceEventSession? _session;
    private Thread? _processThread;
    private volatile bool _started;
    private volatile bool _paused;
    private volatile bool _disposed;

    // EventsLost 是累计值且变化不频繁，无需每帧查询会话；缓存最近一次读数，按间隔刷新。
    private int _cachedEventsLost;
    private long _lastEventsLostReadMs;

    public bool IsPaused => _paused;

    public void Pause()
    {
        _paused = true;
        _logger.LogInformation("监控已暂停");
    }

    public void Resume()
    {
        _paused = false;
        _logger.LogInformation("监控已恢复");
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

            var session = new TraceEventSession(SessionName);
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
            _processThread = new Thread(() => ProcessEvents(session))
            {
                IsBackground = true,
                Name = "NetPeek.ETW",
            };
            _processThread.Start();

            _started = true;
            _logger.LogInformation("ETW 会话已启动：{Session}", SessionName);
        }
        catch (Exception ex)
        {
            _started = false;
            _logger.LogError(ex, "ETW 会话启动失败（需要管理员权限）。");
            _session?.Dispose();
            _session = null;
        }
    }

    /// <summary>
    /// ETW 事件分发线程入口。session.Source.Process() 是长驻阻塞调用，
    /// 裸调时一旦抛异常就是线程级未捕获异常——直接崩掉整个服务进程，且日志无痕。
    /// 这里兜住并留痕：事后能区分「采集停了」是权限/会话问题还是分发线程炸了。
    /// </summary>
    private void ProcessEvents(TraceEventSession session)
    {
        try
        {
            session.Source.Process();
        }
        catch (Exception ex)
        {
            _started = false;
            _logger.LogError(ex, "ETW 事件线程异常退出，采集已停止");
        }
    }

    // 对端追踪：TCP 发送取目的端（daddr/dport）、接收取源端（saddr/sport）——
    // 「远端」永远是对面的那台机器。IPv6 事件类同名字段同理。
    private void OnTcpSend(TcpIpSendTraceData data) => Add(data.ProcessID, data.size, isUpload: true, data.daddr, data.dport);
    private void OnTcpRecv(TcpIpTraceData data) => Add(data.ProcessID, data.size, isUpload: false, data.saddr, data.sport);
    private void OnUdpSend(UdpIpTraceData data) => Add(data.ProcessID, data.size, isUpload: true, data.daddr, data.dport);
    private void OnUdpRecv(UdpIpTraceData data) => Add(data.ProcessID, data.size, isUpload: false, data.saddr, data.sport);
    // 注意：库把 IPv6 UDP 的类名拼成了 UpdIpV6TraceData（少了一个 d），这是 TraceEvent 3.2.6 的既有拼写。
    private void OnUdpSendV6(UpdIpV6TraceData data) => Add(data.ProcessID, data.size, isUpload: true, data.daddr, data.dport);
    private void OnUdpRecvV6(UpdIpV6TraceData data) => Add(data.ProcessID, data.size, isUpload: false, data.saddr, data.sport);
    private void OnTcpSendV6(TcpIpV6SendTraceData data) => Add(data.ProcessID, data.size, isUpload: true, data.daddr, data.dport);
    private void OnTcpRecvV6(TcpIpV6TraceData data) => Add(data.ProcessID, data.size, isUpload: false, data.saddr, data.sport);
    private void OnRetransmit(TcpIpTraceData data) => AddRetransmit(data.ProcessID, data.size);
    private void OnRetransmitV6(TcpIpV6TraceData data) => AddRetransmit(data.ProcessID, data.size);

    private void Add(int pid, int size, bool isUpload, IPAddress remoteAddr, int remotePort)
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

        TrackEndpoint(counter, remoteAddr, remotePort, size);
    }

    /// <summary>
    /// 对端热度窗口：每个快照周期一个窗口，窗口内按 IP 累计字节，纪录保持者即「对端」。
    /// 只在 ETW 回调线程执行（session.Source.Process() 单线程派发），字典不需要并发保护；
    /// 快照线程只读 TopAddr/TopPort 两个 volatile 值，读完把 WindowId 推进一格，
    /// 本线程下一次事件进来时发现窗口代数不一致就清表重计（读写双方各忍半帧偏差，显示用途可接受）。
    /// IP 直接用 IPAddress 做字典键（避免每事件 ToString 分配），只在刷新纪录时转一次字符串。
    /// </summary>
    private void TrackEndpoint(ProcessCounter counter, IPAddress? remoteAddr, int remotePort, int size)
    {
        if (remoteAddr == null || remotePort <= 0)
        {
            return;
        }

        var windowId = Volatile.Read(ref counter.WindowId);
        if (windowId != counter.LocalWindowId)
        {
            counter.EndpointWindow?.Clear();
            counter.TopBytes = 0;
            counter.TopPort = 0;
            Volatile.Write(ref counter.TopAddr, null);
            counter.LocalWindowId = windowId;
        }

        var window = counter.EndpointWindow ??= new Dictionary<IPAddress, long>();
        window.TryGetValue(remoteAddr, out var bytes);
        bytes += size;
        window[remoteAddr] = bytes;
        if (bytes > counter.TopBytes)
        {
            counter.TopBytes = bytes;
            counter.TopPort = remotePort;
            Volatile.Write(ref counter.TopAddr, remoteAddr);
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
        Dictionary<string, string>? iconUpdates = null;

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

            // 图标增量下发：仅当路径首次出现时提取并放进 IconUpdates（提取较贵，
            // 由 ProcessIconCache 内部缓存兜底）；未下发过的帧不带任何图标数据，
            // 免得每秒把几十 KB 的 base64 沿管道搬四个来回。
            if (!string.IsNullOrEmpty(counter.Path) && _iconPathsSent.Add(counter.Path))
            {
                var icon = _icons.GetDataUrl(counter.Path);
                if (icon.Length > 0)
                {
                    iconUpdates ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    iconUpdates[counter.Path] = icon;
                }
            }

            // 对端：读两个 volatile 值后把窗口推进一格，下一个事件周期自动重计。
            // 只有真正有过事件的进程才有端点；纯空闲行保持为空，UI 显示「—」。
            var topAddr = Volatile.Read(ref counter.TopAddr);
            var topPort = counter.TopPort;
            Interlocked.Increment(ref counter.WindowId);

            processes.Add(new ProcessTraffic
            {
                Pid = pid,
                Name = counter.Name,
                Path = counter.Path,
                IconBase64 = "", // 恒空：图标改由 IconUpdates 增量下发，见上
                StartTimeUnixMs = counter.StartTimeUtcFileTime > 0
                    ? (counter.StartTimeUtcFileTime - 116444736000000000) / 10000
                    : 0,
                DownloadBytes = (ulong)Math.Max(0, downDelta),
                UploadBytes = (ulong)Math.Max(0, upDelta),
                DownloadTotal = (ulong)down,
                UploadTotal = (ulong)up,
                RetransmitTotal = (ulong)Interlocked.Read(ref counter.RetransmitTotal),
                TopRemoteIp = topAddr?.ToString() ?? "",
                TopRemotePort = topPort > 0 ? (ushort)Math.Min(topPort, ushort.MaxValue) : (ushort)0,
            });

            totalDown += (ulong)Math.Max(0, downDelta);
            totalUp += (ulong)Math.Max(0, upDelta);
        }

        // 按累计流量降序，方便 UI 直接取 Top N。
        processes.Sort(static (a, b) =>
            (b.DownloadTotal + b.UploadTotal).CompareTo(a.DownloadTotal + a.UploadTotal));

        snapshot.TotalDownloadBytes = totalDown;
        snapshot.TotalUploadBytes = totalUp;
        snapshot.IconUpdates = iconUpdates; // null = 本帧没有新图标，序列化时省略
        snapshot.Processes = processes;
        return snapshot;
    }

    /// <summary>UI 重连后清空已发记录，让下一帧 IconUpdates 重发全量图标。</summary>
    public void ResetIconStream() => _iconPathsSent.Clear();

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

        // 对端热度窗口（见 TrackEndpoint）：字典与 TopBytes/LocalWindowId 仅 ETW
        // 回调线程访问；TopAddr/TopPort/WindowId 跨线程，走 Volatile / Interlocked。
        public Dictionary<IPAddress, long>? EndpointWindow;
        public long TopBytes;
        public long LocalWindowId;
        public int TopPort;
        public IPAddress? TopAddr;
        public long WindowId;
    }
}
