using Xunit;
using System.Text.Json;
using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Tests;

/// <summary>
/// IPC 帧契约测试。快照以「默认序列化选项」跨管道传输，消费方有两处按属性名字符串取值：
/// Rust 侧 history.rs 读 Status/TimestampUnixMs/Processes/Pid/StartTimeUnixMs/DownloadBytes/UploadBytes，
/// 前端读全部渲染字段。序列化命名策略一旦变成 camelCase，历史聚合会静默丢数据——
/// 本测试把 PascalCase 契约和字段集合锁死。
/// </summary>
public class ProtocolTests
{
    [Fact]
    public void Snapshot_json_uses_pascal_case_contract()
    {
        var snapshot = new TrafficSnapshot
        {
            TimestampUnixMs = 1_234_567,
            TotalDownloadBytes = ulong.MaxValue,
            TotalUploadBytes = 8,
            EventsLost = 9,
            SessionStartedUnixMs = 10,
            Status = "ok",
            Processes =
            [
                new ProcessTraffic
                {
                    Pid = 42,
                    Name = "a.exe",
                    Path = @"C:\a.exe",
                    IconId = "IC1",
                    IconBase64 = "data:image/png;base64,AA==",
                    StartTimeUnixMs = 99,
                    DownloadBytes = 1,
                    UploadBytes = 2,
                    DownloadTotal = 3,
                    UploadTotal = 4,
                    RetransmitTotal = 5,
                },
            ],
        };

        var json = JsonSerializer.Serialize(snapshot); // 与 SnapshotPipeServer 相同的默认选项
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        foreach (var name in new[]
                 {
                     "TimestampUnixMs", "TotalDownloadBytes", "TotalUploadBytes",
                     "EventsLost", "SessionStartedUnixMs", "Status", "Processes",
                 })
        {
            Assert.True(root.TryGetProperty(name, out _), $"快照缺少契约字段 {name}");
        }

        Assert.Equal(ulong.MaxValue, root.GetProperty("TotalDownloadBytes").GetUInt64());

        var proc = root.GetProperty("Processes")[0];
        foreach (var name in new[]
                 {
                     "Pid", "Name", "Path", "IconId", "IconBase64", "StartTimeUnixMs",
                     "DownloadBytes", "UploadBytes", "DownloadTotal", "UploadTotal", "RetransmitTotal",
                 })
        {
            Assert.True(proc.TryGetProperty(name, out _), $"ProcessTraffic 缺少契约字段 {name}");
        }

        // 往返不丢值（含 ulong 全量程）
        var back = JsonSerializer.Deserialize<TrafficSnapshot>(json)!;
        Assert.Equal(snapshot.TotalDownloadBytes, back.TotalDownloadBytes);
        Assert.Equal(42u, back.Processes[0].Pid);
        Assert.Equal("IC1", back.Processes[0].IconId);
        Assert.Equal(5UL, back.Processes[0].RetransmitTotal);
    }

    [Fact]
    public void Snapshot_serializes_to_compact_json_without_nulls()
    {
        // 空字段以 "" / 0 传输而不是 null：Rust 端 as_str()/as_i64() 对 null 返回 None
        // 虽能容忍，但 UI 侧大量 `|| 0` / `|| ''` 兜底依赖「字段总在」这一前提。
        var snapshot = new TrafficSnapshot { Status = "ok" };
        var json = JsonSerializer.Serialize(snapshot);

        Assert.DoesNotContain("null", json);
        Assert.DoesNotContain("\"Processes\":null", json);
    }
}
