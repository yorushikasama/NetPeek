using System.Net;
using NetPeek.Collector.Sources;
using Xunit;

namespace NetPeek.Collector.Tests;

/// <summary>
/// TCP 属主校正的回归（2026-10-10）。
///
/// 背景：按进程归因的前提被实测推翻了。ETW 的 <c>TcpIpSend/Recv</c> 事件里
/// <c>data.ProcessID</c> 读的是 <c>EVENT_HEADER.ProcessId</c>，该字段**不总是
/// socket 属主**——内核在协议栈线程上打点时它压根不是发起进程。本机实测
/// （一个已知属主的进程发 65,536 字节外网 TCP）：记到自身名下 **0 字节**，
/// 全部落到 ZCode / System / msedge 名下；同批 UDP 则是 163,840/163,840 全对；
/// 回环 TCP 则是 786,432/786,432 全对（对照组）。
///
/// 所以 TCP 改用四元组查系统连接表校正属主（<see cref="TcpConnectionTable"/>），
/// UDP 不查表（已准确，且 UDP 表远大于 TCP 表）。
///
/// 这里测的是**校正用键的构造**——即「ETW 事件的四元组」与「连接表的四元组」
/// 能不能落进同一个 <see cref="TcpConnectionTable.ConnKey"/>。这一层是纯逻辑，
/// 完全确定；而两端各自的「取表」与「取事件」都依赖真实系统状态，不适合做单测。
/// 真机上「校正确实把字节搬回了属主」的那一跳由 verify-etw-scenarios.ps1 与
/// 手工验收覆盖。
/// </summary>
public class TcpAttributionTests
{
    /// <summary>
    /// 端到端实测里抓到的真实事件与表条目（原样保留，不是编造的）：
    /// 事件的 (saddr, sport, daddr, dport) 必须能在表里找到同一条。
    /// 端口那两对是这个 bug 最容易翻车的地方：初版把表里的端口按网络序做了字节
    /// 交换，命中率恒为 0；后来实测又确认那次「修正」本身也是反的（表里确实是网络序）。
    /// 两个坑叠在一起才让现象显得莫名其妙：① 4 字节表头；② 端口网络序。
    /// </summary>
    [Fact]
    public void Etw_event_tuple_and_table_entry_produce_the_same_key()
    {
        // 表里的一条真实条目（本机 2026-10-10 实测，pid=23676 的那条 ESTABLISHED）：
        // 客户端端口 51754，服务端端口 51753，两端都在本进程名下。
        var tableKey = new TcpConnectionTable.ConnKey(
            0x0100007F,   // localAddr  = 127.0.0.1
            51754,        // localPort
            0x0100007F,   // remoteAddr = 127.0.0.1
            51753,        // remotePort
            false);       // isV6

        // ETW 事件给出的四元组：同一连接，本地/远端不互换（收发两个方向都这样）
        var fromEvent = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("127.0.0.1"), 51754,
            IPAddress.Parse("127.0.0.1"), 51753);

        Assert.Equal(tableKey, fromEvent);
    }

    [Fact]
    public void Event_and_receive_of_one_connection_share_the_same_key()
    {
        // 连接的本地/远端在收发两个方向上是同一对（不是互换的）——
        // 这正是校正能对收发都生效的前提。若这里不成立，收发会查成两个不同连接。
        var send = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("10.104.2.66"), 56723,
            IPAddress.Parse("103.117.139.31"), 443);
        var recv = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("10.104.2.66"), 56723,
            IPAddress.Parse("103.117.139.31"), 443);
        Assert.Equal(send, recv);
    }

    [Fact]
    public void Different_connections_do_not_collide()
    {
        var a = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("1.1.1.1"), 443);
        var b = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("10.0.0.5"), 1235, IPAddress.Parse("1.1.1.1"), 443);
        var c = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("2.2.2.2"), 443);
        var d = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("10.0.0.5"), 1234, IPAddress.Parse("1.1.1.1"), 80);

        Assert.NotEqual(a, b); // 端口不同
        Assert.NotEqual(a, c); // 远端地址不同
        Assert.NotEqual(a, d); // 远端端口不同
    }

    /// <summary>
    /// IPv4 与 IPv6 不能撞键。0.0.0.0 与 :: 都是全零地址，
    /// 若键里不带族信息，两族的所有零地址条目会全部混成一个键，
    /// 校正会把 IPv6 流量记到 IPv4 连接（或反过来）的属主名下。
    /// </summary>
    [Fact]
    public void Address_families_never_collide_even_at_zero()
    {
        var v4 = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("0.0.0.0"), 0, IPAddress.Parse("0.0.0.0"), 0);
        var v6 = TcpConnectionTable.ConnKey.Create(
            IPAddress.Parse("::"), 0, IPAddress.Parse("::"), 0);

        Assert.NotEqual(v4, v6);
        Assert.False(v4.IsV6);
        Assert.True(v6.IsV6);
    }

    /// <summary>
    /// 真实系统上读到的表必须包含本进程自己建立的连接 —— 这是校正生效的前提。
    /// 不需要 ETW 会话，普通权限即可运行，因此 CI 里也能真跑。
    ///
    /// 顺序有讲究：先 listen → 再 connect → 最后 accept。反过来（先 accept）会死等，
    /// 因为 connect 还没发生、没人来连。
    /// </summary>
    [Fact]
    public async System.Threading.Tasks.Task Table_contains_a_connection_owned_by_this_process()
    {
        var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            int lport = ((IPEndPoint)listener.LocalEndpoint!).Port;

            var client = new System.Net.Sockets.TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, lport);
            int clientPort = ((IPEndPoint)client.Client.LocalEndPoint!).Port;
            var server = await listener.AcceptTcpClientAsync();

            var buf = new byte[4096];
            await client.GetStream().WriteAsync(buf, 0, buf.Length);

            var table = TcpConnectionTable.Read();
            Assert.NotEmpty(table);

            bool found = table.Keys.Any(k => k.LocalPort == clientPort || k.LocalPort == lport);
            Assert.True(found,
                $"连接表应包含本进程的回环连接（端口 {clientPort}/{lport}），共读到 {table.Count} 条");

            // 结构错位时属主会读成 0/4 之类的伪进程，这里一并守住。
            Assert.DoesNotContain(table.Values, v => v <= 4);

            client.Close();
            server.Close();
        }
        finally
        {
            try { listener.Stop(); } catch { }
        }
    }
}