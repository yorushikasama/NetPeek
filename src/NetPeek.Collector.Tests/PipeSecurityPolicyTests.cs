using System.Text.RegularExpressions;
using Xunit;
using NetPeek.Collector.Ipc;

namespace NetPeek.Collector.Tests;

/// <summary>
/// 管道 DACL 策略测试。
///
/// 断言基于 SDDL 文本而非 ACL 类型（PipeSecurity 等）：
/// - SDDL 掩码与 PipeAccessRights 位值一一对应，可精确断言授权范围；
/// - 本机 SDK 8.0.424 环境里测试工程对这些类型存在绑定异常（同一引用 Collector
///   能编译、测试工程报 CS0246，疑与空的 targeting pack 8.0.424 有关，
///   详见仓库根 Directory.Build.props），反射 + SDDL 从根上绕开该问题。
///
/// 掩码依据（本机对 GENERIC_READ/WRITE 打开行为的逐位实测）：
/// - 快照管道客户端 = GENERIC_READ 展开集
///   ReadData(0x1)|ReadEA(0x8)|ReadAttributes(0x80)|READ_CONTROL(0x20000)|Synchronize(0x100000) = 0x120089；
/// - 控制管道客户端 = FullControl(0x1F019F) 扣除 CreateNewInstance(0x4) = 0x1F019B
///   （实测 GENERIC_WRITE 打开还须携带 Delete/READ_CONTROL/WRITE_DAC/TakeOwnership 位）。
/// </summary>
public class PipeSecurityPolicyTests
{
    private const int FullControl = 0x1F019F;
    private const int CreateNewInstance = 0x4;

    private static string SddlOf(object security)
    {
        // ObjectSecurity.GetSecurityDescriptorSddlForm(AccessControlSections.All)
        var method = security.GetType().GetMethods()
            .Single(m => m.Name == "GetSecurityDescriptorSddlForm" && m.GetParameters().Length == 1);
        var sections = Enum.ToObject(method.GetParameters()[0].ParameterType, 7 /* All */);
        return (string)method.Invoke(security, new[] { sections })!;
    }

    private static int AceMask(string sddl, string sid)
    {
        var match = Regex.Match(sddl, $@"\(A;;([0-9A-Za-z]+);;;{sid}\)");
        Assert.True(match.Success, $"DACL 中未找到 {sid} 的允许 ACE：{sddl}");
        var token = match.Groups[1].Value;
        return token.ToLowerInvariant() switch
        {
            // .NET 会把恰好等于标准组合的掩码规范化为 SDDL 字母
            "fr" => 0x120089, // FILE_GENERIC_READ == ReadData|ReadEA|ReadAttributes|READ_CONTROL|Synchronize
            "fw" => 0x120116, // FILE_GENERIC_WRITE
            var hex => Convert.ToInt32(hex.StartsWith("0x") ? hex[2..] : hex, 16),
        };
    }

    private static void AssertSystemAndAdminsFullControl(string sddl)
    {
        Assert.Equal(FullControl, AceMask(sddl, "SY"));
        Assert.Equal(FullControl, AceMask(sddl, "BA"));
    }

    [Fact]
    public void Snapshot_dacl_grants_exact_generic_read_expansion()
    {
        var sddl = SddlOf(PipeSecurityPolicy.CreateForOutboundSnapshot());
        var client = AceMask(sddl, "AU");

        const int expected = 0x1       // ReadData
                           | 0x8       // ReadExtendedAttributes
                           | 0x80      // ReadAttributes
                           | 0x20000   // ReadPermissions (READ_CONTROL)
                           | 0x100000; // Synchronize
        Assert.Equal(expected, client);
        // 快照管道绝不能授予写能力
        Assert.Equal(0, client & 0x2 /* WriteData */);
        Assert.Equal(0, client & CreateNewInstance);
        AssertSystemAndAdminsFullControl(sddl);
    }

    [Fact]
    public void Control_dacl_excludes_create_new_instance()
    {
        var sddl = SddlOf(PipeSecurityPolicy.CreateForInboundControl());
        var client = AceMask(sddl, "AU");

        Assert.Equal(FullControl & ~CreateNewInstance, client);
        Assert.Equal(0, client & CreateNewInstance);
        AssertSystemAndAdminsFullControl(sddl);
    }
}
