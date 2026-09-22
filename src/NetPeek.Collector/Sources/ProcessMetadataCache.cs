using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 进程元数据缓存：按 PID 提供进程名、完整路径与启动时间。
/// 启动时间用于构造进程身份键（PID + 启动时间），在 PID 被复用时识别出新进程。
/// 带 TTL 缓存，避免每秒对每个 PID 做进程查询；解析失败（进程已退出或无权访问）时标记为不存活。
/// 只在快照线程调用，绝不放进 ETW 回调。
///
/// **为什么不再用 <c>Process.GetProcessById</c> + <c>MainModule.FileName</c>**（原实现，
/// 是启动卡顿的主因：实测单 PID 11.2ms，首帧几十上百个 PID 就是好几秒的同步阻塞）：
/// 1. <c>GetProcessById</c> 不是按 PID 定点查询。它调 <c>NtProcessInfoHelper.GetProcessInfos()</c>
///    拉一份**全系统**进程快照来校验 PID 是否存在，<c>ProcessName</c> 也从同一份快照取。
///    查 N 个 PID 就是 N 次全系统快照，复杂度 O(N × 系统进程总数)。
/// 2. <c>MainModule</c> 走 <c>EnumProcessModulesEx(LIST_MODULES_ALL)</c> 枚举目标进程的**全部**
///    模块只为拿第 0 个，且要求 PROCESS_QUERY_INFORMATION | PROCESS_VM_READ 这种偏重的权限。
///    受保护进程／系统进程直接失败，失败后运行时进入 EnumProcessModulesUntilSuccess，
///    用 Thread.Sleep(1) 最多重试约 50 次 —— 单个拿不到路径的 PID 就烧掉约 50ms，且串行。
///    MSDN 亦注明 EnumProcessModules「主要供调试器使用」。
///
/// 现在分两条路各取所需：
/// - **进程名**来自一次 <see cref="Process.GetProcesses"/> 快照（内部一次 NtQuerySystemInformation），
///   带 2s TTL 摊给本帧所有 PID，摊掉上面第 1 点。
/// - **路径 + 启动时间**共用一个 OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) 句柄，
///   分别由 QueryFullProcessImageNameW 与 GetProcessTimes 取。单次内核调用、不读虚拟内存、
///   不走模块表、没有重试循环。刻意不给全机进程都算启动时间 —— 只有 ETW 见过流量的
///   PID 才会走到这里（通常几十个，远少于全机三百多个）。
///
/// 实测同一批 372 个 PID：旧路径 7350ms／拿到 345 条路径，新路径 45ms／拿到 367 条路径。
/// 快约 160 倍，且路径反而更全 —— PROCESS_QUERY_LIMITED_INFORMATION 权限更小，
/// 在受保护进程上的成功率高于 MainModule 需要的 PROCESS_VM_READ。
///
/// 两条性能约束（沿用原设计）：
/// 1. 缓存按「最后访问时间」淘汰——进程退出后 ETW 源会在 30 帧左右剪枝，条目随即不再被访问，
///    超过 <see cref="EvictAfterMs"/> 未访问即视为死数据移除，避免常驻服务字典无界增长。
/// 2. 同一进程实例的路径不会变，故仅当「无缓存 / 启动时间变化（PID 复用）」时才重取路径。
///
/// **事件溯源的身份表（2026-09-22）**：上面两条路都是「事后」补元数据 —— 在每秒的快照线程上
/// 才去查一个 PID。可只活几百毫秒的进程（curl / git-remote-http / node 一次性脚本）到那时早退了，
/// 句柄开不出来、全系统快照里也没有它，于是名字空、start_ts 退回 0（历史库里半数实例都这样）。
/// 治本的办法是「进程创建那一刻」就把身份记下来：<see cref="RecordStart"/> 由 ETW 内核 Process
/// 事件（ProcessStart / ProcessDCStart 见 EtwSnapshotSource）驱动，此刻进程还活着，句柄几乎必开成功，
/// 拿到的启动时间与旧路径同源（GetProcessTimes FILETIME），名字同口径（去扩展名）。
/// 这张 <see cref="_identities"/> 表在 <see cref="Get"/> 里**优先命中**；进程退出（RecordStop）后
/// 保留一段宽限期（<see cref="IdentityGraceMs"/>）再清，让迟到的网络帧仍能查到身份。
/// 旧的句柄/快照两条路降为「Process 事件没覆盖到的 PID」（会话启动 rundown 前的窗口、或事件丢失）的兜底，
/// 所以原有测试（直接构造缓存、不喂 Process 事件）行为不变。
/// </summary>
public sealed class ProcessMetadataCache
{
    private sealed record Entry(
        string Name,
        string Path,
        long StartTimeUtcFileTime,
        bool Alive,
        long FetchedTimestampMs,
        long LastAccessMs);

