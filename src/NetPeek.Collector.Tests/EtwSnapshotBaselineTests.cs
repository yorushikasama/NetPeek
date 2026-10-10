using System.Collections;
using System.Reflection;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Logging.Abstractions;
using NetPeek.Collector.Sources;
using NetPeek.Shared.Protocol;
using Xunit;

namespace NetPeek.Collector.Tests;

/// <summary>直接验证真实 GetSnapshot 的基线消费，不启动 ETW，也不需要管理员权限。</summary>
public class EtwSnapshotBaselineTests
{
    [Theory]
    [InlineData(true, false)] // 仅连接级：暂停期间 UI 重连。
    [InlineData(false, true)] // 仅会话级：会话就绪后的首帧仍暂停。
    [InlineData(true, true)] // 两类基线同时待处理，不能提前消费其中任何一个。
    public void Paused_snapshots_preserve_baselines_until_first_resumed_frame(
        bool rateBaselinePending, bool sessionBaselinePending)
    {
        using var metadata = new ProcessMetadataCache();
        using var icons = new ProcessIconCache();
        using var source = CreateSource(metadata, icons, out var counter);
        SetField(counter, "LastDownloadTotal", 100L);
        SetField(counter, "LastUploadTotal", 100L);
        SetField(counter, "DownloadTotal", 700L);
        SetField(counter, "UploadTotal", 700L);
        SetField(source, "_sessionBaselinePending", sessionBaselinePending);
        source.Pause();
        if (rateBaselinePending)
        {
            source.ResetRateBaseline();
        }

        // 连续暂停帧必须保持累计 700、旧基准 100，且下载/上传及其合计均为 0。
        for (var frame = 0; frame < 3; frame++)
        {
            AssertFrame(source.GetSnapshot(), "paused", delta: 0, total: 700);
            Assert.Equal(100L, GetField<long>(counter, "LastDownloadTotal"));
            Assert.Equal(100L, GetField<long>(counter, "LastUploadTotal"));
        }

        source.Resume();
        // 原实现此处报 600：暂停帧提前清了标志，却没把 LastTotal 从 100 推进到 700。
        AssertFrame(source.GetSnapshot(), "ok", delta: 0, total: 700);
        Assert.Equal(700L, GetField<long>(counter, "LastDownloadTotal"));
        Assert.Equal(700L, GetField<long>(counter, "LastUploadTotal"));
        Assert.False(GetField<bool>(source, "_rateBaselinePending"));
        Assert.False(GetField<bool>(source, "_sessionBaselinePending"));

        SetField(counter, "DownloadTotal", 705L);
        SetField(counter, "UploadTotal", 705L);
        AssertFrame(source.GetSnapshot(), "ok", delta: 5, total: 705);
        AssertFrame(source.GetSnapshot(), "ok", delta: 0, total: 705);
    }

    /// <summary>
    /// 重传也必须按每帧增量报，不能直接把会话累计值透给界面。
    ///
    /// 背景：<c>RetransmitTotal</c> 是单调增长到进程结束的累计量，而检查栏里它和
    /// 「PID」「会话时长」这些累计语义的项并列显示，读者会当成「刚刚重传了这么多」。
    /// 修法是照下载/上传的基线相减加一个 <c>RetransmitBytes</c>；这里钉住三件事：
    /// 增量按帧相减、基线帧归零（否则把断开期间的重传一次性算进「这一秒」）、
    /// 累计值本身不受影响（会话总量仍可从 tooltip 拿）。
    /// </summary>
    [Fact]
    public void Retransmit_is_reported_as_a_per_frame_delta_not_the_running_total()
    {
        using var metadata = new ProcessMetadataCache();
        using var icons = new ProcessIconCache();
        using var source = CreateSource(metadata, icons, out var counter);

        SetField(counter, "DownloadTotal", 0L);
        SetField(counter, "UploadTotal", 0L);
        SetField(counter, "RetransmitTotal", 1000L);   // 会话已累计 1000 字节
        SetField(counter, "LastDownloadTotal", 0L);
        SetField(counter, "LastUploadTotal", 0L);
        SetField(counter, "LastRetransmitTotal", 1000L);

        // 第一帧：累计没动 → 增量 0（不是 1000）
        var f1 = source.GetSnapshot();
        Assert.Equal(0UL, OnlyProcess(f1).RetransmitBytes);
        Assert.Equal(1000UL, OnlyProcess(f1).RetransmitTotal);

        // 第二帧：又重传了 40 字节 → 增量 40，累计 1040
        SetField(counter, "RetransmitTotal", 1040L);
        var f2 = source.GetSnapshot();
        Assert.Equal(40UL, OnlyProcess(f2).RetransmitBytes);
        Assert.Equal(1040UL, OnlyProcess(f2).RetransmitTotal);

        // 第三帧：没再重传 → 增量归零，累计不变
        var f3 = source.GetSnapshot();
        Assert.Equal(0UL, OnlyProcess(f3).RetransmitBytes);
        Assert.Equal(1040UL, OnlyProcess(f3).RetransmitTotal);
    }

