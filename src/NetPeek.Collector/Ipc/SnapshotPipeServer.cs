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
    /// </summary>
    public async Task ServeAsync(Func<TrafficSnapshot> produceSnapshot, int intervalMs, CancellationToken ct)
    {
        await using var server = new NamedPipeServerStream(
            IpcConstants.PipeName,
            PipeDirection.Out,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);

        _logger.LogInformation("等待 UI 连接命名管道 {Pipe}", IpcConstants.PipeName);
        await server.WaitForConnectionAsync(ct);
        _logger.LogInformation("UI 已连接");

        try
        {
            using var writer = new BinaryWriter(server, Encoding.UTF8, leaveOpen: true);

            while (!ct.IsCancellationRequested && server.IsConnected)
            {
                var snapshot = produceSnapshot();
                var json = JsonSerializer.SerializeToUtf8Bytes(snapshot);

                if (json.Length > IpcConstants.MaxFrameBytes)
                {
                    _logger.LogError("快照 {Bytes} 字节超过帧上限，跳过本帧", json.Length);
                }
                else
                {
                    writer.Write(json.Length);          // 4 字节小端长度
                    writer.Write(json);
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
