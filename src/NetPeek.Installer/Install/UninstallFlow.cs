using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace NetPeek.Installer;

/// 卸载流程。用户拍板：**数据全部清理**（含 history.db / 设置 / WebView2 缓存）。
/// 调用方已保证管理员令牌；HKCU Run 键以提权用户身份清除——单用户机器即目标用户，
/// 多用户场景的自启残留局限记录在 docs §43。
internal sealed class UninstallFlow
{
    public sealed record Result(bool Success, string? Error, string? InstallDir = null);

    public static Result Run(Action<string>? notify = null)
    {
        try
        {
            var rawInstallDir = ReadInstallLocation() ?? Defs.DefaultInstallDir;
            // 下面要对该目录及其子目录（collector、开始菜单组）递归删除。InstallLocation 来自
            // HKLM，可能被篡改（如改成 C:\），套用安装时同一套校验挡掉盘根/系统目录/shell 元字符；
            // 校验不过说明这个值不该被递归删除，退回默认安装目录，绝不照它删。
            string installDir;
            try
            {
                installDir = InstallFlow.ValidateDir(rawInstallDir);
            }
            catch
            {
                installDir = Path.GetFullPath(Defs.DefaultInstallDir).TrimEnd('\\');
                SetupLog.Write("InstallLocation 校验未通过，退回默认目录，原值=" + rawInstallDir);
            }
            var notes = new List<string>();
            SetupLog.Write("卸载开始，安装目录=" + installDir);

            // 1) 采集服务：停 + 删（collector 进程随之退出，目录解锁）。
            //    等 STOPPED 而不是固定 Sleep：服务卡在停止中时文件锁解不开。
            if (Svc.Exists(Defs.ServiceName))
            {
                Svc.Stop(Defs.ServiceName);
                Svc.Delete(Defs.ServiceName);
                if (!Svc.WaitStopped(Defs.ServiceName, 10_000))
                    notes.Add("采集服务停止超时，部分文件可能残留（重启后可再删）");
                notes.Add("已移除采集服务");
            }

            // 2) 主应用还在跑：先关（同安装流的降权/强杀策略，Kill 后等退出再动文件）
            InstallFlow.KillApp(installDir, "NetPeek", notes);

            // 3) 删除程序文件（setup.exe 是运行中的自己，留给 SelfDelete）
            var appExe = Path.Combine(installDir, Defs.AppExeName);
            if (File.Exists(appExe)) { File.Delete(appExe); notes.Add("已删除主程序"); }
            var collectorDir = Path.Combine(installDir, Defs.CollectorRelDir);
            if (Directory.Exists(collectorDir)) { Directory.Delete(collectorDir, recursive: true); notes.Add("已删除采集服务文件"); }

            // 3.5) 安装目录里的安装器副本：从别处（如 Downloads）跑 --uninstall 时
            //      没人清它，会留一个几 MB 的孤儿。当前进程就是这份副本时跳过 ——
            //      运行中的映像删不掉，那是 SelfDelete 的活。
            var setupCopy = Path.Combine(installDir, Defs.SetupExeName);
            var self = Environment.ProcessPath;
            if (File.Exists(setupCopy) && (self is null ||
                !string.Equals(Path.GetFullPath(self), setupCopy, StringComparison.OrdinalIgnoreCase)))
            {
                try { File.Delete(setupCopy); notes.Add("已删除安装器副本"); }
                catch { /* 被占用等场景留给 SelfDelete 或用户 */ }
            }

            // 4) 快捷方式：开始菜单组整个删 + 桌面散链
            var programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "NetPeek");
            if (Directory.Exists(programs)) Directory.Delete(programs, recursive: true);
            var desktopLnk = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "NetPeek.lnk");
            if (File.Exists(desktopLnk)) File.Delete(desktopLnk);
            notes.Add("已删除快捷方式");