    /// <summary>
    /// 基线帧（重连后的第一帧）必须把重传增量也归零 —— 与下载/上传同一口径。
    /// 否则 UI 断开期间累积的重传会一次性显示成「这一秒重传了 N 字节」，
    /// 界面上是一跳而下的假尖峰。
    /// </summary>
    [Fact]
    public void Baseline_frame_reports_zero_retransmit_delta()
    {
        using var metadata = new ProcessMetadataCache();
        using var icons = new ProcessIconCache();
        using var source = CreateSource(metadata, icons, out var counter);

        SetField(counter, "DownloadTotal", 0L);
        SetField(counter, "UploadTotal", 0L);
        SetField(counter, "LastDownloadTotal", 0L);
        SetField(counter, "LastUploadTotal", 0L);
        SetField(counter, "LastRetransmitTotal", 0L);

        // 断开期间攒下 500 字节重传
        SetField(counter, "RetransmitTotal", 500L);
        source.ResetRateBaseline();

        var frame = source.GetSnapshot();
        Assert.Equal(0UL, OnlyProcess(frame).RetransmitBytes);
        Assert.Equal(500UL, OnlyProcess(frame).RetransmitTotal);   // 累计仍是 500，不丢
        Assert.Equal(500L, GetField<long>(counter, "LastRetransmitTotal")); // 基线已拉平
    }

    private static ProcessTraffic OnlyProcess(TrafficSnapshot snap)
    {
        Assert.Single(snap.Processes);
        return snap.Processes[0];
    }

    private static EtwSnapshotSource CreateSource(
        ProcessMetadataCache metadata, ProcessIconCache icons, out object counter)
    {
        // 构造函数会启动 ETW 和维护定时器，必须绕过；只补齐快照、暂停及释放所用的字段。
        var source = (EtwSnapshotSource)RuntimeHelpers.GetUninitializedObject(typeof(EtwSnapshotSource));
        SetField(source, "_logger", NullLogger<EtwSnapshotSource>.Instance);
        SetField(source, "_metadata", metadata);
        SetField(source, "_icons", icons);
        SetField(source, "_iconPathsSent", new HashSet<string>(StringComparer.OrdinalIgnoreCase));
        SetField(source, "_pauseGate", new object());
        SetField(source, "_sessionGate", new object());
        SetField(source, "_retryTimerGate", new object());
        SetField(source, "_state", Enum.Parse(Field(source, "_state").FieldType, "Running"));

        var counterType = typeof(EtwSnapshotSource).GetNestedType("ProcessCounter", BindingFlags.NonPublic)!;
        counter = Activator.CreateInstance(counterType, nonPublic: true)!;
        var counters = (IDictionary)Activator.CreateInstance(Field(source, "_counters").FieldType)!;
        // 不存在的 PID：元数据无路径，不提取图标，也不会因真实进程退出或 PID 复用改变计数。
        counters.Add(uint.MaxValue, counter);
        SetField(source, "_counters", counters);
        return source;
    }

    private static void AssertFrame(TrafficSnapshot snapshot, string status, ulong delta, ulong total)
    {
        Assert.Equal(status, snapshot.Status);
        var process = Assert.Single(snapshot.Processes);
        Assert.Equal(delta, process.DownloadBytes);
        Assert.Equal(delta, process.UploadBytes);
        Assert.Equal(total, process.DownloadTotal);
        Assert.Equal(total, process.UploadTotal);
        Assert.Equal(delta, snapshot.TotalDownloadBytes);
        Assert.Equal(delta, snapshot.TotalUploadBytes);
    }

    private static FieldInfo Field(object target, string name) =>
        target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!;

    private static void SetField(object target, string name, object value) => Field(target, name).SetValue(target, value);

    private static T GetField<T>(object target, string name) => (T)Field(target, name).GetValue(target)!;
}
