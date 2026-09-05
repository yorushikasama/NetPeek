using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace NetPeek.Collector.Ipc;

/// <summary>
/// 命名管道的访问控制策略。
///
/// 为什么必须显式设 DACL（见 docs/技术选型.md 第 5 节「服务只暴露带 ACL 的管道」）：
/// 采集服务以 LocalSystem 运行，若用不带 PipeSecurity 的构造函数创建管道，默认 DACL
/// 允许本机任意用户连接。快照里含全部进程的可执行文件路径与流量，是一份好用的系统侦察
/// 数据；控制管道更敏感 —— 任意本地进程都能下发 pause 让监控停掉。
///
/// 授权范围：
/// - Authenticated Users：允许连接与读取（快照）/ 写入（控制命令）。
///   匿名登录与 Guest 不属于该组，低权限匿名沙箱进程因此被挡在外面。
/// - LocalSystem 与 Administrators：完全控制，保证服务自身与运维工具可用。
///
/// 注意：客户端（Rust 侧 File::open / OpenOptions.write）用的是 GENERIC_READ/WRITE，
/// 它们会展开成「数据 + 属性 + 扩展属性 + 读安全描述符」一组权限。只授 ReadData
/// 会让 GENERIC_READ 的打开请求因缺 READ_CONTROL 等位而被拒 —— 这里按
/// FILE_GENERIC_READ / FILE_GENERIC_WRITE 的展开集显式授权。
/// </summary>
[SupportedOSPlatform("windows")]
public static class PipeSecurityPolicy
{
    /// <summary>出站快照管道：客户端只需读权限（覆盖 GENERIC_READ 的展开集）。</summary>
    public static PipeSecurity CreateForOutboundSnapshot()
        => Create(PipeAccessRights.ReadData
                  | PipeAccessRights.ReadAttributes
                  | PipeAccessRights.ReadExtendedAttributes
                  | PipeAccessRights.ReadPermissions
                  | PipeAccessRights.Synchronize);

    /// <summary>
    /// 入站控制管道：客户端需要写权限，但不承载任何回读数据。
    ///
    /// 实测结论（本机 bisect 验证，2026-09-05）：GENERIC_WRITE 的标准展开
    /// （WriteData|WriteAttributes|WriteEA|READ_CONTROL|Synchronize）不足以通过
    /// .NET/Rust 客户端的打开检查，还须携带 Delete/ChangePermissions/TakeOwnership 位；
    /// 唯一可以扣下的是 CreateNewInstance（0x4）——它允许他人创建本管道的额外服务实例。
    /// 这些位只作用于控制管道对象本身，而 WriteData 本来就已授予已认证用户
    /// （pause/resume 单行文本命令），不构成超出业务意图的能力。
    /// 快照管道（敏感对象）另用最小读位集，见 <see cref="CreateForOutboundSnapshot"/>。
    /// </summary>
    public static PipeSecurity CreateForInboundControl()
        => Create((PipeAccessRights)
            ((int)PipeAccessRights.FullControl & ~(int)PipeAccessRights.CreateNewInstance));

    private static PipeSecurity Create(PipeAccessRights clientRights)
    {
        var security = new PipeSecurity();

        // 客户端（UI 以普通用户权限运行）：仅授予完成本职工作所需的最小权限。
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
            clientRights,
            AccessControlType.Allow));

        // 服务自身以 LocalSystem 运行，需要完全控制才能创建/维护管道实例。
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        return security;
    }
}
