using NetPeek.Collector.Ipc;
using NetPeek.Collector.Sources;
using NetPeek.Shared.Protocol;

namespace NetPeek.Collector;

/// <summary>
/// 采集服务主循环：从数据源取快照，通过命名管道推送给 UI。
/// UI 断开后自动回到监听状态，等待下一次连接。
/// </summary>
public sealed class CollectorService : BackgroundService
{
    private readonly ISnapshotSource _source;
    private readonly SnapshotPipeServer _pipeServer;
    private readonly ILogger<CollectorService> _logger;

    public CollectorService(
        ISnapshotSource source,
        SnapshotPipeServer pipeServer,
        ILogger<CollectorService> logger)
    {
        _source = source;
        _pipeServer = pipeServer;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("NetPeek 采集服务启动");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await _pipeServer.ServeAsync(
                    _source.GetSnapshot,
                    IpcConstants.SnapshotIntervalMs,
                    stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (IOException ex)
            {
                _logger.LogWarning(ex, "管道通信异常，准备重新监听");
                await Task.Delay(500, stoppingToken);
            }
        }

        _logger.LogInformation("NetPeek 采集服务停止");
    }
}
