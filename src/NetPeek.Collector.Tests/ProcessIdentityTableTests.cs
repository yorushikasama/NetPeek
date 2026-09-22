using System.Reflection;
using NetPeek.Collector.Sources;
using Xunit;

namespace NetPeek.Collector.Tests;

/// <summary>
/// 事件溯源身份表的回归（2026-09-22）。
///
/// 背景：短命进程（curl / git-remote-http / node 一次性脚本）在采集端事后去查它时
/// 早已退出，句柄开不出来、全系统快照里也没有，于是名字空、start_ts=0 —— 半数实例都这样。
/// 治本办法是由 ETW 内核 Process 事件在「进程创建那一刻」就把身份抓进
/// <see cref="ProcessMetadataCache.RecordStart"/>，退出时 <see cref="ProcessMetadataCache.RecordStop"/>
/// 进入宽限期。这些测试直接打这两个入口 + <see cref="ProcessMetadataCache.Get"/>，
/// 不依赖真实 ETW 会话（那需要管理员且不可复现），只验身份表本身的取数/覆盖/存活语义。
/// </summary>
public class ProcessIdentityTableTests
{
    [Fact]
    public void RecordStart_captures_live_process_identity()
    {
        var cache = new ProcessMetadataCache();
        var self = (uint)Environment.ProcessId;

        // 自己一定活着：RecordStart 内部开句柄，拿到权威启动时间与路径。
        cache.RecordStart(self, "dummy.exe", DateTime.UtcNow);
        var meta = cache.Get(self);

        Assert.True(meta.Alive, "刚 RecordStart、未 RecordStop → 按存活报");
        Assert.True(meta.StartTimeUtcFileTime > 0, "启动时间应从句柄取到，绝不是 0");
        Assert.False(string.IsNullOrEmpty(meta.Name), "名字应从路径取到");
        Assert.DoesNotContain(".exe", meta.Name); // 与历史库口径一致：名字不带扩展名
    }

    [Fact]
    public void RecordStart_short_lived_falls_back_to_event_time_and_name()
    {
        var cache = new ProcessMetadataCache();
        // 一个开不出句柄的 PID：模拟「网络/进程事件到达时进程已经退出」的短命进程。
        var pid = uint.MaxValue - 1;
        var evt = DateTime.UtcNow;

        cache.RecordStart(pid, @"C:\tools\curl.exe", evt);
        var meta = cache.Get(pid);

        Assert.Equal("curl", meta.Name); // 从事件里的镜像路径收敛出去扩展名的名字
        Assert.Equal(evt.ToFileTimeUtc(), meta.StartTimeUtcFileTime); // 句柄失败 → 退回事件时间
        Assert.NotEqual(0, meta.StartTimeUtcFileTime); // 决不是 0（这正是本次要消灭的坑）
        Assert.True(meta.Alive);
    }

    [Fact]
    public void Identity_table_wins_over_handle_snapshot_fallback()
    {
        var cache = new ProcessMetadataCache();
        var pid = uint.MaxValue - 2; // 不存在的 PID：兜底路径会给空名 + start_ts=0

        // 未记录时：走旧的句柄/快照兜底，未知 PID 如实给 0。
        var before = cache.Get(pid);
        Assert.Equal(0, before.StartTimeUtcFileTime);

        // 记录之后：身份表优先命中，给出名字 + 非零启动时间（哪怕 _cache 里已有那条 0 的兜底）。
        var evt = new DateTime(2026, 9, 22, 1, 2, 3, DateTimeKind.Utc);
        cache.RecordStart(pid, "node.exe", evt);
        var after = cache.Get(pid);

        Assert.Equal("node", after.Name);
        Assert.Equal(evt.ToFileTimeUtc(), after.StartTimeUtcFileTime);
    }

    [Fact]
    public void RecordStop_marks_not_alive_but_keeps_identity_within_grace()
    {
        var cache = new ProcessMetadataCache();
        var pid = uint.MaxValue - 3;
        var evt = DateTime.UtcNow;

        cache.RecordStart(pid, "git-remote-http.exe", evt);
        cache.RecordStop(pid);
        var meta = cache.Get(pid);

        Assert.False(meta.Alive, "RecordStop 后按不存活报（采集端据此剪枝）");
        Assert.Equal("git-remote-http", meta.Name); // 宽限期内身份仍在，迟到的帧还查得到
        Assert.Equal(evt.ToFileTimeUtc(), meta.StartTimeUtcFileTime);
    }

    [Fact]
    public void RecordStart_reuse_overwrites_identity()
    {
        var cache = new ProcessMetadataCache();
        var pid = uint.MaxValue - 4;
        var t1 = new DateTime(2026, 9, 22, 1, 0, 0, DateTimeKind.Utc);
        var t2 = new DateTime(2026, 9, 22, 2, 0, 0, DateTimeKind.Utc);

        cache.RecordStart(pid, "old.exe", t1);
        cache.RecordStop(pid);
        cache.RecordStart(pid, "new.exe", t2); // 同一 PID 被新进程复用

        var meta = cache.Get(pid);
        Assert.Equal("new", meta.Name);
        Assert.Equal(t2.ToFileTimeUtc(), meta.StartTimeUtcFileTime);
        Assert.True(meta.Alive, "复用后是新进程实例，重新存活");
    }

    [Fact]
    public void RecordStart_ignores_pseudo_pids()
    {
        var cache = new ProcessMetadataCache();
        // PID 0（Idle）/ 4（System）不进身份表（RecordStart 跳过 pid<=4）—— Get 走兜底命名。
        cache.RecordStart(0, "Idle", DateTime.UtcNow);
        cache.RecordStart(4, "System", DateTime.UtcNow);
        Assert.NotNull(cache.Get(0).Name);
        Assert.NotNull(cache.Get(4).Name);
    }

    [Fact]
    public void System_process_pid4_is_named_not_unattributed()
    {
        var cache = new ProcessMetadataCache();
        // 用户报「为什么还有系统/未归因」：那一行其实是 PID 4（System 内核进程）的真实流量，
        // 只是没名字被 UI 归到「(系统/未归因)」。无论是否管理员（句柄开成功走 Fetch、
        // 失败走兜底，两条路都补名），PID 4 都必须显示为 System。
        Assert.Equal("System", cache.Get(4).Name);
    }

    [Fact]
    public void ResolveWithoutHandle_names_kernel_pseudo_pids()
    {
        var cache = new ProcessMetadataCache();
        var resolve = typeof(ProcessMetadataCache).GetMethod(
            "ResolveWithoutHandle", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        Assert.Equal("System", ((ProcessMeta)resolve.Invoke(cache, [(uint)4, now])!).Name);
        Assert.Equal("System Idle Process", ((ProcessMeta)resolve.Invoke(cache, [(uint)0, now])!).Name);
        // 非固定 PID 仍如实空名（快照里没有就不该瞎安名字）
        Assert.Equal(string.Empty, ((ProcessMeta)resolve.Invoke(cache, [uint.MaxValue - 5, now])!).Name);
    }
}
