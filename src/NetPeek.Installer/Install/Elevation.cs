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
            var psi = new ProcessStartInfo(exe)
            {
                Arguments = string.Join(' ', args.Select(Quote)),
                UseShellExecute = true,
                Verb = "runas",
            };
            Process.Start(psi);
            return true;
        }
        catch (System.ComponentModel.Win32Exception) { return false; } // UAC 被拒绝
        catch (Exception) { return false; }
    }

    private static string Quote(string s) => s.Contains(' ') ? "\"" + s + "\"" : s;
}
