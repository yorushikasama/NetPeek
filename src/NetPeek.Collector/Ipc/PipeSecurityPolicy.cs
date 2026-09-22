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
    /// 入站控制管道：客户端只需写权限，不承载任何回读数据。
    ///
    /// 授予与客户端实际请求**逐位对齐**的最小集：WriteData | ReadAttributes | Synchronize。
    /// 这正是 Rust 客户端（pipe.rs::send_control）用 access_mode 精确请求的三位
    /// （FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE）—— 客户端不再走 GENERIC_WRITE
    /// 的宽展开，服务端也就不必再授 Delete/ChangePermissions/TakeOwnership。
    ///
    /// 早先这里授 FullControl&amp;~CreateNewInstance，是在客户端仍用 GENERIC_WRITE 时期
    /// bisect 出来的宽集；客户端改用 access_mode 精确请求后，那几位（WRITE_DAC/WRITE_OWNER/
    /// DELETE）就成了多余且危险的授权——任意已认证用户可改写本管道 DACL 或夺取所有权。
    /// 现按最小集授权，与 <see cref="CreateForOutboundSnapshot"/>（最小读位集）同一原则。
    /// </summary>
    public static PipeSecurity CreateForInboundControl()
        => Create(PipeAccessRights.WriteData
                  | PipeAccessRights.ReadAttributes
                  | PipeAccessRights.Synchronize);

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
