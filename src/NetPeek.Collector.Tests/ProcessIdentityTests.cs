using System.Diagnostics;
using System.Runtime.InteropServices;
using NetPeek.Collector.Sources;
using Xunit;

namespace NetPeek.Collector.Tests;

/// <summary>
/// 进程身份键的完整性回归。
///
/// 背景（2026-09-21，用户在真实库上发现「近 24 小时」列大面积为空）：
/// 采集端原来用两个来源拼元数据 —— 名字走全系统快照、启动时间走
/// <c>OpenProcess</c> + <c>GetProcessTimes</c>。句柄失败时名字仍能拿到（受保护进程、
/// 或刚好退出的短命进程），但启动时间退化成 0，于是历史库里落下 <c>start_ts=0</c> 的行。
/// 而「近 24 小时」列按 <c>pid:start_ts</c> 查库，0 是个谁也匹配不上的键：
/// 数据在库里、在实时列表里都看得见，唯独那一列永远显示破折号。
/// 实测用户库 97,407 行里有 2,387 行是这样，累计约 5.7 GB（近 24 小时窗口 491 MB）。
///
/// 这些测试直接打真实的系统调用，不做 mock —— 本次 bug 的性质就是「托管 API 的外形
/// 与实际行为不一致」（<c>Process.GetProcesses()</c> 给名字、<c>Process.StartTime</c>
/// 要句柄），用假数据测等于把同一份误解再写一遍。
/// </summary>
public class ProcessIdentityTests
{
    [Fact]
    public void Snapshot_returns_processes_with_start_times()
    {
        var snapshot = SystemProcessSnapshot.Read();

        Assert.NotEmpty(snapshot);

        // 绝大多数进程都该有非零启动时间。允许极少数缺失（枚举与读取之间退出的进程），
        // 但不能是「大面积没有」—— 那说明字段偏移读错了（例如把 CreateTime 读成了别的字段）。
        var total = snapshot.Count;
        var withStartTime = snapshot.Values.Count(v => v.StartTimeUtcFileTime > 0);
        Assert.True(withStartTime > total * 0.9,
            $"快照里应有绝大多数进程带启动时间，实际 {withStartTime}/{total}");

        // 名字也不该整片为空：偏移写错时最典型的表现就是「全空」
        var withName = snapshot.Values.Count(v => !string.IsNullOrEmpty(v.Name));
        Assert.True(withName > total * 0.9,
            $"快照里应有绝大多数进程带名字，实际 {withName}/{total}");
    }

    /// <summary>
    /// 快照给出的启动时间必须与权威来源 <c>GetProcessTimes</c> 一致。
    /// 这是本次修复正确性的核心：偏移猜错时数字看着"像"启动时间（都是大整数），
    /// 只有与权威值逐个比对才能发现。
    /// </summary>
    [Fact]
    public void Snapshot_start_time_matches_GetProcessTimes()
    {
        var snapshot = SystemProcessSnapshot.Read();
        Assert.NotEmpty(snapshot);

        var compared = 0;
        var mismatch = new List<string>();

        foreach (var (pid, entry) in snapshot)
        {
            if (entry.StartTimeUtcFileTime <= 0)
            {
                continue;
            }

            var handle = NativeProbe.OpenProcess(NativeProbe.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (handle == IntPtr.Zero)
            {
                // 开不出句柄的进程没法交叉验证 —— 这恰恰是快照的价值所在（它能覆盖这类进程）。
                continue;
            }

            try
            {
                if (!NativeProbe.GetProcessTimes(handle, out var creation, out _, out _, out _))
                {
                    continue;
                }

                var real = ((long)creation.dwHighDateTime << 32) | (uint)creation.dwLowDateTime;
                compared++;
                if (real != entry.StartTimeUtcFileTime)
                {
                    mismatch.Add($"pid={pid} name={entry.Name} snapshot={entry.StartTimeUtcFileTime} real={real}");
                }
            }
            finally
            {
                NativeProbe.CloseHandle(handle);
            }
        }

        Assert.True(compared > 0, "至少要能交叉验证一个进程，否则这个测试没测到东西");
        Assert.True(mismatch.Count == 0,
            $"快照启动时间与 GetProcessTimes 不一致 {mismatch.Count}/{compared} 条：{string.Join("; ", mismatch.Take(5))}");
    }

    /// <summary>
    /// 元数据缓存必须给每个进程一个非零启动时间 —— 这是 <c>start_ts=0</c> 不再产生的保证。
    /// 跳过已退出的进程：那类进程在任何实现下都拿不到启动时间，属于不可避免的缺失。
    /// </summary>
    [Fact]
    public void MetadataCache_gives_live_processes_a_start_time()
    {
        var cache = new ProcessMetadataCache();
        var self = (uint)Environment.ProcessId;

        var meta = cache.Get(self);
        Assert.True(meta.StartTimeUtcFileTime > 0,
            "自己的启动时间必须拿得到（这是身份键的组成，为 0 就会落进 start_ts=0 的坑）");
        Assert.False(string.IsNullOrEmpty(meta.Name), "自己的进程名不该为空");

        // 抽查一批真实进程：只要是活着的，就该拿到非零启动时间。
        var missing = new List<string>();
        var checkedCount = 0;
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                var pid = (uint)p.Id;
                if (pid <= 4)
                {
                    continue;
                }

                var m = cache.Get(pid);
                if (!m.Alive)
                {
                    // 进程已退出：拿不到启动时间是可接受的（本来就没有身份可言）。
                    continue;
                }

                checkedCount++;
                if (m.StartTimeUtcFileTime <= 0)
                {
                    missing.Add($"{p.ProcessName}({pid})");
                }
            }
            finally
            {
                p.Dispose();
            }
        }

