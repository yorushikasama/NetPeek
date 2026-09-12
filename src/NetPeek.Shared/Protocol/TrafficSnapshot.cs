namespace NetPeek.Shared.Protocol;

using System.Text.Json.Serialization;

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
    /// 应用图标（base64 PNG 的 data URL）。
    /// 旧字段，恒为空串：图标改由快照级 <see cref="TrafficSnapshot.IconUpdates"/> 增量下发，
    /// 保留此属性仅为升级窗口内的旧 UI 兼容，不再赋值。
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

    /// <summary>
    /// 本采样周期内该进程流量最大的远端 IP（对端）。
    /// 取自 ETW 事件的源/目的地址：发送取目的端、接收取源端；无端点信息时为空串。
    /// 每帧重置，代表的是「这一秒谁在说话」，不是会话累计。
    /// </summary>
    public string TopRemoteIp { get; set; } = "";

    /// <summary>对端端口号；0 = 未知。</summary>
    public ushort TopRemotePort { get; set; }
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

    /// <summary>
    /// 本帧新出现的进程图标（路径 → data URL），null = 本帧没有新图标。
    /// 32px 图标每个 2–5KB，逐帧随每个进程下发会让整条链路（C# 序列化 → 管道 →
    /// Rust 解析 → Tauri 转发 → WebView 解析）每秒白搬几十到两百 KB —— 图标按路径
    /// 缓存后终生不变，只在首次出现时发一次；UI 重连时采集端重发全量。
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, string>? IconUpdates { get; set; }

    public List<ProcessTraffic> Processes { get; set; } = new();
}
