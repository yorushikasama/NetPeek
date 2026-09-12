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

    /// <summary>ETW 会话的启动状态。见 <see cref="_state"/>。</summary>
    private enum SessionState
    {
        /// <summary>会话正在后台启动（含残留会话清理），还没开始收事件。</summary>
        Starting = 0,

        /// <summary>会话已就绪，正在收事件。</summary>
        Running = 1,

        /// <summary>启动失败或事件线程异常退出（通常是缺管理员权限）。</summary>
        Failed = 2,
    }

    private TraceEventSession? _session;
    private Thread? _processThread;
    private Thread? _startThread;

    /// <summary>
    /// 会话状态。启动线程写一次，快照线程每帧读；底层是 int，volatile 保证可见性。
    /// </summary>
    private volatile SessionState _state = SessionState.Starting;

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

        // 会话启动放后台线程：EnableKernelProvider 与残留会话清理都是同步内核调用，
        // 实测合计 0.3–2.4 s（清理残留那次最慢）。放在构造函数里就是把这段时间挂在
        // DI 容器建 singleton 的路径上 —— Host.Run() 要等它，管道也就跟着晚开，
        // UI 在这期间连不上管道，表现成「刚启动那几秒卡住」。
        // 改成后台起：管道立刻开始监听，UI 马上连上并收到 Status="starting" 的帧，
        // 界面显示「正在启动采集」而不是干等。会话就绪后下一帧自动转 ok。
        _startThread = new Thread(StartSession)
        {
            IsBackground = true,
            Name = "NetPeek.ETW.Start",
        };
        _startThread.Start();
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

            // 建会话期间可能已经 Dispose 了（服务启动到立刻停止、或启动超过 Dispose
            // 的 3s join 上限）。此时 Dispose 早已把 _session 读空走人，这个会话没人
            // 会再去停 —— ETW 会话是内核对象，进程退出也不消失，会以残留会话留到
            // 下次启动。所以在赋值前自查一次，是自己建的就自己拆掉，别赋值也别起线程。
            if (_disposed)
            {
                session.Stop();
                session.Dispose();
                return;
            }

            _session = session;
            _processThread = new Thread(() => ProcessEvents(session))
            {
                IsBackground = true,
                Name = "NetPeek.ETW",
            };
            _processThread.Start();

            _state = SessionState.Running;
            _logger.LogInformation("ETW 会话已启动：{Session}", SessionName);
        }
        catch (Exception ex)
        {
            _state = SessionState.Failed;
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
            _state = SessionState.Failed;
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
        var state = _state;
        var snapshot = new TrafficSnapshot
        {
            TimestampUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            // starting 与 error 必须分开：会话在后台起（含残留清理，实测 0.3–2.4s），
            // 这段窗口里没有事件可报，但那不是故障。都报 error 会让 UI 在每次启动的
            // 头几秒稳定显示「服务异常 · 需管理员权限」——一句与事实相反的错误播报。
            Status = state switch
            {
                SessionState.Running => paused ? "paused" : "ok",
                SessionState.Starting => "starting",
                _ => "error",
            },
            EventsLost = (ulong)ReadEventsLost(),
            SessionStartedUnixMs = _sessionStartedUnixMs,
        };

        if (state != SessionState.Running)
        {
            // 空进程列表：starting 时还没有事件，error 时采集已停。
            return snapshot;
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

            // 图标增量下发：路径首次出现时下发一次，之后不再重复；未下发过的帧不带
            // 任何图标数据，免得每秒把几十 KB 的 base64 沿管道搬四个来回。
            //
            // 提取是异步的（见 ProcessIconCache）：TryGetDataUrl 拿不到就说明后台还没
            // 提完，本帧跳过、下一帧再问。**必须等真正拿到才记进 _iconPathsSent** ——
            // 先标记再提取的话，未就绪的那一次就把路径永久标成「已发送」，这个图标
            // 再也不会下发，UI 上那一行就永远是首字母占位牌。
            if (!string.IsNullOrEmpty(counter.Path)
                && !_iconPathsSent.Contains(counter.Path)
                && _icons.TryGetDataUrl(counter.Path, out var icon))
            {
                _iconPathsSent.Add(counter.Path);
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
        _state = SessionState.Failed;

        // 必须先等启动线程收工，再去停会话。会话现在是后台建的，如果这里先把
        // _session 读空、启动线程随后才 new TraceEventSession 并赋值，那个会话就
        // 没人停了 —— ETW 会话是内核对象，进程退出也不会自动消失，只会以「残留
        // 会话」的形式留到下次启动（StartSession 开头那段清理正是为它准备的）。
        // _disposed 已置位，启动线程建完会自查并自行拆掉，这里只需等它走完。
        var starter = _startThread;
        _startThread = null;
        if (starter != null && starter.IsAlive && starter != Thread.CurrentThread)
        {
            starter.Join(TimeSpan.FromSeconds(3));
        }

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
