namespace NetPeek.Shared.Protocol;

/// <summary>一个进程在采样周期内的流量统计。</summary>
public sealed class ProcessTraffic
{
    /// <summary>进程 PID。UI 侧以 (PID + 启动时间) 区分进程复用，PID 只作展示与关联键。</summary>
    public uint Pid { get; set; }

    /// <summary>进程名（如 chrome.exe），可能为空（权限不足时）。</summary>
    public string Name { get; set; } = "";

    /// <summary>进程可执行文件完整路径（可能为空：权限不足或进程已退出）。</summary>
    public string Path { get; set; } = "";

    /// <summary>
    /// 图标标识（按可执行文件路径生成的稳定短 id，空串表示无图标）。
    /// 图标内容是静态的，每帧重传 base64 会让帧体积涨一个数量级，因此改为按 id 缓存：
    /// 同一条管道连接内，某个 id 的 <see cref="IconBase64"/> 只在首帧出现时携带，
    /// 之后各帧只带 id，UI 按 id 从本地缓存取图。UI 重连时服务端重置发送记录，会重新补发。
    /// </summary>
    public string IconId { get; set; } = "";

    /// <summary>
    /// 应用图标（base64 PNG 的 data URL）。仅在本连接首次出现该 <see cref="IconId"/> 时非空；
    /// 后续帧为空串，UI 应按 <see cref="IconId"/> 命中自己的缓存，不要当作「图标丢失」。
    /// </summary>
    public string IconBase64 { get; set; } = "";

    /// <summary>进程启动时刻（Unix 毫秒，取自进程创建时间），UI 据此显示进程会话时长；0 表示未知。</summary>
    public long StartTimeUnixMs { get; set; }

    /// <summary>本周期下载字节数（含 TCP/UDP，IPv4/IPv6）。</summary>
    public ulong DownloadBytes { get; set; }

    /// <summary>本周期上传字节数。</summary>
    public ulong UploadBytes { get; set; }

    /// <summary>本次会话累计下载。</summary>
    public ulong DownloadTotal { get; set; }

    /// <summary>本次会话累计上传。</summary>
    public ulong UploadTotal { get; set; }

    /// <summary>本次会话累计重传字节（单独统计，不混入上传量）。</summary>
    public ulong RetransmitTotal { get; set; }
}

/// <summary>采集服务每秒推送给 UI 的一帧快照。</summary>
public sealed class TrafficSnapshot
{
    /// <summary>采集时间戳（Unix 毫秒）。</summary>
    public long TimestampUnixMs { get; set; }

    /// <summary>本周期所有进程的下载字节合计。</summary>
    public ulong TotalDownloadBytes { get; set; }

    /// <summary>本周期所有进程的上传字节合计。</summary>
    public ulong TotalUploadBytes { get; set; }

    /// <summary>ETW 丢失事件累计值（用于 UI 健康提示）。</summary>
    public ulong EventsLost { get; set; }

    /// <summary>采集服务启动时刻（Unix 毫秒），UI 据此计算会话时长。</summary>
    public long SessionStartedUnixMs { get; set; }

    /// <summary>采集状态：ok / paused / error。</summary>
    public string Status { get; set; } = "ok";

    public List<ProcessTraffic> Processes { get; set; } = new();
}
