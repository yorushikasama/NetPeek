using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Sources;

/// <summary>采集数据源抽象：ETW 实现与测试桩都实现此接口。</summary>
public interface ISnapshotSource
{
    /// <summary>返回当前累计状态的一帧快照。需线程安全，供定时推送调用。</summary>
    TrafficSnapshot GetSnapshot();
}
