using System.Diagnostics;
using System.Security.Principal;

namespace NetPeek.Installer;

internal static class Elevation
{
    /// 当前进程是否持管理员令牌。
    public static bool IsElevated()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    /// 用 runas 重启自己并携带原参数。返回 false = 用户拒绝 UAC（本进程应安静退出）。
    public static bool RelaunchElevated(string[] args)
    {
        var exe = Environment.ProcessPath ?? Process.GetCurrentProcess().MainModule?.FileName;
        if (exe is null) return false;
        try
        {
            // 用 ArgumentList 而不是手工拼 Arguments 字符串：手写 Quote 不处理内嵌 " 与
            // 末尾 \（"...\" 里的末尾反斜杠会转义掉收尾引号，导致参数被拆/被注入）。
            // ArgumentList 由运行时按 Windows CommandLineToArgvW 规则正确转义，跨 UAC 边界安全。
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = true,
                Verb = "runas",
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            Process.Start(psi);
            return true;
        }
        catch (System.ComponentModel.Win32Exception) { return false; } // UAC 被拒绝
        catch (Exception) { return false; }
    }
}
