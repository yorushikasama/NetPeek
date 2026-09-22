using System.Net.NetworkInformation;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 网卡接口计数（<c>GetIfEntry2</c>）：内核维护的累计收发字节，**与 ETW 归因无关**。
///
/// 用途：算「系统 / 未归因」流量，即接口总量减去 ETW 归因到进程的量。
/// docs/技术选型.md §9 要求把差额**单独显示**为「系统/未归因」，并明确
/// 「不要把接口总量与归因总量的差额按比例摊给各应用」；§12 的验收场景也要求
/// 「记录 ETW 归因总量与 GetIfEntry2 接口计数的差值」。本类就是那条基准线。
///
/// 为什么不能用 ETW 的量自比：TotalDownloadBytes 是**归因到进程的量之和**，
/// 拿它跟自己比恒等于零。要看出「漏了多少」，必须有一条不经过归因的独立量尺 ——
/// 接口计数正是它（内核按网卡记账，不关心是哪个进程）。
///
/// 差额由三部分构成（都属正常，不是故障）：
/// 1. 协议头 —— ETW 的 size 是网络栈口径的**载荷**字节，不含 TCP/IP 头；
///    按 MTU 1500 满载估算，每包少约 40 字节。
/// 2. 回环与本地代理 —— 走 127.0.0.1 的流量在接口计数里通常不计（或重复计），
///    而归因时全部落到代理进程头上。
/// 3. 归因失败 —— 受保护进程、采集启动/停止瞬间的短命连接等。
/// 所以这个数字的读法是「量级参考」，不是精确账；用户看到的应是
/// 「有多少没归到具体进程」，而不是「采集坏了」。
///
/// 只统计**已连接且非回环**的接口：断开/虚拟/回环接口的计数会让差额失真，
/// 尤其回环——它恰恰是本地代理流量的所在，算进去等于把 1、2 两项重复计入。
/// </summary>
internal static class InterfaceCounters
{
    /// <summary>一次采样到的接口累计字节。值与 <see cref="Read"/> 的实现无关。</summary>
    internal readonly record struct Sample(long Received, long Sent);

    /// <summary>
    /// 读取所有「已连接、非回环」接口的累计收发字节之和。
    ///
    /// 每次调用都重新枚举网卡：接口会在运行期增减（插拔网线、连断 VPN、
    /// 开关虚拟网卡），缓存列表会让差额在切换网络后彻底错乱。
    /// 枚举本身很轻（本机约十几个接口），每秒一次可忽略。
    ///
    /// 任何异常都返回 null 而不是抛：这是显示用的参考值，拿不到就不显示，
    /// 不该让整帧流量数据跟着失败。调用方见 null 应当**保留上一次的读数**，
    /// 而不是把差额算成 0（那会显示成「全都归因到了」，与事实相反）。
    /// </summary>
    internal static Sample? Read()
    {
        try
        {
            long received = 0;
            long sent = 0;

            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                // 只算真正在通车的接口。下面每条都是实测过的排除理由：
                // · Loopback：本地代理流量所在，算进来会让差额把回环重复计一遍；
                // · Down：断开的接口计数是历史值或 0，与「现在」无关；
                // · Tunnel：VPN 隧道，其流量同时也在物理网卡上计一次，会翻倍；
                // · 无统计能力的接口（部分虚拟网卡返回空）直接跳过。
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Tunnel) continue;
                // 虚拟交换机/桥接网卡（Hyper-V vEthernet、WSL、VMware、VirtualBox、Docker、
                // Npcap Loopback）会把物理网卡的同一份字节再计一遍，抬高「系统/未归因」。
                // 见 IsVirtualBridge 的取舍说明。
                if (IsVirtualBridge(ni)) continue;

                IPInterfaceStatistics stats;
                try
                {
                    // 用 GetIPStatistics 而不是 GetIPv4Statistics：后者只计 IPv4，而 ETW 归因
                    // 侧同时统计 IPv4/IPv6（见 EtwSnapshotSource 的 V6 事件）。两者口径不一致时，
                    // IPv6 为主的环境里「接口增量 − 进程合计」会经常算成负数而被钳到 0，
                    // 该显示的系统/未归因流量显示不出来。GetIPStatistics 合计两族，与 ETW 对齐。
                    stats = ni.GetIPStatistics();
                }
                catch
                {
                    // 单个接口取统计失败（驱动不支持、刚好被拔掉）不影响其余接口。
                    continue;
                }

                // BytesReceived/Sent 的 CLR 类型是 Int64，4 GB 不会回绕。
                // 即便如此，调用方仍必须用「增量」而不是绝对值：绝对值只反映
                // 「这块网卡自开机以来收了多少」，与「本秒的流量」无关。
                received += stats.BytesReceived;
                sent += stats.BytesSent;
            }

            return new Sample(received, sent);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 是否为虚拟交换机/桥接网卡。这类网卡（Hyper-V 的 vEthernet、WSL、VMware、VirtualBox
    /// Host-Only、Docker、Npcap Loopback 适配器）在主机侧桥接物理网卡，<c>GetIPStatistics</c>
    /// 会把同一份流量在物理网卡与虚拟网卡上各计一次，接口总量因此虚高、连带把
    /// 「系统/未归因」抬高。排除它们让差额更接近真实。
    ///
    /// 取舍（刻意保守）：按名称/描述做启发式匹配，只挡住明确的「主机侧虚拟交换机」标识串，
    /// 不碰普通物理网卡与 VPN（VPN 已由 Tunnel 类型排除）。极少数「主链路本身就走某虚拟
    /// 网卡」的场景（如纯 WSL2 组网）下会漏计那部分——但「系统/未归因」本就是量级参考、
    /// 非精确账，宁可少算也不要把物理网卡的量重复计进去误导用户。匹配集若需扩充，
    /// 只加同类「主机侧桥接」标识，不要把可能承载真实出网流量的网卡也纳入。
    /// </summary>
    private static bool IsVirtualBridge(NetworkInterface ni)
    {
        var text = $"{ni.Description} {ni.Name}";
        // 大小写不敏感的子串匹配。这些标识串都来自主机侧虚拟交换机的固定命名。
        string[] markers =
        {
            "vethernet",          // Hyper-V 虚拟交换机（含 vEthernet (WSL)、vEthernet (Default Switch)）
            "hyper-v virtual",    // Hyper-V Virtual Ethernet Adapter
            "vmware virtual",     // VMware 虚拟网卡
            "virtualbox host-only", // VirtualBox Host-Only
            "npcap loopback",     // Npcap 环回适配器
            "docker",             // Docker 虚拟网卡
        };
        foreach (var m in markers)
        {
            if (text.Contains(m, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }
        return false;
    }
}
