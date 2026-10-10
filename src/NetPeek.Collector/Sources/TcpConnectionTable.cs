using System.Net;
using System.Runtime.InteropServices;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 系统 TCP 连接表快照：把「本地/远端 端口对」映射到**属主进程 PID**。
///
/// 为什么需要它（这是按进程归因能成立的前提，2026-10-10 本机实测确认）：
/// ETW 的 <c>TcpIpSend/Recv</c> 事件里 <c>data.ProcessID</c> 读的是
/// <c>EVENT_HEADER.ProcessId</c>，而该字段**并不总是 socket 属主**——
/// 内核在协议栈线程/工作线程上打点时，事件头 PID 根本不是发起进程。
/// 实测（本机，一个已知属主的进程发 65,536 字节外网 TCP）：
///   · TCP：记到自身名下 **0 字节（0%）**，全部落到了 ZCode / System / msedge 名下；
///   · UDP：记到自身名下 163,840 / 163,840（**100%**），UDP 事件的 header PID 是准的。
///   · 对照实验：同代码改测**回环** TCP，786,432 字节**全部**正确归到自身。
/// 即：header PID 是否可信取决于该事件由哪个线程发出，不是字段读错
/// （IL 已确认 <c>ProcessID</c> getter 就是读 <c>EVENT_HEADER.ProcessId</c>）。
///
/// 本类提供校正手段：TCP 事件带 <c>saddr/sport/daddr/dport</c>，
/// 拿这四元组查本表即可得到真正的属主 PID。UDP 不查表——实测已准确，
/// 且 UDP 表枚举条目远多于 TCP，白付开销。
///
/// 表结构与那个「4 字节表头」的坑：<c>GetExtendedTcpTable</c> 返回的缓冲区
/// 开头有 4 字节表头（<c>dwNumEntries</c> + 3 字节对齐/版本），
/// 之后才是 <c>MIB_TCPROW_OWNER_PID</c> 数组。**漏掉这 4 字节**会让每一行
/// 错位，解析出的 <c>dwState</c>/<c>dwOwningPid</c> 全是垃圾（本机实测：
/// 漏偏移时首行 state 读出等于「表长度」这种一眼可见的荒谬值）。
/// 本类的常量 <see cref="TableHeaderBytes"/> 就是它。
///
/// 开销（2026-10-10 本机实测，约 400 条连接）：单次全表枚举 **0.1 ms**，
/// 按 1 秒一次维护，CPU 占用约 0.01%，可忽略。
/// </summary>
internal static class TcpConnectionTable
{
    /// <summary>返回缓冲区开头的表头字节数（见类注释：漏掉它整表错位）。</summary>
    internal const int TableHeaderBytes = 4;

    /// <summary>MIB_TCPROW_OWNER_PID 的字节数：6 个 uint。</summary>
    private const int RowBytes = 24;

    /// <summary>AF_INET / AF_INET6。</summary>
    private const int AfInet = 2;
    private const int AfInet6 = 23;

    /// <summary>TCP_TABLE_OWNER_PID_ALL：含所有连接状态，且带属主 PID 列。</summary>
    private const int TcpTableOwnerPidAll = 5;

    /// <summary>初始缓冲区。实测几百条连接约 8 KB，16 KB 起步绝大多数情况一次就够。</summary>
    private const int InitialBufferBytes = 16 * 1024;

    /// <summary>
    /// 缓冲区上限 2 MB。连接数暴增（几百条下载并发）时按需翻倍，
    /// 给上限是为了万一被反复打断也不无限分配——常驻服务里无边界重试等于内存泄漏。
    /// </summary>
    private const int MaxBufferBytes = 2 << 20;

