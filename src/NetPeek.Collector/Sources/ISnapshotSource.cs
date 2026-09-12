using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Sources;

/// <summary>采集数据源抽象：ETW 实现与测试桩都实现此接口。</summary>
public interface ISnapshotSource
{
    /// <summary>返回当前累计状态的一帧快照。需线程安全，供定时推送调用。</summary>
    TrafficSnapshot GetSnapshot();

    /// <summary>暂停监控：停止统计新事件，快照上报 <c>Status = "paused"</c>，速率为 0（累计值保持不变）。</summary>
    void Pause();

    /// <summary>恢复监控。</summary>
    void Resume();

    /// <summary>当前是否处于暂停状态。</summary>
    bool IsPaused { get; }

    /// <summary>
    /// UI 重新连接时调用：让增量图标流从头重发（下一帧 IconUpdates 带全量）。
    /// 默认空实现，无图标流的实现类不必理会。
    /// </summary>
    void ResetIconStream() { }
}
