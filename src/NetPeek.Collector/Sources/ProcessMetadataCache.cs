using System.Diagnostics;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 进程元数据缓存：按 PID 提供进程名与启动时间。
/// 启动时间用于构造进程身份键（PID + 启动时间），在 PID 被复用时识别出新进程。
/// 带 TTL 缓存，避免每秒对每个 PID 做进程查询；解析失败（进程已退出或无权访问）时标记为不存活。
/// 只在快照线程调用，绝不放进 ETW 回调。
/// </summary>
public sealed class ProcessMetadataCache
{
    private sealed record Entry(string Name, long StartTimeUtcFileTime, bool Alive, long FetchedTimestampMs);

    private readonly Dictionary<uint, Entry> _cache = new();
    private readonly object _gate = new();
    private readonly long _ttlMs;

    public ProcessMetadataCache(TimeSpan? ttl = null)
    {
        _ttlMs = (long)(ttl ?? TimeSpan.FromSeconds(5)).TotalMilliseconds;
    }

    public ProcessMeta Get(uint pid)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (_gate)
        {
            if (_cache.TryGetValue(pid, out var entry) && now - entry.FetchedTimestampMs < _ttlMs)
            {
                return new ProcessMeta(entry.Name, entry.StartTimeUtcFileTime, entry.Alive);
            }
        }

        string name = "";
        long startTime = 0;
        bool alive = false;
        try
        {
            using var process = Process.GetProcessById((int)pid);
            name = process.ProcessName;
            startTime = process.StartTime.ToUniversalTime().ToFileTimeUtc();
            alive = true;
        }
        catch
        {
            // 进程已退出，或属于受保护系统进程无法读取：保持 name 为空、alive=false。
        }

        lock (_gate)
        {
            _cache[pid] = new Entry(name, startTime, alive, now);
        }

        return new ProcessMeta(name, startTime, alive);
    }
}

/// <summary>进程元数据解析结果。</summary>
public readonly record struct ProcessMeta(string Name, long StartTimeUtcFileTime, bool Alive);