            // 5) 卸载键与自启键
            Registry.LocalMachine.DeleteSubKeyTree(Defs.UninstallKeyPath, throwOnMissingSubKey: false);
            using (var runKey = Registry.CurrentUser.OpenSubKey(Defs.RunKeyPath, writable: true))
            {
                runKey?.DeleteValue(Defs.RunValueName, throwOnMissingValue: false);
            }
            notes.Add("已清除注册表项");

            // 6) 数据目录全清（用户拍板）。主应用已关，理论上无文件锁；
            //    杀不干净的残留让用户重启后再装/清，不在这里反复搏斗。
            //    Tauri 的数据分居两处（复审实证）：Roaming 下是历史库/设置/背景图，
            //    Local 下是 EBWebView —— WebView2 的用户数据目录（缓存/存储）。
            //    只删 Roaming 的话 WebView2 缓存整目录残留，与「数据全部清理」不符。
            var appData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Defs.AppDataDirName);
            if (Directory.Exists(appData))
            {
                Directory.Delete(appData, recursive: true);
                notes.Add("已清除全部数据（历史/设置/缓存）");
            }
            var localData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Defs.AppDataDirName);
            if (Directory.Exists(localData))
            {
                Directory.Delete(localData, recursive: true);
                notes.Add("已清除 WebView2 缓存");
            }

            if (notify is not null) notify(string.Join("\n", notes));
            SetupLog.Write("卸载完成：" + string.Join("；", notes));
            return new Result(true, null, installDir);
        }
        catch (Exception ex)
        {
            SetupLog.Write("卸载失败：" + ex.Message);
            return new Result(false, ex.Message, null);
        }
    }

    /// 卸载结束后延迟自删 setup.exe 并尽量清掉安装目录空壳。
    /// setup.exe 正在运行删不掉自己，经典做法：cmd 用 ping 当 sleep，等本进程退出后删。
    /// 目录递归删除**只在卸载器确实住在安装目录里时**才做：若有人对下载目录里的
    /// setup.exe 手动跑卸载参数，没有这个守卫会 rd 掉整个下载目录（对照缺口调研修的）。
    ///
    /// 时序给了两段：等 5 秒（WPF 进程退出 + MessageBox 收尾），del 一轮；再等 2 秒
    /// 重试一轮 del（首次时 AV 扫描/句柄释放慢是常见翻车点），最后才 rd 目录。
    /// rd 只在目录非空时会失败，失败即留空壳目录，可接受（尽删语义）。
    public static void SelfDelete(string? installDir)
    {
        var exe = Environment.ProcessPath;
        if (exe is null) return;
        var dir = Path.GetDirectoryName(exe);

        // 路径要拼进 cmd /c 字符串，含 & | ^ < > " % 会造成命令拆分/注入（在卸载器的
        // 提权上下文里尤其危险）。exe 路径与 installDir 均可能来源于外部（进程路径、注册表
        // InstallLocation），拼串前逐个校验，命中即放弃自删（残留一个可手动删的 setup.exe，
        // 远好过执行注入命令）。
        static bool HasCmdMeta(string s) => s.IndexOfAny(new[] { '&', '|', '^', '<', '>', '"', '%' }) >= 0;
        if (HasCmdMeta(exe)) return;

        var args = $"/c ping -n 5 127.0.0.1 > nul & del /f /q \"{exe}\"" +
                   $" & ping -n 2 127.0.0.1 > nul & del /f /q \"{exe}\"";
        if (dir is not null && !HasCmdMeta(dir) && installDir is not null &&
            string.Equals(
                Path.GetFullPath(dir).TrimEnd('\\'),
                Path.GetFullPath(installDir).TrimEnd('\\'),
                StringComparison.OrdinalIgnoreCase))
        {
            args += $" & rd /s /q \"{dir}\"";
        }
        Process.Start(new ProcessStartInfo("cmd.exe", args)
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        });
    }

    private static string? ReadInstallLocation()
    {
        using var key = Registry.LocalMachine.OpenSubKey(Defs.UninstallKeyPath);
        return key?.GetValue("InstallLocation") as string;
    }
}
