using System.Net;
using NetPeek.Collector.Sources;
using Xunit;

namespace NetPeek.Collector.Tests;

/// <summary>
/// 回环流量过滤的回归（2026-09-22）。
///
/// 背景：用户问「java / idea64 在传什么」，实测两个 JDK 进程（JPS 编译守护 + Maven）
/// 名下**全部** socket 都是 127.0.0.1，一个字节都没出网卡；可 ETW 内核网络事件不区分
/// 物理网卡与回环，只要过 TCP/IP 栈就报，于是编译期的 IDE↔JVM IPC 被归因成 `java` 的
/// 网络流量，界面上表现为「java 一直在传数据」。
///
/// 而 <see cref="InterfaceCounters"/> 那侧**已经**排除了回环接口，两侧口径不一致：
/// 归因侧算了回环、基准侧没算，差额恒为负 → 被 ComputeUnattributed 钳到 0 →
/// 「系统/未归因」永远显示不出来。所以这不只是「多算了一点」，是把那一栏废掉。
///
/// 这里只测纯判定函数：它不依赖 ETW 会话（那需要管理员且不可复现），
/// 输入输出完全确定，正是适合做回归的那部分。
/// </summary>
public class EtwLoopbackTests
{
    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("127.0.0.53")]   // systemd-resolved 那种非 .1 的回环地址
    [InlineData("127.255.255.254")] // 整个 127/8 都是回环，不能只认 127.0.0.1
    [InlineData("::1")]
    [InlineData("::ffff:127.0.0.1")] // IPv4-mapped：双栈 socket 上常见的形态
    public void Loopback_addresses_are_detected(string ip)
    {
        Assert.True(EtwSnapshotSource.IsLoopback(IPAddress.Parse(ip)), $"{ip} 应判为回环");
    }

    [Theory]
    [InlineData("0.0.0.0")]
    [InlineData("192.168.100.100")]
    [InlineData("116.129.226.27")]   // 实测 idea64 连的那台
    [InlineData("8.8.8.8")]
    [InlineData("172.217.160.78")]   // 常见非回环公网地址，防 127/8 判定写宽
    [InlineData("::")]
    [InlineData("2001:4860:4860::8888")]
    [InlineData("::ffff:192.168.1.1")] // mapped 但非回环，不能被误判
    [InlineData("fe80::1")]
    public void Non_loopback_addresses_are_not_flagged(string ip)
    {
        Assert.False(EtwSnapshotSource.IsLoopback(IPAddress.Parse(ip)), $"{ip} 不应判为回环");
    }

    [Fact]
    public void Null_address_is_not_loopback()
    {
        // ETW 载荷里地址可能缺失（某些事件类型不带端点）。缺地址不等于回环 ——
        // 判成回环会把这类流量整段丢掉，是静默的数据损失。
        Assert.False(EtwSnapshotSource.IsLoopback(null));
    }

    [Fact]
    public void Loopback_is_not_flagged_by_string_prefix()
    {
        // 「1270.0.0.1」不是合法 IP，但 127.0.0.10 是回环、而 12.7.0.1 不是。
        // 这条钉住「按字节判 127/8」而不是按字符串前缀判 —— 后者会把 12.7.x.x 误伤。
        Assert.True(EtwSnapshotSource.IsLoopback(IPAddress.Parse("127.0.0.10")));
        Assert.False(EtwSnapshotSource.IsLoopback(IPAddress.Parse("12.7.0.1")));
    }
}
