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
                // 每轮连接前重置图标增量流：UI（重新）连上的第一帧 IconUpdates 带全量，
                // 之后只发新路径。在 ServeAsync 之前调用，与 GetSnapshot 严格串行。
                _source.ResetIconStream();
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
            catch (Exception ex)
            {
                // 必须兜住：BackgroundService 逃出去的异常会命中 .NET 默认策略
                // （BackgroundServiceExceptionBehavior.StopHost），整个 Host 连同服务一起
                // 静默退出，界面侧只表现为「管道断开」，无从判断原因。
                _logger.LogError(ex, "采集主循环异常，500ms 后重试");
                await Task.Delay(500, stoppingToken);
            }
        }

        _logger.LogInformation("NetPeek 采集服务停止");
    }
}
