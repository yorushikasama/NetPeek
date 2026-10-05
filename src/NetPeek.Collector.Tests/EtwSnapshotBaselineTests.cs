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