        Assert.True(checkedCount > 0, "至少要检查到一个存活进程");
        Assert.True(missing.Count == 0,
            $"存活进程中有 {missing.Count}/{checkedCount} 个拿不到启动时间（会落成 start_ts=0）："
            + string.Join(", ", missing.Take(5)));
    }

    /// <summary>
    /// 句柄拿不到时的兜底路径必须给出**非零**启动时间。
    ///
    /// 这条测试存在的理由很具体：以管理员身份运行时 <c>OpenProcess</c> 在本机不会失败，
    /// 于是 Fetch 里那条 <c>handle == IntPtr.Zero</c> 分支永远走不到 ——
    /// 把它改回「启动时间返回 0」（即修复前的行为）时，其余测试全部通过，
    /// bug 却已经回来了。所以这里直接打抽出来的 <c>ResolveWithoutHandle</c>。
    ///
    /// 用一个真实存活的 PID 调用它：快照查得到这个 PID，就该给出与
    /// <c>GetProcessTimes</c> 一致的启动时间，而不是 0。
    /// </summary>
    [Fact]
    public void ResolveWithoutHandle_still_yields_a_start_time()
    {
        var cache = new ProcessMetadataCache();
        var self = (uint)Environment.ProcessId;

        // 反射调用私有方法：它的可测性正是本次重构的目的（见方法注释）。
        var resolve = typeof(ProcessMetadataCache).GetMethod(
            "ResolveWithoutHandle",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;

        var meta = (ProcessMeta)resolve.Invoke(cache, [self, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()])!;

        Assert.True(meta.StartTimeUtcFileTime > 0,
            "句柄拿不到时启动时间必须退回快照，不能是 0 —— 0 会让历史库里那一行"
            + "永远匹配不上「近 24 小时」列（这正是本次修的 bug）");
        Assert.False(string.IsNullOrEmpty(meta.Name), "兜底路径也要尽量给出名字");
        Assert.False(meta.Alive, "走兜底路径说明句柄没开出来，按不存活处理");
    }

    /// <summary>不存在的 PID：快照里没有它，兜底如实返回 0（而不是编一个数）。</summary>
    [Fact]
    public void ResolveWithoutHandle_unknown_pid_yields_zero()
    {
        var cache = new ProcessMetadataCache();
        var resolve = typeof(ProcessMetadataCache).GetMethod(
            "ResolveWithoutHandle",
            System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;

        // 快照里绝不会有这个 PID（uint 上限附近，系统 PID 远小于它）
        var meta = (ProcessMeta)resolve.Invoke(
            cache, [uint.MaxValue - 1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()])!;

        Assert.Equal(0, meta.StartTimeUtcFileTime);
    }

    /// <summary>探测用的最小 P/Invoke 集合；只服务于本测试的交叉验证。</summary>
    private static class NativeProbe
    {
        internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetProcessTimes(
            IntPtr handle, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);

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
