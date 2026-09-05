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
    /// </summary>
    public async Task ServeAsync(Func<TrafficSnapshot> produceSnapshot, int intervalMs, CancellationToken ct)
    {
        // 必须用带 PipeSecurity 的重载：默认 DACL 会放通本机任意用户读取全部进程流量。
        await using var server = NamedPipeServerStreamAcl.Create(
            IpcConstants.PipeName,
            PipeDirection.Out,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            PipeSecurityPolicy.CreateForOutboundSnapshot());

        _logger.LogInformation("等待 UI 连接命名管道 {Pipe}", IpcConstants.PipeName);
        await server.WaitForConnectionAsync(ct);
        _logger.LogInformation("UI 已连接");

        try
        {
            using var writer = new BinaryWriter(server, Encoding.UTF8, leaveOpen: true);

            // 复用同一块缓冲，避免每帧 SerializeToUtf8Bytes 新分配 byte[]（GC 压力）。
            var jsonBuffer = new ArrayBufferWriter<byte>(64 * 1024);

            // 图标 base64 是静态数据（同一 IconId 永不变），每帧重发会让帧体积涨一个数量级。
            // 这里按连接记录已发送过的 IconId，后续帧只留 IconId，UI 侧按 id 缓存复用。
            // 作用域是单个连接：UI 重连后重新发一遍，无需额外协议协商。
            var sentIcons = new HashSet<string>(StringComparer.Ordinal);

            while (!ct.IsCancellationRequested && server.IsConnected)
            {
                var snapshot = produceSnapshot();

                foreach (var process in snapshot.Processes)
                {
                    if (process.IconBase64.Length == 0)
                    {
                        continue;
                    }

                    if (!sentIcons.Add(process.IconId))
                    {
                        process.IconBase64 = "";
                    }
                }

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
