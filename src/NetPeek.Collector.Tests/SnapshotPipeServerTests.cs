using Xunit;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using NetPeek.Collector.Ipc;
using NetPeek.Collector.Sources;
using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Tests;

/// <summary>
/// 管道服务端行为测试：帧格式（4 字节小端长度前缀 + UTF-8 JSON）
/// 与图标按连接去重（P1-3：同一 IconId 的 base64 只在本连接首帧出现）。
/// </summary>
public class SnapshotPipeServerTests
{
    private const string TestPipeName = "NetPeekTests.SnapshotPipe";

    [Fact]
    public async Task Serves_frames_and_deduplicates_icons_per_connection()
    {
        var frameIndex = 0;
        TrafficSnapshot Produce()
        {
            // 每帧全新对象：与真实 GetSnapshot 的语义一致（去重会改写帧内对象）。
            frameIndex++;
            return new TrafficSnapshot
            {
                TimestampUnixMs = frameIndex,
                Status = "ok",
                Processes =
                [
                    new ProcessTraffic
                    {
                        Pid = 7,
                        Name = "a.exe",
                        IconId = "icon-1",
                        IconBase64 = "data:image/png;base64,AAAA",
                        DownloadBytes = 100,
                        DownloadTotal = (ulong)(frameIndex * 100),
                    },
                ],
            };
        }

        using var cts = new CancellationTokenSource();
        var server = new SnapshotPipeServer(NullLogger<SnapshotPipeServer>.Instance);
        var serverTask = server.ServeAsync(Produce, 30, cts.Token, TestPipeName);

        using var client = new NamedPipeClientStream(".", TestPipeName, PipeDirection.In);
        client.Connect(5000);
        using var reader = new BinaryReader(client, Encoding.UTF8, leaveOpen: true);

        var frame1 = ReadFrame(reader);
        var frame2 = ReadFrame(reader);
        var p1 = Assert.Single(frame1.Processes);
        var p2 = Assert.Single(frame2.Processes);

        // 首帧携带 base64；后续帧只带 IconId（客户端按 id 缓存）。
        Assert.Equal("data:image/png;base64,AAAA", p1.IconBase64);
        Assert.Equal("icon-1", p1.IconId);

        Assert.Equal("icon-1", p2.IconId);
        Assert.Equal("", p2.IconBase64);
        // 静态字段照常传输
        Assert.Equal(7u, p2.Pid);
        Assert.Equal("a.exe", p2.Name);

        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => serverTask);
    }

    private static TrafficSnapshot ReadFrame(BinaryReader reader)
    {
        // 4 字节小端长度前缀 —— 与 Rust 侧 pipe.rs 的 i32::from_le_bytes 对应
        var len = reader.ReadInt32();
        Assert.InRange(len, 1, IpcConstants.MaxFrameBytes);
        var json = Encoding.UTF8.GetString(reader.ReadBytes(len));
        return JsonSerializer.Deserialize<TrafficSnapshot>(json)!;
    }
}

/// <summary>暂停控制语义测试（P0-2：TogglePause 必须是原子翻转）。</summary>
public class StubSnapshotSourceTests
{
    [Fact]
    public void Toggle_pause_alternates_state()
    {
        var source = new StubSnapshotSource();
        Assert.False(source.IsPaused);

        Assert.True(source.TogglePause());
        Assert.True(source.IsPaused);
        Assert.Equal("paused", source.GetSnapshot().Status);

        Assert.False(source.TogglePause());
        Assert.False(source.IsPaused);
        Assert.Equal("ok", source.GetSnapshot().Status);
    }

    [Fact]
    public void Paused_snapshot_freezes_rates_but_keeps_totals()
    {
        var source = new StubSnapshotSource();
        var before = source.GetSnapshot();

        source.Pause();
        var paused = source.GetSnapshot();

        Assert.Equal("paused", paused.Status);
        Assert.Equal(0UL, paused.TotalDownloadBytes);
        Assert.All(paused.Processes, p => Assert.Equal(0UL, p.DownloadBytes + p.UploadBytes));
        // 累计值保持暂停前的水平（不回退也不继续累计）
        Assert.Equal(before.Processes[0].DownloadTotal, paused.Processes[0].DownloadTotal);
    }
}