    /// <summary>条目超过该时长未被访问即从缓存移除（毫秒）。</summary>
    private const long EvictAfterMs = 60_000;

    /// <summary>两次全量清理之间的最小间隔（毫秒），避免每帧都做 O(n) 扫描。</summary>
    private const long SweepIntervalMs = 30_000;

    /// <summary>
    /// 全系统进程名索引的有效期（毫秒）。比 TTL 略短，保证条目 TTL 到期重取时索引也是新的；
    /// 新进程最多晚 2s 拿到名字（它的流量统计不受影响，只是名字先空着）。
    /// </summary>
    private const long NameIndexTtlMs = 2_000;

    /// <summary>进程退出后身份在表里保留多久（毫秒），让迟到的网络帧仍能查到。</summary>
    private const long IdentityGraceMs = 60_000;

    /// <summary>身份表两次清理的最小间隔（毫秒）。</summary>
    private const long IdentitySweepIntervalMs = 30_000;

    private readonly Dictionary<uint, Entry> _cache = new();
    private readonly object _gate = new();
    private readonly long _ttlMs;
    private long _lastSweepMs;

    /// <summary>
    /// 事件溯源的进程身份表：PID → 在进程创建那一刻抓下的身份（见 <see cref="RecordStart"/>）。
    /// ETW 回调线程写（RecordStart/RecordStop）、快照线程读（Get），用并发字典免锁。
    /// StoppedAtMs=0 表示还在跑；非 0 是退出时刻，超过 <see cref="IdentityGraceMs"/> 后清理。
    /// </summary>
    private readonly ConcurrentDictionary<uint, IdentityEntry> _identities = new();
    private long _lastIdentitySweepMs;

    private sealed record IdentityEntry(string Name, string Path, long StartTimeUtcFileTime, long StoppedAtMs);

    // PID → (名字, 启动时间)。只在快照线程访问（Get 由 GetSnapshot 串行调用），无需锁：
    // 它不承担跨线程可见性，纯粹是「一帧内多个 PID 共享一次系统快照」的缓存。
    // 两者同源是刻意的：名字和启动时间必须来自**同一次**快照，否则会拼出一个
    // 「A 进程的名字 + B 进程的启动时间」的身份键（PID 复用窗口内）。原来的实现正是
    // 名字走快照、启动时间走句柄，两条路不一致时就会产生 start_ts=0 的孤儿行。
    private Dictionary<uint, (string Name, long StartTimeUtcFileTime)> _snapshot = new();
    private long _snapshotAtMs;

    public ProcessMetadataCache(TimeSpan? ttl = null)
    {
        _ttlMs = (long)(ttl ?? TimeSpan.FromSeconds(5)).TotalMilliseconds;
    }

