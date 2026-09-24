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
                // 控制通道能停掉监控，默认 DACL 下任意本地进程都可下发命令，必须显式限权。
                await using var server = NamedPipeServerStreamAcl.Create(
                    IpcConstants.ControlPipeName,
                    PipeDirection.In,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    inBufferSize: 0,
                    outBufferSize: 0,
                    PipeSecurityPolicy.CreateForInboundControl());

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
            catch (Exception ex)
            {
                // 必须兜住一切：本类是 BackgroundService，逃出 ExecuteAsync 的异常会命中
                // .NET 默认策略（BackgroundServiceExceptionBehavior.StopHost），把整个采集
                // 进程连同快照推流一起静默停掉，界面只表现为「管道断开」。
                // NamedPipeServerStreamAcl.Create / WaitForConnectionAsync 也可能抛
                // UnauthorizedAccessException 等非 IOException —— 与 CollectorService 同策略：
                // 记日志、退避、继续监听，让控制通道自愈而不牵连主服务。
                _logger.LogError(ex, "控制管道意外异常，500ms 后重新监听");
                await Task.Delay(500, stoppingToken);
            }
        }

        _logger.LogInformation("控制管道服务停止");
    }

    /// <summary>
    /// 入站命令的字节上限。命令只有 pause/resume/toggle，几个字节足矣；设一个小上限，
    /// 挡住「已认证客户端灌入无换行的超长字节流把读缓冲无界撑大」的内存耗尽。
    /// </summary>
    private const int MaxCommandBytes = 64;

    private async Task HandleClientAsync(NamedPipeServerStream server, CancellationToken ct)
    {
        // UI 每次连接只发一行命令随即断开（见 pipe.rs::send_control），故读一行即够。
        // 不用 StreamReader.ReadLineAsync：它对无换行输入无长度上限，会把内部缓冲无界放大。
        var buffer = new byte[MaxCommandBytes];
        try
        {
            var total = 0;
            var newlineAt = -1;
            while (total < buffer.Length)
            {
                var n = await server.ReadAsync(buffer.AsMemory(total, buffer.Length - total), ct);
                if (n == 0)
                {
                    break; // 客户端断开
                }
                newlineAt = Array.IndexOf(buffer, (byte)'\n', total, n);
                total += n;
                if (newlineAt >= 0)
                {
                    break;
                }
            }

            // 读满上限仍无换行：超长命令，判为异常输入，断开不处理。
            if (newlineAt < 0 && total >= buffer.Length)
            {
                _logger.LogWarning("控制命令超过 {Max} 字节上限，断开连接", MaxCommandBytes);
                return;
            }

            var lineLen = newlineAt >= 0 ? newlineAt : total;
            if (lineLen > 0)
            {
                var line = Encoding.UTF8.GetString(buffer, 0, lineLen).Trim();
                if (line.Length > 0)
                {
                    HandleCommand(line);
                }
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
                // 原子翻转：读-改-写分三步时，两个并发 toggle 会互相抵消。
                _source.TogglePause();
                break;
            default:
                _logger.LogWarning("收到未知控制命令：{Command}", command);
                break;
        }
    }
}
