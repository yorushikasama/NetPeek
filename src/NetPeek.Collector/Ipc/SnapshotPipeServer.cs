using System.Buffers;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Ipc;

/// <summary>
/// 命名管道服务端：向单个 UI 客户端按帧推送快照。
/// 帧格式：4 字节小端长度前缀 + UTF-8 JSON。
/// </summary>
public sealed class SnapshotPipeServer
{
    private readonly ILogger<SnapshotPipeServer> _logger;

    public SnapshotPipeServer(ILogger<SnapshotPipeServer> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// 阻塞等待一个客户端连接，然后在其存续期间按 intervalMs 推送 <paramref name="produceSnapshot"/> 的结果。
    /// 客户端断开后返回，由调用方决定是否重新监听。
    /// <paramref name="pipeName"/> 仅供测试注入（默认用生产管道名），避免测试与真实服务争抢管道。
    /// </summary>
    public async Task ServeAsync(Func<TrafficSnapshot> produceSnapshot, int intervalMs, CancellationToken ct,
        string? pipeName = null)
    {
        // 必须用带 PipeSecurity 的重载：默认 DACL 会放通本机任意用户读取全部进程流量。
        await using var server = NamedPipeServerStreamAcl.Create(
            pipeName ?? IpcConstants.PipeName,
            PipeDirection.Out,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            PipeSecurityPolicy.CreateForOutboundSnapshot());

        _logger.LogInformation("等待 UI 连接命名管道 {Pipe}", pipeName ?? IpcConstants.PipeName);
        await server.WaitForConnectionAsync(ct);
        _logger.LogInformation("UI 已连接");

        try
        {
            using var writer = new BinaryWriter(server, Encoding.UTF8, leaveOpen: true);

            // 复用同一块缓冲，避免每帧 SerializeToUtf8Bytes 新分配 byte[]（GC 压力）。
            var jsonBuffer = new ArrayBufferWriter<byte>(64 * 1024);

            // 图标不在这一层去重：数据源已按路径做过增量（见 EtwSnapshotSource 的
            // _iconPathsSent），首帧带全量、之后只带新出现的路径，帧里根本不会有重复的
            // base64。连接级重置由 CollectorService.ResetIconStream 负责。
            while (!ct.IsCancellationRequested && server.IsConnected)
            {
                var snapshot = produceSnapshot();

                jsonBuffer.Clear();
                using (var jsonWriter = new Utf8JsonWriter(jsonBuffer))
                {
                    JsonSerializer.Serialize(jsonWriter, snapshot);
                }

                if (jsonBuffer.WrittenCount > IpcConstants.MaxFrameBytes)
                {
                    _logger.LogError("快照 {Bytes} 字节超过帧上限，跳过本帧", jsonBuffer.WrittenCount);
                }
                else
                {
                    writer.Write(jsonBuffer.WrittenCount);   // 4 字节小端长度
                    writer.Write(jsonBuffer.WrittenSpan);
                    writer.Flush();
                }

                await Task.Delay(intervalMs, ct);
            }
        }
        catch (IOException)
        {
            // 客户端中途断开（含 BinaryWriter 释放时的 flush）属常规事件，不视为异常。
        }

        _logger.LogInformation("UI 已断开");
    }
}
