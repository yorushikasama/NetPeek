using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Extensions.Logging;

namespace NetPeek.Collector.Ipc;

/// <summary>
/// 命名管道 ACL：Windows 默认 DACL 不收紧，本机任意进程都能连上快照管道读流量数据、
/// 连控制管道下发 pause/resume。这里显式限制为「SYSTEM 完全控制 + 内置 Users 最小权限」，
/// 把跨用户会话与显式降权进程的连接挡在外面。
/// 权限按管道方向给最小集：快照管道（服务端 Out）客户端只需 Read；
/// 控制管道（服务端 In）客户端只需 Write。
/// </summary>
internal static class PipeAcl
{
    private const int SeKernelObject = 6;
    private const uint DaclSecurityInformation = 0x00000004;
    private const uint SddlRevision1 = 1;

    /// <summary>已记录过安全描述符的管道名。控制管道每服务完一个客户端就会重建实例，
    /// 逐次打印会把日志刷满，所以每条管道只记一次。</summary>
    private static readonly HashSet<string> Logged = new();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint GetSecurityInfo(
        IntPtr handle,
        int objectType,
        uint securityInfo,
        out IntPtr owner,
        out IntPtr group,
        out IntPtr dacl,
        out IntPtr sacl,
        out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr securityDescriptor,
        uint revision,
        uint securityInfo,
        out IntPtr stringSecurityDescriptor,
        out uint stringLength);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr handle);

    /// <summary>读回管道对象**实际生效**的 DACL（而不是我们构造的那个对象）。</summary>
    private static string? ReadActualDacl(IntPtr handle)
    {
        IntPtr sd = IntPtr.Zero;
        uint rc = GetSecurityInfo(handle, SeKernelObject, DaclSecurityInformation,
            out _, out _, out _, out _, out sd);
        if (rc != 0 || sd == IntPtr.Zero)
        {
            return $"<GetSecurityInfo 失败 rc={rc}>";
        }

        try
        {
            // 只取 DACL 一段（DACL_SECURITY_INFORMATION），owner/group 由 GetSecurityInfo 另给。
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(
                    sd, SddlRevision1, DaclSecurityInformation, out IntPtr str, out _))
            {
                return $"<转换 SDDL 失败 err={Marshal.GetLastWin32Error()}>";
            }

            try
            {
                return Marshal.PtrToStringUni(str) ?? "<null>";
            }
            finally
            {
                LocalFree(str);
            }
        }
        finally
        {
            LocalFree(sd);
        }
    }

    public static NamedPipeServerStream CreateServer(string name, PipeDirection direction, ILogger? logger = null)
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl,
            AccessControlType.Allow));

        // 客户端权限不能只给 Write：内核打开**任何**文件对象时都要读基本属性
        // （FILE_READ_ATTRIBUTES），缺这一位会让 CreateFile 整体返回 ERROR_ACCESS_DENIED，
        // 表现为「命令静默丢弃、暂停按钮没反应」。.NET 的 PipeAccessRights.Read 自带这一位，
        // PipeAccessRights.Write 却不在其中 —— 于是快照管道（Read）能连、控制管道（Write）连不上。
        // 实测：加回 ReadAttributes 之前，客户端即便按 ACL 全集请求也被拒。
        var clientRights = direction == PipeDirection.Out
            ? PipeAccessRights.Read
            : PipeAccessRights.Write | PipeAccessRights.ReadAttributes;
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
            clientRights,
            AccessControlType.Allow));

        // .NET 8 上带 ACL 的创建走 NamedPipeServerStreamAcl.Create（构造重载仅 .NET Framework 有）。
        var stream = NamedPipeServerStreamAcl.Create(
            name,
            direction,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            inBufferSize: 0,
            outBufferSize: 0,
            security);

        if (logger is not null)
        {
            bool first;
            lock (Logged)
            {
                first = Logged.Add(name);
            }

            if (first)
            {
                logger.LogInformation(
                    "管道 {Name}：direction={Direction} clientRights=0x{Rights:X8} 构造 SDDL={Wanted} 实际 SDDL={Actual}",
                    name,
                    direction,
                    (int)clientRights,
                    security.GetSecurityDescriptorSddlForm(AccessControlSections.All),
                    ReadActualDacl(stream.SafePipeHandle.DangerousGetHandle()));
            }
        }

        return stream;
    }
}
