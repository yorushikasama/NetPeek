using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Sources;

/// <summary>
/// ETW 数据源（阶段 2 实现）。
/// 订阅 Microsoft-Windows-Kernel-Network，按 payload PID 聚合 TCP/UDP 收发字节。
/// 注意：用事件 payload 的 PID，不是事件头 PID；忽略 Event ID 18（避免下载量翻倍）；
/// 重传事件单独统计，不并入应用上传量。进程身份键 = PID + 进程启动时间。
/// </summary>
public sealed class EtwSnapshotSource : ISnapshotSource
{
    public TrafficSnapshot GetSnapshot()
    {
        // TODO(阶段2)：接入 ETW 会话，返回真实聚合结果。
        throw new NotImplementedException("ETW 数据源将在阶段 2 接入，当前请使用 StubSnapshotSource。");
    }
}
