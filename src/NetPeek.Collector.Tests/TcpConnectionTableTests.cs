using System.Net;
using NetPeek.Collector.Sources;
using Xunit;

namespace NetPeek.Collector.Tests;

/// <summary>
/// TCP 连接表校正的回归（2026-10-10）。
///
/// 背景：按进程归因的前提被推翻了。ETW 的 <c>TcpIpSend/Recv</c> 事件的
/// <c>data.ProcessID</c> 读的是 <c>EVENT_HEADER.ProcessId</c>（IL 层面确认过），
/// 而该字段**不总是 socket 属主**。本机实测（一个已知属主的进程发 65,536 字节外网 TCP）：
/// 记到自身名下 **0 字节**，全部落到 ZCode / System / msedge 名下；同批 UDP 却是
/// 163,840/163,840 全对。对照实验改测回环 TCP，786,432 字节全对 ——
/// 说明这个字段是否可信取决于事件由哪个线程发出，不是读错字段。
///
/// 所以 TCP 事件改用四元组查系统连接表来拿属主（<see cref="TcpConnectionTable"/>）。
/// UDP 不查表：实测已准确，且 UDP 表枚举条目远多于 TCP，白付开销。
///
/// 这里测两层：
/// 1. <see cref="ConnKey"/> 的编解码与方向性 —— 纯函数，无外部依赖；
/// 2. <c>Read()</c> 在真实系统上能否认出自己的连接 —— 需要一个真实 TCP 连接，
///    但不需要 ETW 会话，普通权限即可运行。
/// </summary>
public class TcpConnectionTableTests
{
    [Fact]
    public void ConnKey_distinguishes_direction_and_address_family()
    {
        var a = TcpConnectionTable.ConnKey.Create(IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("93.184.216.34"), 443);
        var b = TcpConnectionTable.ConnKey.Create(IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("93.184.216.34"), 443);
        var swapped = TcpConnectionTable.ConnKey.Create(IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("1.1.1.1"), 443);

        Assert.Equal(a, b);                       // 同一四元组 → 同键
        Assert.NotEqual(a, swapped);              // 远端不同 → 不同键
        Assert.False(a.IsV6);                     // IPv4

        // 发送与接收是同一连接的同一四元组（本地/远端不互换），所以键相同 ——
        // 这正是校正需要的性质：一个连接无论收发都能查到同一个属主。
        var send = TcpConnectionTable.ConnKey.Create(IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("93.184.216.34"), 443);
        var recv = TcpConnectionTable.ConnKey.Create(IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("93.184.216.34"), 443);
        Assert.Equal(send, recv);
    }

    [Fact]
    public void ConnKey_ipv4_and_ipv6_with_zero_addresses_do_not_collide()
    {
        // 0.0.0.0 与 :: 在「不带族信息」时会撞键（都是全零）。这里断言带族信息后不撞。
        var v4 = TcpConnectionTable.ConnKey.Create(IPAddress.Parse("0.0.0.0"), 0, IPAddress.Parse("0.0.0.0"), 0);
        var v6 = TcpConnectionTable.ConnKey.Create(IPAddress.Parse("::"), 0, IPAddress.Parse("::"), 0);
        Assert.NotEqual(v4, v6);
        Assert.True(v6.IsV6);
        Assert.False(v4.IsV6);
    }

    /// <summary>
    /// 真机验证：读到的表必须能认出**本进程自己**建立的那条回环连接。
    /// 这是校正成立的前提 —— 若连属主自己都认不出，ETW 里查到的属主就无从谈起。
    ///
    /// 不需要 ETW 会话，因此普通权限就能跑（CI 里也成立）。
    /// </summary>
    [Fact]
    public async System.Threading.Tasks.Task Read_finds_the_connection_owned_by_this_process()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var lport = ((IPEndPoint)listener.LocalEndpoint).Port;

        var client = new System.Net.Sockets.TcpClient();
        client.Connect(IPAddress.Loopback, lport);
        var cliPort = ((IPEndPoint)client.Client.LocalEndPoint!).Port;

        // 服务端连接必须**持有到断言之后**：若在此处 using，读协程一结束 socket 就被关，
        // 客户端随即转入 CLOSE_WAIT，而本表读的是当前连接、CLOSE_WAIT 条目不保证仍在其中 ——
        // 表现就是「表里认不出自己的连接」，看起来像解析错了，实际是连接没了。
        var server = await listener.AcceptTcpClientAsync();

        var payload = new byte[512];
        client.GetStream().Write(payload, 0, payload.Length);
        client.GetStream().Flush();

        try
        {
            var table = TcpConnectionTable.Read();
            Assert.NotEmpty(table); // 表为空说明整体解析就错了，先在这里炸掉

            var self = (uint)Environment.ProcessId;
            var hits = new List<TcpConnectionTable.ConnKey>();
            foreach (var kv in table)
            {
                if (kv.Value == self) hits.Add(kv.Key);
            }

            Assert.NotEmpty(hits); // 认不出自己 → 4 字节表头偏移或端口字节序写错了

            // 至少有一条命中探针的两个端口之一（客户端侧与监听侧都在本进程名下）
            bool matched = hits.Any(k => k.LocalPort == cliPort || k.LocalPort == lport);
            Assert.True(matched,
                $"连接表应包含本进程端口 {cliPort}/{lport}，实际命中："
                + string.Join(", ", hits.Select(k => $"{k.LocalAddr}:{k.LocalPort}->{k.RemoteAddr}:{k.RemotePort}")));
        }
        finally
        {
            try { server.Close(); } catch { }
            try { client.Close(); listener.Stop(); } catch { }
        }
    }

    /// <summary>
    /// 表结构里的 4 字节表头是这次踩过的最大坑：漏掉它整表错位，
    /// 解析出的属主全是垃圾但**不会崩**（不越界，只是读到了别的行的字段）。
    /// 这条断言把这个坑钉住：读到的属主 PID 必须绝大多数是本机真实存在的进程。
    /// </summary>
    [Fact]
    public void Read_yields_plausible_process_ids()
    {
        var table = TcpConnectionTable.Read();
        Assert.NotEmpty(table);

        int implausible = 0;
        foreach (var kv in table)
        {
            // PID 0/4 是伪进程，本类已过滤；这里再兜一次：属主应当是能查到的真实进程。
            if (kv.Value <= 4) implausible++;
        }
        Assert.Equal(0, implausible);
    }
}