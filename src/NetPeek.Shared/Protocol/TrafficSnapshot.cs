namespace NetPeek.Shared.Protocol;

/// <summary>一个进程在采样周期内的流量统计。</summary>
public sealed class ProcessTraffic
{
    /// <summary>进程 PID。UI 侧以 (PID + 启动时间) 区分进程复用，PID 只作展示与关联键。</summary>
    public uint Pid { get; set; }

    /// <summary>进程名（如 chrome.exe），可能为空（权限不足时）。</summary>
    public string Name { get; set; } = "";

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

    /// <summary>采集状态：ok / paused / error。</summary>
    public string Status { get; set; } = "ok";

    public List<ProcessTraffic> Processes { get; set; } = new();
}