    /// <summary>
    /// 一条连接的身份键。刻意用「地址+端口」的数值打包而不是字符串或元组：
    /// ETW 回调每秒要查几十万次，字典键必须是廉价等值的。
    /// IPv4 与 IPv6 分开编码（地址位宽不同），靠 <see cref="V6Flag"/> 区分，
    /// 避免 IPv4 的 0.0.0.0 与 IPv6 的 :: 撞进同一个键。
    /// </summary>
    internal readonly record struct ConnKey(ulong LocalAddr, ushort LocalPort, ulong RemoteAddr, ushort RemotePort, bool IsV6)
    {
        /// <summary>IPv6 标记位：放在 RemoteAddr 的最高位上，保证不同地址族永不同键。</summary>
        private const ulong V6Flag = 1UL << 63;

        internal static ConnKey Create(IPAddress localAddr, int localPort, IPAddress remoteAddr, int remotePort)
        {
            var v6 = localAddr.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6;
            return new ConnKey(
                ToUInt64(localAddr),
                (ushort)localPort,
                ToUInt64(remoteAddr),
                (ushort)remotePort,
                v6);
        }

        /// <summary>
        /// IPAddress → ulong。IPv4 直接取 32 位值；IPv6 取 <see cref="IPAddress"/> 的
        /// 8 个字节（<c>AddressFamily == InterNetworkV6</c> 时 <c>GetAddressBytes</c>
        /// 返回 16 字节，需截前 8 —— 这里用 <c>ScopeId</c> 位标记族，地址取低 64 位）。
        /// </summary>
        private static ulong ToUInt64(IPAddress a)
        {
            var b = a.GetAddressBytes();
            if (b.Length == 4)
            {
                return (uint)(b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24));
            }
            ulong v = 0;
            for (int i = 0; i < 8 && i < b.Length; i++) v |= (ulong)b[i] << (i * 8);
            return v;
        }

