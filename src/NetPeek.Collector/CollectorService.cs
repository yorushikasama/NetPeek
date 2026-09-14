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
                // 每轮连接前重置**连接级状态**。两件事同一时机做，因为起因相同：
                // 客户端换了一个，上一段会话的「增量基准」不再成立。
                //   · 清空图标已发记录 → 重连首帧 IconUpdates 带全量；
                //   · 置速率基线标志 → 重连首帧只记基线、不报速率。断开期间 ETW
                //     照收、累计值照涨，而增量基线只在 UI 连着时才推进，不置这个
                //     标志的话首帧会把攒下的存量当成 1 秒的速率报出去（实测
                //     137.09 MB/s vs 次帧 10.70 KB/s，差 1.3 万倍）。
                // 在 ServeAsync 之前调用是安全的：基线标志由管道线程在**连接之后**
                // 的第一帧消费，不是在调用这一刻取样。
                _source.ResetIconStream();
                _source.ResetRateBaseline();
                await _pipeServer.ServeAsync(
                    _source.GetSnapshot,
                    IpcConstants.SnapshotIntervalMs,
                    stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                // 必须兜住一切：BackgroundService 逃出去的异常会命中 .NET 默认策略
                // （BackgroundServiceExceptionBehavior.StopHost），整个 Host 连同服务一起
                // 静默退出，界面侧只表现为「管道断开」，无从判断原因。
                // 包括快照构建中的意外错误 —— 服务应保持存活，等下一帧或数据源自愈。
                _logger.LogError(ex, "推送循环异常，500ms 后重新监听");
                await Task.Delay(500, stoppingToken);
            }
        }

        _logger.LogInformation("NetPeek 采集服务停止");
    }
}
