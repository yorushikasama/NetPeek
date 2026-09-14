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

    /// <summary>
    /// 原子地翻转暂停状态并返回翻转后的值。
    /// 不要用「读 IsPaused 再调 Pause/Resume」代替：那是读-改-写三步，
    /// 两条并发 toggle 命令会互相抵消。
    /// </summary>
    bool TogglePause();

    /// <summary>当前是否处于暂停状态。</summary>
    bool IsPaused { get; }

    /// <summary>
    /// UI 重新连接时调用：让增量图标流从头重发（下一帧 IconUpdates 带全量）。
    /// 默认空实现，无图标流的实现类不必理会。
    /// </summary>
    void ResetIconStream() { }

    /// <summary>
    /// UI（重新）连接时调用：让下一帧只记基线、不报速率。
    ///
    /// 断开期间累加的总量不得被当成一帧的增量：这样算出来的速率会在重连首帧
    /// 变成一个假尖峰（实测 137 MB/s，而真实速率是 10 KB/s 量级），
    /// 进而顶掉坐标轴量程、污染历史库的分钟聚合、误触发网速提醒。
    /// 默认空实现，增量语义不适用（如测试桩）的实现类不必理会。
    /// </summary>
    void ResetRateBaseline() { }
}