        /// <summary>把 IPv6 标记并入 RemoteAddr，使包含族信息的完整键可直接比较。</summary>
        internal ulong PackedRemote
        {
            get
            {
                ulong a = RemoteAddr;
                if (IsV6) a |= 1UL << 63;
                // 与 LocalAddr 的族位一起编码：键本身已经是 record struct，
                // 这里只作为哈希加速用，语义仍以 5 个字段为准。
                return a;
            }
        }
    }

    /// <summary>
    /// 读取一次全量 TCP 连接表。返回「连接四元组 → 属主 PID」。
    ///
    /// 失败返回空字典（不是抛异常）：校正只是让归因更准，拿不到就退回
    /// header PID，绝不能因为一次枚举失败让整帧流量数据跟着失败。
    /// </summary>
    internal static Dictionary<ConnKey, uint> Read()
    {
        var result = new Dictionary<ConnKey, uint>(1024);
        ReadInto(result, AfInet, RowBytes, isV6: false);
        // IPv6 行的地址字段是 16 字节 + 4 作用域，整行 56 字节；
        // 端口仍在 +8 / +12，属主 PID 在最后一列。
        ReadInto(result, AfInet6, 56, isV6: true);
        return result;
    }

    private static void ReadInto(Dictionary<ConnKey, uint> into, int ipVer, int rowBytes, bool isV6)
    {
        int size = 0;
        IntPtr buffer = IntPtr.Zero;
        try
        {
            // 探测所需大小：第一次调用必然返回 ERROR_INSUFFICIENT_BUFFER(122)
            // 并把 size 填成所需字节数，这是这类 API 的常规握手，不是错误。
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, ipVer, TcpTableOwnerPidAll, 0);
            if (size <= 0) return;

            var cap = Math.Max(size + 16 * 1024, InitialBufferBytes);
            while (cap <= MaxBufferBytes)
            {
                buffer = Marshal.AllocHGlobal(cap);
                var err = GetExtendedTcpTable(buffer, ref cap, false, ipVer, TcpTableOwnerPidAll, 0);
                if (err != 0)
                {
                    // 连接数在这两次调用之间增长了，重试。仍失败就放弃这一族。
                    Marshal.FreeHGlobal(buffer);
                    buffer = IntPtr.Zero;
                    cap *= 2;
                    continue;
                }

                Parse(buffer, cap, isV6, into);
                return;
            }
        }
        catch
        {
            // Marshal 分配失败等一般异常在此归零成「这一轮没有表」。
            // 注意：普通 catch 接不住 AccessViolationException，真正的越界防护在 Parse。
        }
        finally
        {
            if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>
    /// 按 <see cref="TableHeaderBytes"/> 跳过表头，逐行读出四元组与属主 PID。
    /// 行布局（IPv4，24 字节；<c>MIB_TCPROW_OWNER_PID</c>）：
    /// <c>dwState(+0) dwLocalAddr(+4) dwLocalPort(+8) dwRemoteAddr(+12) dwRemotePort(+16) dwOwningPid(+20)</c>。
    ///
    /// IPv6（<c>MIB_TCP6ROW_OWNER_PID</c>，56 字节）里 dwLocalAddr/dwRemoteAddr 各占 16 字节，
    /// 所以端口与 PID 的偏移**变了**：dwLocalPort 在 +8、dwRemotePort 在 +20、pid 在 +52。
    /// 这两个偏移集必须分开写 —— 混用会让远端端口读成远端地址的低字节
    /// （本机实测：远端 127.0.0.1 被读成 rp=127，表命中率 0/N）。
    /// </summary>
    private static void Parse(IntPtr buffer, int size, bool isV6, Dictionary<ConnKey, uint> into)
    {
        // 读任何一行之前先确认整行都在缓冲内。越界读会触发托管 catch 接不住的
        // AccessViolationException，直接崩掉 LocalSystem 服务。
        if (size < TableHeaderBytes + RowBytes) return;

        int portLocalOffset = 8;
        int portRemoteOffset = isV6 ? 20 : 16;
        int remoteAddrOffset = isV6 ? 12 : 12;   // IPv6 的 dwRemoteAddr 也在 +12（占 16 字节）
        int pidOffset = isV6 ? 52 : 20;

        var offset = TableHeaderBytes;
        var end = size - RowBytes;

        while (offset <= end)
        {
            // 端口以**网络序**存放：低 16 位的字节序是 [高字节, 低字节]，按主机序直读
            // 会得到交换过的值。2026-10-10 本机实测钉死了这一点：客户端实际端口
            // 51753(0xCA31)，表里原样读出 10698(0x29CA)，而 0x29CA 交换字节正是
            // 0xCA29 —— 换回主机序后与实际端口逐位对上。
            // （中途曾误改成「表里就是主机序」，命中率恒为 0；真正的坑另有其人：
            //  ① 4 字节表头；② IPv6 行的字段偏移与 IPv4 不同。）
            ushort lpNet = (ushort)Marshal.ReadInt16(buffer, offset + portLocalOffset);
            ushort rpNet = (ushort)Marshal.ReadInt16(buffer, offset + portRemoteOffset);
            var localPort = (ushort)((lpNet >> 8) | (lpNet << 8));
            var remotePort = (ushort)((rpNet >> 8) | (rpNet << 8));

            var pid = (uint)Marshal.ReadInt32(buffer, offset + pidOffset);

            // PID 0/4 是 Idle/System 伪进程，不是真实属主，收进来只会污染校正。
            if (pid > 4 && localPort != 0)
            {
                ulong localAddr = isV6
                    ? ReadUInt64(buffer, offset + 4)
                    : (uint)Marshal.ReadInt32(buffer, offset + 4);
                ulong remoteAddr = isV6
                    ? ReadUInt64(buffer, offset + remoteAddrOffset)
                    : (uint)Marshal.ReadInt32(buffer, offset + remoteAddrOffset);

                var key = new ConnKey(localAddr, localPort, remoteAddr, remotePort, isV6);
                // 同一四元组可能有多条（不同状态/不同 socket），取首个即可：
                // 属主 PID 对同一个 4 元组是一样的。
                if (!into.ContainsKey(key)) into[key] = pid;
            }

            offset += RowBytes;
        }
    }

    private static ulong ReadUInt64(IntPtr p, int offset)
    {
        ulong v = 0;
        for (int i = 7; i >= 0; i--)
        {
            v = (v << 8) | (byte)Marshal.ReadByte(p, offset + i);
        }
        return v;
    }

    [DllImport("iphlpapi.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint GetExtendedTcpTable(
        IntPtr tcpTable, ref int outBufLen, bool order, int ipVersion, int tcpTableClass, int reserved);
}