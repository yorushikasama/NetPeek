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

    /// <summary>
    /// 快照协议版本。破坏性 schema 变更时 +1，供 UI 侧检测采集端版本是否兼容。
    /// 旧采集端不发此字段时反序列化为 0，UI 可据此提示「采集端需升级」，
    /// 而不是让异版本帧以默认值静默通过。
    /// </summary>
    public const int ProtocolVersion = 1;

    /// <summary>快照推送周期（毫秒）。</summary>
    public const int SnapshotIntervalMs = 1000;
}
