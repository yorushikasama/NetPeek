using System.IO.Pipes;
using System.Text;
using NetPeek.Collector.Sources;
using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Ipc;

/// <summary>
/// 反向控制通道：UI 通过独立的控制命名管道下发「暂停 / 恢复监控」命令。
///
/// 设计要点：
/// - 与快照管道（<see cref="SnapshotPipeServer"/>，仅出站）分离，避免单向出站管道被反向使用。
/// - 方向为 PipeDirection.In（服务端只收不发）。UI 侧每次发命令都是新建一个客户端连接，
///   写入一行命令后立即断开；服务端收到命令处理完即回到监听，天然支持多次连接。
/// - 命令为单行 UTF-8 文本（pause / resume / toggle），不区分大小写，简单可靠。
/// </summary>
public sealed class SnapshotControlServer : BackgroundService
{
    private readonly ISnapshotSource _source;
    private readonly ILogger<SnapshotControlServer> _logger;

    public SnapshotControlServer(ISnapshotSource source, ILogger<SnapshotControlServer> logger)
    {
        _source = source;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("控制管道服务启动，监听 {Pipe}", IpcConstants.ControlPipeName);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(
                    IpcConstants.ControlPipeName,
                    PipeDirection.In,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                await server.WaitForConnectionAsync(stoppingToken);
                await HandleClientAsync(server, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (IOException ex)
            {
                _logger.LogWarning(ex, "控制管道通信异常，重新监听");
                await Task.Delay(200, stoppingToken);
            }
        }

        _logger.LogInformation("控制管道服务停止");
    }

    private async Task HandleClientAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        using var reader = new StreamReader(server, Encoding.UTF8, leaveOpen: true);
        try
        {
            // 一次连接可携带多条命令（UI 当前一次连接只发一条，读到空行为止）。
            while (server.IsConnected && !ct.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync(ct);
                if (line == null)
                {
                    break; // 客户端断开
                }
                HandleCommand(line.Trim());
            }
        }
        catch (IOException)
        {
            // 客户端中途断开属常规事件。
        }
    }

    private void HandleCommand(string command)
    {
        switch (command.ToLowerInvariant())
        {
            case "pause":
                _source.Pause();
                break;
            case "resume":
                _source.Resume();
                break;
            case "toggle":
                if (_source.IsPaused)
                {
                    _source.Resume();
                }
                else
                {
                    _source.Pause();
                }
                break;
            default:
                _logger.LogWarning("收到未知控制命令：{Command}", command);
                break;
        }
    }
}
