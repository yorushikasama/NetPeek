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
/// 与图标增量下发（IconUpdates 只在图标首次出现的那一帧携带，进程行不带图标本体）。
/// </summary>
public class SnapshotPipeServerTests
{
    private const string TestPipeName = "NetPeekTests.SnapshotPipe";

    [Fact]
    public async Task Serves_frames_and_passes_icon_updates_through()
    {
        var frameIndex = 0;
        TrafficSnapshot Produce()
        {
            // 每帧全新对象，与真实 GetSnapshot 的语义一致。
            // 图标增量由数据源决定：这里只让首帧带 IconUpdates，模拟「路径首次出现」。
            frameIndex++;
            return new TrafficSnapshot
            {
                TimestampUnixMs = frameIndex,
                Status = "ok",
                IconUpdates = frameIndex == 1
                    ? new Dictionary<string, string> { [@"C:\a.exe"] = "data:image/png;base64,AAAA" }
                    : null,
                Processes =
                [
                    new ProcessTraffic
                    {
                        Pid = 7,
                        Name = "a.exe",
                        Path = @"C:\a.exe",
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

        // 首帧带图标增量，按路径为键；后续帧不再重复搬运。
        var updates = Assert.IsType<Dictionary<string, string>>(frame1.IconUpdates);
        Assert.Equal("data:image/png;base64,AAAA", Assert.Contains(@"C:\a.exe", updates));
        Assert.Null(frame2.IconUpdates);

        // 图标本体不再挂在进程行上。
        Assert.Equal("", p1.IconBase64);
        Assert.Equal("", p2.IconBase64);

        // 静态字段照常传输
        Assert.Equal(7u, p2.Pid);
        Assert.Equal("a.exe", p2.Name);
        Assert.Equal(@"C:\a.exe", p2.Path);

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
