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

    private readonly Dictionary<uint, Entry> _cache = new();
    private readonly object _gate = new();
    private readonly long _ttlMs;
    private long _lastSweepMs;

    // PID → 进程名索引。只在快照线程访问（Get 由 GetSnapshot 串行调用），无需锁：
    // 它不承担跨线程可见性，纯粹是「一帧内多个 PID 共享一次系统快照」的缓存。
    private Dictionary<uint, string> _nameIndex = new();
    private long _nameIndexAtMs;

    public ProcessMetadataCache(TimeSpan? ttl = null)
    {
        _ttlMs = (long)(ttl ?? TimeSpan.FromSeconds(5)).TotalMilliseconds;
    }

    public ProcessMeta Get(uint pid)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

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
            var deadName = NameOf(pid, now);
            return new ProcessMeta(deadName, "", 0, false);
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

            return new ProcessMeta(name, path, startTime, true);
        }
        finally
        {
            NativeMethods.CloseHandle(handle);
        }
    }

    /// <summary>从全系统进程名索引取名字，索引过期时重建。</summary>
    private string NameOf(uint pid, long now)
    {
        if (now - _nameIndexAtMs >= NameIndexTtlMs || _nameIndex.Count == 0)
        {
            RebuildNameIndex(now);
        }

        return _nameIndex.TryGetValue(pid, out var name) ? name : "";
    }

    /// <summary>
    /// 重建 PID → 进程名索引。<see cref="Process.GetProcesses"/> 内部是一次
    /// NtQuerySystemInformation，名字直接来自那份快照，不需要按进程开句柄。
    /// </summary>
    private void RebuildNameIndex(long now)
    {
        Process[] all;
        try
        {
            all = Process.GetProcesses();
        }
        catch
        {
            // 拿不到快照就沿用上一份（哪怕过期）：空手而归会让整帧的名字全丢。
            _nameIndexAtMs = now;
            return;
        }

        var index = new Dictionary<uint, string>(all.Length + 32);
        foreach (var p in all)
        {
            try
            {
                index[(uint)p.Id] = p.ProcessName;
            }
            catch
            {
                // 单个进程读名字失败（枚举与读取之间退出）不影响整份索引。
            }
            finally
            {
                p.Dispose();
            }
        }

        _nameIndex = index;
        _nameIndexAtMs = now;
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
