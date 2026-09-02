namespace NetPeek.Shared.Protocol;

/// <summary>采集服务与 UI 之间的命名管道契约。</summary>
public static class IpcConstants
{
    /// <summary>命名管道名称（不含 \\.\pipe\ 前缀）。</summary>
    public const string PipeName = "NetPeekCollector";

    /// <summary>UI → 采集服务的反向控制管道名称（暂停/恢复等命令）。</summary>
    public const string ControlPipeName = "NetPeekCollectorControl";

    /// <summary>单帧最大字节数，超过视为协议错误。</summary>
    public const int MaxFrameBytes = 16 * 1024 * 1024;

    /// <summary>快照推送周期（毫秒）。</summary>
    public const int SnapshotIntervalMs = 1000;
}
