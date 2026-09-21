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
    /// 旧字段，恒为空串：图标改由快照级 <see cref="TrafficSnapshot.IconUpdates"/> 按路径增量下发，
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

    /// <summary>
    /// 本周期**未能归因到任何进程**的下载字节（网卡接口计数 − 进程合计）。
    ///
    /// 来源是接口累计计数（<c>NetworkInterface.GetIPv4Statistics</c>，内核按网卡记账），
    /// 与 ETW 归因无关 —— 这正是它唯一的价值：ETW 的合计拿自己跟自己比恒等于零，
    /// 要看出「漏了多少」必须有第二条不经过归因的量尺。
    ///
    /// 读法（docs/技术选型.md §9）：差额由协议头、回环/本地代理、归因失败三部分构成，
    /// 都属正常，所以它是「量级参考」。界面上必须作**单独一类**显示为「系统/未归因」，
    /// 绝不按比例摊回各应用 —— 摊回去等于给每个进程编一个数。
    ///
    /// 与 TotalDownloadBytes 同一时间口径：本周期增量，不是累计值。
    /// </summary>
    public ulong UnattributedDownloadBytes { get; set; }

    /// <summary>本周期未能归因到任何进程的上传字节。读法见 <see cref="UnattributedDownloadBytes"/>。</summary>
    public ulong UnattributedUploadBytes { get; set; }

    /// <summary>
    /// 本帧的「系统/未归因」读数是否可信。
    ///
    /// false 的情形：本帧拿不到接口计数（驱动不支持、刚好在切换网络）。
    /// 此时上面两个字段是 0，但**不能读作「全部归因成功」** —— 那是把「没测到」
    /// 显示成「没有」。UI 应据此显示破折号而不是 0 B，与顶栏断连、
    /// 「近 24 小时」无记录同一套规矩。
    ///
    /// 默认 true 是为兼容：旧采集端不发这个字段时 UI 当作「可信的 0」，
    /// 与旧行为一致，不会因为升级错位而整片显示破折号。
    /// </summary>
    public bool UnattributedKnown { get; set; } = true;

    /// <summary>ETW 丢失事件累计值（用于 UI 健康提示）。</summary>
    public ulong EventsLost { get; set; }

    /// <summary>采集服务启动时刻（Unix 毫秒），UI 据此计算会话时长。</summary>
    public long SessionStartedUnixMs { get; set; }

    /// <summary>
    /// 采集状态：
    /// <c>ok</c> = 正在收事件；<c>paused</c> = 用户暂停（累计值保持，速率报 0）；
    /// <c>starting</c> = ETW 会话还在后台启动（含残留会话清理，实测 0.3–2.4s），
    /// 管道已在推帧但 Processes 为空 —— 这是正常启动流程，UI 不应报错；
    /// <c>error</c> = 会话启动失败或事件线程异常退出（通常缺管理员权限）。
    /// </summary>
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
