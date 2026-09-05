using System.Diagnostics;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 进程元数据缓存：按 PID 提供进程名、完整路径与启动时间。
/// 启动时间用于构造进程身份键（PID + 启动时间），在 PID 被复用时识别出新进程。
/// 带 TTL 缓存，避免每秒对每个 PID 做进程查询；解析失败（进程已退出或无权访问）时标记为不存活。
/// 只在快照线程调用，绝不放进 ETW 回调。
///
/// 两条性能约束：
/// 1. 缓存按「最后访问时间」淘汰——进程退出后 ETW 源会在 30 帧左右剪枝，条目随即不再被访问，
///    超过 <see cref="EvictAfterMs"/> 未访问即视为死数据移除，避免常驻服务字典无界增长。
/// 2. <c>Process.MainModule.FileName</c> 会枚举模块、代价高，而同一进程实例的路径不会变，
///    故仅当「无缓存 / 启动时间变化（PID 复用）」时才重读路径，TTL 刷新只更新便宜的 name/startTime。
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

    private readonly Dictionary<uint, Entry> _cache = new();
    private readonly object _gate = new();
    private readonly long _ttlMs;
    private long _lastSweepMs;

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

        // TTL 到期或首次见到：重新解析（进程查询较贵，放在锁外）。
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
        // 拿旧值用于复用 path（同一进程实例路径不变，避免重读 MainModule）。
        ProcessMeta? cached = null;
        lock (_gate)
        {
            if (_cache.TryGetValue(pid, out var e))
            {
                cached = new ProcessMeta(e.Name, e.Path, e.StartTimeUtcFileTime, e.Alive);
            }
        }

        string name = "";
        string path = "";
        long startTime = 0;
        bool alive = false;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            name = process.ProcessName;
            startTime = process.StartTime.ToUniversalTime().ToFileTimeUtc();
            alive = true;

            // 同一进程实例（启动时间一致）且已有路径时复用，避免每 5s 枚举模块。
            if (cached is { } c && c.StartTimeUtcFileTime == startTime && !string.IsNullOrEmpty(c.Path))
            {
                path = c.Path;
            }
            else
            {
                path = process.MainModule?.FileName ?? "";
            }
        }
        catch
        {
            // 进程已退出，或属于受保护系统进程无法读取：保持 name/path 为空、alive=false。
        }

        return new ProcessMeta(name, path, startTime, alive);
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
}

/// <summary>进程元数据解析结果。</summary>
public readonly record struct ProcessMeta(string Name, string Path, long StartTimeUtcFileTime, bool Alive);