    /// <summary>
    /// 由 ETW 内核 Process 事件（ProcessStart / ProcessDCStart）在进程创建/枚举时调用，
    /// 把身份抓进 <see cref="_identities"/> 表。此刻进程还活着，句柄几乎必开成功 ——
    /// 拿到权威启动时间（GetProcessTimes，与旧路径同源，历史键不会漂）与完整路径；
    /// 万一句柄失败（那一瞬就退了 / 受保护进程），退回事件时间戳 + 事件里的镜像名。
    /// PID 复用时后一次 RecordStart 覆盖前一条（新身份、新启动时间），EtwSnapshotSource
    /// 侧的复用检测据此重置计数。
    /// </summary>
    public void RecordStart(uint pid, string imageFileName, DateTime eventTimeUtc)
    {
        // PID 0/4 是 Idle/System 伪进程，不产生网络事件，不必记。
        if (pid <= 4)
        {
            return;
        }

        string name;
        var path = string.Empty;
        long startTime = 0;

        var handle = NativeMethods.OpenProcess(NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle != IntPtr.Zero)
        {
            try
            {
                startTime = QueryStartTime(handle);
                path = QueryImagePath(handle);
            }
            finally
            {
                NativeMethods.CloseHandle(handle);
            }
        }

        name = path.Length > 0 ? NameFromImage(path) : NameFromImage(imageFileName);
        if (startTime == 0)
        {
            // 句柄没开出来（或 GetProcessTimes 罕见失败）：用事件时间当启动时间。
            // 这是本次要消灭的 start_ts=0 的替代 —— 值可能与真实创建时间差几毫秒，
            // 但只要它对这个实例恒定就不会裂行；且它非零，能匹配上历史键。
            startTime = ToFileTimeUtc(eventTimeUtc);
        }

        _identities[pid] = new IdentityEntry(name, path, startTime, 0);
        SweepIdentities(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    /// <summary>
    /// 由 ETW ProcessStop 事件调用：标记退出时刻，进入宽限期。不立即删除 ——
    /// 采集端还会再画这个进程约 30 帧（等它连续无流量才剪枝），期间仍要能查到身份。
    /// </summary>
    public void RecordStop(uint pid)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (_identities.TryGetValue(pid, out var e) && e.StoppedAtMs == 0)
        {
            _identities[pid] = e with { StoppedAtMs = now };
        }
    }

    public ProcessMeta Get(uint pid)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        // 事件溯源的身份表优先：它在进程「创建那一刻」就抓下了名字/路径/启动时间，
        // 覆盖短命进程（句柄事后开不出来、快照里也没有的那些）。见 RecordStart。
        if (_identities.TryGetValue(pid, out var id))
        {
            // StoppedAtMs 非 0 = 已收到退出事件，按不存活报（采集端据此剪枝）。
            return new ProcessMeta(id.Name, id.Path, id.StartTimeUtcFileTime, id.StoppedAtMs == 0);
        }

        lock (_gate)
        {
            if (_cache.TryGetValue(pid, out var entry))
            {
                // 刷新最后访问时间，供淘汰判断。
                _cache[pid] = entry with { LastAccessMs = now };
                if (now - entry.FetchedTimestampMs < _ttlMs)
                {
                    return new ProcessMeta(entry.Name, entry.Path, entry.StartTimeUtcFileTime, entry.Alive);
                }

                // TTL 到期：落在锁外重新解析，避免锁内做进程查询。
            }
        }

        // TTL 到期或首次见到：重新解析（放在锁外）。
        var meta = Fetch(pid, now);
        lock (_gate)
        {
            _cache[pid] = new Entry(meta.Name, meta.Path, meta.StartTimeUtcFileTime, meta.Alive, now, now);
            SweepLocked(now);
        }
        return meta;
    }

    private ProcessMeta Fetch(uint pid, long now)
    {
        // 拿旧值用于复用 path（同一进程实例路径不变）。
        ProcessMeta? cached = null;
        lock (_gate)
        {
            if (_cache.TryGetValue(pid, out var e))
            {
                cached = new ProcessMeta(e.Name, e.Path, e.StartTimeUtcFileTime, e.Alive);
            }
        }

        // 一个句柄同时问出启动时间与路径。拿不到句柄就是进程已退出或权限不足，
        // 此时仍可能有名字（名字来自全局快照，不需要句柄）—— 保留名字、标记不存活。
        var handle = NativeMethods.OpenProcess(
            NativeMethods.PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            pid);
        if (handle == IntPtr.Zero)
        {
            return ResolveWithoutHandle(pid, now);
        }

        try
        {
            var startTime = QueryStartTime(handle);

            // 同一进程实例（启动时间一致）且已有路径时复用，省掉一次路径查询。
            var path = cached is { } c
                && c.StartTimeUtcFileTime == startTime
                && !string.IsNullOrEmpty(c.Path)
                    ? c.Path
                    : QueryImagePath(handle);

            // 句柄开成功即视为存活。名字取自全局快照；快照比句柄旧时可能还没有这个
            // 新进程，路径的文件名兜底，免得 UI 上出现一行「有流量但没名字」。
            var name = NameOf(pid, now);
            if (name.Length == 0 && path.Length > 0)
            {
                name = System.IO.Path.GetFileNameWithoutExtension(path);
            }

            // 内核伪进程（PID 4 = System）：句柄能开出启动时间、但 QueryFullProcessImageName
            // 返回空、全系统快照又刻意跳过 pid<=4，于是名字空 —— UI 会把它显示成「(系统/未归因)」。
            // 它其实是 System 进程的真实内核态流量（SMB/文件共享/驱动/内核发起或延迟归属的连接），
            // 给它固定名字才是正确归因。见 WellKnownName。
            if (name.Length == 0)
            {
                name = WellKnownName(pid);
            }

            return new ProcessMeta(name, path, startTime, true);
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    /// <summary>
    /// 拿不到进程句柄时的元数据解析：**启动时间退回全系统快照**。
    ///
    /// 这条分支是 2026-09-21 修的数据丢失 bug 的正身。原来这里硬把启动时间写成 0，
    /// 于是「句柄开不出来、但名字拿得到」的进程（受保护进程如杀软/反作弊、服务，
    /// 或 ETW 回调与 OpenProcess 之间刚好退出的短命进程）会带着 <c>start_ts=0</c>
    /// 落进历史库。而「近 24 小时」列是按 <c>pid:start_ts</c> 查库的，0 是个
    /// 谁也匹配不上的键：那一行在实时列表里看得见、字节数也真实落盘了，
    /// 两边的键却对不上，于是那一列永远是破折号 —— 用户报的「数据有损失」正是这个。
    /// 实测用户库 97,407 行里有 2,387 行是 start_ts=0、累计约 5.7 GB
    ///（其中 539 行有名字，即本条分支的产物）。
    ///
    /// 快照不按进程开句柄，所以它能覆盖句柄失败的那些进程。句柄成功时仍以
    /// <c>GetProcessTimes</c> 为准（那是权威值，且能顺带拿到路径）。
    ///
    /// 抽成独立方法是为了可测：以管理员身份运行时这条分支在本机永远走不到
    ///（OpenProcess 不会失败），留在 Fetch 里就等于没有回归覆盖 ——
    /// 注入「启动时间返回 0」这种回退改动时，测试全绿但 bug 已经回来了。
    /// </summary>
    private ProcessMeta ResolveWithoutHandle(uint pid, long now)
    {
        var name = NameOf(pid, now);
        if (name.Length == 0)
        {
            // 内核伪进程兜底名（PID 4 = System / PID 0 = System Idle Process）：
            // 它们不在全系统快照里（快照跳过 pid<=4），句柄也可能开不出来。见 WellKnownName。
            name = WellKnownName(pid);
        }

        return new ProcessMeta(
            name,
            "",
            StartTimeFromSnapshot(pid, now),
            false);
    }

    /// <summary>
    /// Windows 固定的内核伪进程名。这些 PID 恒定、不由普通进程枚举/句柄命名，
    /// 却会承担真实的内核态网络 I/O（尤其 System=4：SMB、http.sys、驱动、内核发起或
    /// 延迟归属的连接）。不给名字就会掉进 UI 的「(系统/未归因)」——那是「归因失败」的语义，
    /// 与事实（明确归属于 System 内核）相反。netstat / TCPView / 任务管理器同样把 PID 4 记作 System。
    ///
    /// 只列这两个固定 PID：Registry / Memory Compression / Secure System 这些「最小进程」
    /// 的 PID 是动态的、且都在全系统快照里带名字，正常路径就能拿到，不需要在这里特判。
    /// </summary>
    private static string WellKnownName(uint pid) => pid switch
    {
        4 => "System",
        0 => "System Idle Process",
        _ => string.Empty,
    };

    /// <summary>从全系统进程快照取名字，快照过期时重建。</summary>
    private string NameOf(uint pid, long now)
    {
        EnsureSnapshot(now);
        return _snapshot.TryGetValue(pid, out var e) ? e.Name : "";
    }

    /// <summary>
    /// 从全系统进程快照取启动时间（UTC FILETIME），快照过期时重建。
    /// 句柄路径拿不到启动时间时的兜底 —— 见 <see cref="ResolveWithoutHandle"/>。
    /// </summary>
    private long StartTimeFromSnapshot(uint pid, long now)
    {
        EnsureSnapshot(now);
        return _snapshot.TryGetValue(pid, out var e) ? e.StartTimeUtcFileTime : 0;
    }

    private void EnsureSnapshot(long now)
    {
        if (now - _snapshotAtMs >= NameIndexTtlMs || _snapshot.Count == 0)
        {
            RebuildSnapshot(now);
        }
    }

    /// <summary>
    /// 重建 PID → (名字, 启动时间) 索引。
    ///
    /// 2026-09-21 起改用 <see cref="SystemProcessSnapshot"/> 而不是
    /// <c>Process.GetProcesses()</c>：两者底层都是同一次 NtQuerySystemInformation，
    /// 但托管 API 只暴露名字，取启动时间要再开一次句柄（<c>Process.StartTime</c>）——
    /// 而句柄正是受保护进程上会失败的东西，绕回去就等于没修。快照本身就带
    /// CreateTime，一次调用把名字和启动时间一起拿全。
    /// </summary>
    private void RebuildSnapshot(long now)
    {
        var index = SystemProcessSnapshot.Read();
        if (index.Count == 0)
        {
            // 拿不到快照就沿用上一份（哪怕过期）：空手而归会让整帧的名字全丢。
            // 只推进时间戳避免每帧重试式地反复分配大缓冲。
            _snapshotAtMs = now;
            return;
        }

        _snapshot = index;
        _snapshotAtMs = now;
    }

    /// <summary>
    /// 取进程创建时间（UTC FILETIME）。失败返回 0 —— <c>EtwSnapshotSource</c> 的 PID
    /// 复用检测以 <c>StartTimeUtcFileTime != 0</c> 为前提，0 会让它自动跳过该进程。
    /// </summary>
    private static long QueryStartTime(IntPtr handle)
    {
        if (NativeMethods.GetProcessTimes(handle, out var creation, out _, out _, out _))
        {
            // FILETIME 的高低位拼回 long；创建时间本身就是 UTC。
            return ((long)creation.dwHighDateTime << 32) | (uint)creation.dwLowDateTime;
        }

        return 0;
    }

    /// <summary>
    /// 取可执行文件完整路径。句柄由调用方以 PROCESS_QUERY_LIMITED_INFORMATION 打开：
    /// 这是 Vista+ 专为「只问不动」场景加的最小权限，受保护进程也多半给过，
    /// 比 MainModule 需要的 PROCESS_VM_READ 成功率高得多。
    /// 失败（权限不足 / 进程已退出）返回空串，UI 侧回退到通用占位图标。
    /// </summary>
    private static string QueryImagePath(IntPtr handle)
    {
        // MAX_PATH 不够用：\\?\ 前缀的长路径可达 32767。先按 260 试，
        // 只在 ERROR_INSUFFICIENT_BUFFER 时才分配大缓冲，常态不浪费。
        var buffer = new StringBuilder(260);
        var size = buffer.Capacity;
        if (NativeMethods.QueryFullProcessImageName(handle, 0, buffer, ref size))
        {
            return buffer.ToString(0, size);
        }

        if (Marshal.GetLastWin32Error() == NativeMethods.ERROR_INSUFFICIENT_BUFFER)
        {
            buffer = new StringBuilder(32768);
            size = buffer.Capacity;
            if (NativeMethods.QueryFullProcessImageName(handle, 0, buffer, ref size))
            {
                return buffer.ToString(0, size);
            }
        }

        return "";
    }

    /// <summary>按最后访问时间淘汰死条目（进程退出后不再被访问的缓存）。调用方需持锁。</summary>
    private void SweepLocked(long now)
    {
        if (now - _lastSweepMs < SweepIntervalMs)
        {
            return;
        }
        _lastSweepMs = now;

        // 每 30 秒集中清理一次。字典规模通常只有数百，全量扫描开销可忽略。
        var victims = new List<uint>();
        foreach (var (pid, entry) in _cache)
        {
            if (now - entry.LastAccessMs > EvictAfterMs)
            {
                victims.Add(pid);
            }
        }

        foreach (var pid in victims)
        {
            _cache.Remove(pid);
        }
    }

    /// <summary>
    /// 从镜像名/路径取显示名：去目录、去扩展名。与旧路径的名字口径一致
    /// （历史库里 99 个名字无一带 .exe），保证同一应用不会因为「node」vs「node.exe」裂成两行。
    /// ETW 事件里的镜像名可能是裸名（curl.exe）、NT 设备路径或普通路径，GetFileNameWithoutExtension 都能收敛。
    /// </summary>
    private static string NameFromImage(string image)
    {
        if (string.IsNullOrEmpty(image))
        {
            return string.Empty;
        }

        try
        {
            var n = System.IO.Path.GetFileNameWithoutExtension(image);
            return string.IsNullOrEmpty(n) ? image : n;
        }
        catch
        {
            // 非法路径字符：退回原串，总比空名强。
            return image;
        }
    }

    /// <summary>
    /// 事件时间戳 → UTC FILETIME，与句柄路径的启动时间同口径。ETW 事件的 DateTime.Kind
    /// 通常是 Local，统一按 UTC 转。转换失败（越界时间）时退回「现在」—— 决不能返回 0，
    /// 那正是本次要消灭的坑（0 在历史库里谁也匹配不上）。
    /// </summary>
    private static long ToFileTimeUtc(DateTime dt)
    {
        try
        {
            var utc = dt.Kind == DateTimeKind.Utc ? dt : dt.ToUniversalTime();
            var ft = utc.ToFileTimeUtc();
            return ft > 0 ? ft : DateTime.UtcNow.ToFileTimeUtc();
        }
        catch
        {
            return DateTime.UtcNow.ToFileTimeUtc();
        }
    }

    /// <summary>清理已退出且超过宽限期的身份条目。只从 RecordStart 调用（ETW 回调线程），按间隔限流。</summary>
    private void SweepIdentities(long now)
    {
        if (now - _lastIdentitySweepMs < IdentitySweepIntervalMs)
        {
            return;
        }
        _lastIdentitySweepMs = now;

        foreach (var (pid, e) in _identities)
        {
            if (e.StoppedAtMs != 0 && now - e.StoppedAtMs > IdentityGraceMs)
            {
                _identities.TryRemove(pid, out _);
            }
        }
    }

    private static class NativeMethods
    {
        internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        internal const int ERROR_INSUFFICIENT_BUFFER = 122;

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(
            uint processAccess,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandle,
            uint processId);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool QueryFullProcessImageName(
            IntPtr process,
            uint flags,
            StringBuilder exeName,
            ref int size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetProcessTimes(
            IntPtr process,
            out FILETIME creation,
            out FILETIME exit,
            out FILETIME kernel,
            out FILETIME user);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        internal struct FILETIME
        {
            public int dwLowDateTime;
            public int dwHighDateTime;
        }
    }
}

/// <summary>进程元数据解析结果。</summary>
public readonly record struct ProcessMeta(string Name, string Path, long StartTimeUtcFileTime, bool Alive);
