using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace NetPeek.Installer;

/// 一次安装的全部步骤。UI 层逐步驱动（步骤打勾 + 进度条）；
/// --preview 模式复用同一份步骤列表但只走标题不执行动作。
internal sealed class InstallFlow
{
    public sealed record Step(string Title, Func<string> Run);

    public string InstallDir { get; }
    public bool DesktopShortcut { get; init; } = true;

    public InstallFlow(string installDir, bool desktopShortcut = true)
    {
        InstallDir = installDir;
    }

    /// 步骤按依赖排序：先清场（旧版/旧服务），再写文件（此时文件锁一定已释放），
    /// 然后是 WebView2 运行时（主程序没它起不来）、建服务、快捷方式、卸载键。
    /// 任何一步抛异常都中止安装并在 UI 报告原因（外加 Compensate 补偿清理）。
    public List<Step> BuildSteps() => new()
    {
        new("清理旧版本", RemoveLegacy),
        new("解压程序文件", WriteFiles),
        new("确保 WebView2 运行时", EnsureWebView2),
        new("安装并启动采集服务", SetupService),
        new("创建快捷方式", CreateShortcuts),
        new("登记卸载信息", WriteUninstallKey),
    };

    /// 安装目录防呆：拒绝盘根与系统目录本身，避免用户把「安装到」选成
    /// C:\Program Files 之类的一级目录后被 rd /s /q 误伤。
    ///
    /// 盘根判定不能只枚举 C:\：多盘机器把目录选成 D:\、E:\ 同样能通过校验，
    /// 而卸载器 SelfDelete 对「安装目录里的 setup.exe」会 rd /s /q 整个目录 ——
    /// 装在盘根等于授权它删整个盘。所以这里用 GetPathRoot 通用判定，任何盘根都拒。
    public static string ValidateDir(string dir)
    {
        var full = Path.GetFullPath(dir).TrimEnd('\\');
        var root = Path.GetPathRoot(full)?.TrimEnd('\\');
        if (!string.IsNullOrEmpty(root) &&
            string.Equals(root, full, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("不能安装到盘根目录，请选择一个专用子目录。");

        var protectedRoots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            @"C:\",
            @"C:",
        };
        if (protectedRoots.Any(r => string.Equals(Path.GetFullPath(r).TrimEnd('\\'), full, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("不能安装到该目录（系统目录或盘根），请选择一个专用子目录。");
        return full;
    }

    private string RemoveLegacy()
    {
        var notes = new List<string>();

        // 1) MSI 时代（WiX）：按 DisplayName 枚举出 ProductCode，静默卸载。
        //    upgradeCode 不能直接喂给 msiexec /x，必须找真正的 ProductCode。
        foreach (var code in FindMsiProductCodes(Defs.LegacyMsiDisplayName))
        {
            RunMsiexec($"/x {code} /qn /norestart");
            notes.Add("已卸载旧 MSI 版 " + code);
        }

        // 2) 主应用还在跑（覆盖安装/升级）：关窗口 → 等待 → 强杀（托盘常驻会让
        //    CloseMainWindow 只隐藏不退出，所以超时必须 Kill，否则文件写入撞锁）。
        KillApp(InstallDir, Defs.AppExeName, notes);

        // 3) 旧采集服务：停 + 删。此时 Collector 进程随服务退出，collector 目录解锁。
        if (Svc.Exists(Defs.ServiceName))
        {
            Svc.Stop(Defs.ServiceName);
            var del = Svc.Delete(Defs.ServiceName);
            // 等 STOPPED 而不是固定 Sleep：卡在 STOP_PENDING 的服务只被 sc delete
            // 标记删除，紧接着重建同名服务会撞 1072。等不到不在这里中止 —— 下面
            // SetupService 还有一次兜底，那里才把「等不到」升级为可操作的报错。
            if (!Svc.WaitStopped(Defs.ServiceName, 10_000))
                notes.Add("旧服务未在 10 秒内完全停止，重建同名服务可能失败（重启系统后可解）");
            notes.Add(del.Ok ? "已移除旧服务" : "旧服务移除返回非零（视为不存在）：" + del.Output);
        }
        return string.Join("；", notes.Count > 0 ? notes : ["没有发现旧版本"]);
    }

    private string WriteFiles()
    {
        Directory.CreateDirectory(InstallDir);
        Directory.CreateDirectory(Path.Combine(InstallDir, Defs.CollectorRelDir));
        File.WriteAllBytes(Path.Combine(InstallDir, Defs.AppExeName), Payload.Read(Payload.AppResource));
        File.WriteAllBytes(Path.Combine(InstallDir, Defs.CollectorExeRelPath), Payload.Read(Payload.CollectorResource));

        // 卸载器自复制：UninstallString 与开始菜单「卸载」快捷方式都指向
        // 安装目录里的这份。NSIS/Inno 都会把卸载器装进 $INSTDIR——漏了这步，
        // 控制面板点卸载就是对一个不存在的文件报错（对照业界标准查出的缺口）。
        // 正在运行的 exe 可读共享，Copy 源自 Downloads 也没问题。
        var self = Environment.ProcessPath;
        if (self is not null && !string.Equals(
                Path.GetFullPath(self), Path.Combine(InstallDir, Defs.SetupExeName),
                StringComparison.OrdinalIgnoreCase))
        {
            File.Copy(self, Path.Combine(InstallDir, Defs.SetupExeName), overwrite: true);
        }
        return InstallDir;
    }

    /// WebView2 运行时保障（对照微软官方分发文档实现的 downloadBootstrapper 等效流程）：
    /// 已装则秒过；缺失则下载官方引导器静默安装。Tauri 自研安装器不实现这步
    /// 等效于官方标注不推荐的 skip 模式，精简系统上主程序会白窗闪退。
    private string EnsureWebView2()
    {
        var installed = WebView2Runtime.FindVersion();
        if (installed is not null) return "已存在 " + installed;

        WebView2Runtime.InstallViaBootstrapper();
        var now = WebView2Runtime.FindVersion();
        return now is null
            ? "引导器执行完毕但未检出运行时（主程序可能需要重启后再开）"
            : "已自动安装 " + now;
    }

    private string SetupService()
    {
        var bin = Path.Combine(InstallDir, Defs.CollectorExeRelPath);

        // 双保险：上面 RemoveLegacy 已删过，这里再查一次——目录选择变化等场景下
        // 旧服务可能还指向别的安装位置。
        if (Svc.Exists(Defs.ServiceName))
        {
            Svc.Stop(Defs.ServiceName);
            Svc.Delete(Defs.ServiceName);
            if (!Svc.WaitStopped(Defs.ServiceName, 10_000))
                throw new InvalidOperationException(
                    "旧采集服务未能在 10 秒内停止（可能卡在「停止中」状态），请重启系统后重新运行安装程序。");
        }

        var create = Svc.Create(Defs.ServiceName, bin);
        if (!create.Ok)
            throw new InvalidOperationException(
                "创建采集服务失败：" + create.Output +
                "。若提示服务已存在或已标记删除，通常是旧服务尚未完全停止，请重启系统后重试。");
        Svc.SetDescription(Defs.ServiceName, Defs.ServiceDescription);
        // 故障自恢复：采集端崩溃后 60 秒自动拉起，监控工具不该等人手动重启服务
        Svc.Recover(Defs.ServiceName);

        var start = Svc.Start(Defs.ServiceName);
        if (!start.Ok) throw new InvalidOperationException("采集服务启动失败：" + start.Output);
        // 启动成功即返回；RUNNING 状态由主应用界面在线呈现（快照驱动），这里不轮询。
        return Defs.ServiceName + "（自动启动）";
    }

    private string CreateShortcuts()
    {
        var exe = Path.Combine(InstallDir, Defs.AppExeName);
        var setup = Path.Combine(InstallDir, Defs.SetupExeName);

        var programs = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Programs), "NetPeek");
        Directory.CreateDirectory(programs);
        CreateLnk(exe, Path.Combine(programs, "NetPeek.lnk"), "NetPeek 网络流量监控", iconTarget: exe);
        CreateLnk(setup, Path.Combine(programs, "卸载 NetPeek.lnk"), "卸载 NetPeek", args: "--uninstall", iconTarget: exe);

        if (DesktopShortcut)
        {
            CreateLnk(exe,
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "NetPeek.lnk"),
                "NetPeek 网络流量监控", iconTarget: exe);
        }
        return DesktopShortcut ? "开始菜单 + 桌面" : "开始菜单";
    }

    private string WriteUninstallKey()
    {
        var setup = Path.Combine(InstallDir, Defs.SetupExeName);
        var exe = Path.Combine(InstallDir, Defs.AppExeName);
        using var key = Registry.LocalMachine.CreateSubKey(Defs.UninstallKeyPath, writable: true);
        key.SetValue("DisplayName", "NetPeek");
        key.SetValue("DisplayVersion", VersionText());
        key.SetValue("DisplayIcon", exe + ",0");
        key.SetValue("InstallLocation", InstallDir);
        key.SetValue("UninstallString", "\"" + setup + "\" --uninstall");
        key.SetValue("QuietUninstallString", "\"" + setup + "\" --uninstall --silent");
        key.SetValue("Publisher", Defs.Publisher);
        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        // 只问大小不取内容：这里再 Read 一遍等于把 ~52MB payload 白白 memcpy 进内存
        var sizeKb = (Payload.SizeOf(Payload.AppResource) + Payload.SizeOf(Payload.CollectorResource)) / 1024;
        key.SetValue("EstimatedSize", (int)Math.Min(sizeKb, int.MaxValue), RegistryValueKind.DWord); // 控制面板按 KB 计
        return "HKLM\\" + Defs.UninstallKeyPath;
    }

    // ---------- 公用小件 ----------

    public static string VersionText() =>
        System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.1.0";

    /// 枚举 HKLM 卸载键，按 DisplayName 找 MSI 的 ProductCode（UninstallString 里的 GUID）。
    /// 64 位与 32 位视图都扫：当前 MSI 是 Win64=yes（键在 64 位视图），但把 32 位视图
    /// 也扫上没有成本，未来若出 x86 包迁移不掉才是真坑。
    private static List<string> FindMsiProductCodes(string displayName)
    {
        var codes = new List<string>();
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
            using var root = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
            if (root is null) continue;
            foreach (var sub in root.GetSubKeyNames())
            {
                using var k = root.OpenSubKey(sub);
                if (k?.GetValue("DisplayName") as string is not { } name) continue;
                if (!string.Equals(name.Trim(), displayName, StringComparison.OrdinalIgnoreCase)) continue;
                var uninstallString = k.GetValue("UninstallString") as string ?? "";
                if (!uninstallString.Contains("msiexec", StringComparison.OrdinalIgnoreCase)) continue;
                var m = Regex.Match(uninstallString, @"\{[0-9A-Fa-f\-]{36}\}");
                if (m.Success && !codes.Contains(m.Value)) codes.Add(m.Value);
            }
        }
        return codes;
    }

    private static void RunMsiexec(string args)
    {
        using var p = Process.Start(new ProcessStartInfo("msiexec", args)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        })!;
        if (!p.WaitForExit(120_000))
        {
            try { p.Kill(entireProcessTree: true); } catch { /* 已退出等场景忽略 */ }
            throw new InvalidOperationException("旧 MSI 卸载超时（120 秒未完成），已终止 msiexec；请重启系统后重新运行安装程序。");
        }
        // 0 = 成功；3010 = 成功但需重启（旧文件可能仍被占用，真撞锁会在写文件一步
        // 带上下文报错）。其余退出码（1603 权限失败、1602 用户取消…）是真失败：
        // 不查就会误报「已卸载旧 MSI 版」，控制面板残留双卸载入口（二次复审 P2）。
        var msiCode = p.ExitCode;
        if (msiCode != 0 && msiCode != 3010)
            throw new InvalidOperationException(
                $"旧 MSI 卸载失败（msiexec 退出码 {msiCode}）。请先在「设置 - 应用」里手动卸载旧版 NetPeek，再重新运行安装程序。");
    }

    /// 关掉指定名字的主应用进程。只杀 exe 路径落在目标目录里的实例：dev 版
    /// （D:\NetPeek\...）天然不在安装目录，不会误伤 —— §39.4 的并存语义保持。
    public static void KillApp(string installDir, string processName, List<string>? notes = null)
    {
        // 进程名必须不带扩展名：GetProcessesByName 按「友好名」精确匹配，
        // 传 "NetPeek.exe" 恒返回空 —— 覆盖安装杀不掉托盘常驻的旧进程，
        // 写文件必撞映像锁（复审抓到的 P0）。这里统一规范化，调用方传哪种都行。
        var procName = Path.GetFileNameWithoutExtension(processName);
        var prefix = Path.GetFullPath(installDir).TrimEnd('\\') + "\\";
        foreach (var p in Process.GetProcessesByName(procName))
        {
            try
            {
                var path = p.MainModule?.FileName;
                if (path is null || !path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                // 本应用 Close 语义是隐藏到托盘，CloseMainWindow 永远收不了场；
                // 没有可见主窗口时直接强杀，省掉白等的 3 秒（二次复审 P3-2）。
                // 仍保留一次温和尝试：万一对方主窗口可见且真的响应关闭，好过直接撕。
                if (p.MainWindowHandle == 0 || !p.CloseMainWindow())
                {
                    p.Kill(entireProcessTree: true);
                    // Kill 是异步通知，进程树真正退出要一点时间；紧接着的文件写入
                    // 要等映像锁释放。不等的话卸载/覆盖安装会随机撞「文件被占用」。
                    p.WaitForExit(5000);
                }
                else if (!p.WaitForExit(3000))
                {
                    p.Kill(entireProcessTree: true);
                    p.WaitForExit(5000);
                }
                notes?.Add($"已关闭运行中的 {procName}");
            }
            catch { /* 权限/已退出等场景忽略：随后的文件操作会兜底报错 */ }
            finally { p.Dispose(); }
        }
    }

    private static void CreateLnk(string target, string lnkPath, string desc, string? args = null, string? iconTarget = null)
    {
        var type = Type.GetTypeFromProgID("WScript.Shell")
            ?? throw new InvalidOperationException("WScript.Shell COM 不可用");
        dynamic shell = Activator.CreateInstance(type)!;
        try
        {
            dynamic shortcut = shell.CreateShortcut(lnkPath);
            try
            {
                shortcut.TargetPath = target;
                shortcut.WorkingDirectory = Path.GetDirectoryName(target)!;
                if (args is not null) shortcut.Arguments = args;
                shortcut.Description = desc;
                shortcut.IconLocation = (iconTarget ?? target) + ",0";
                shortcut.Save();
            }
            finally
            {
                Marshal.ReleaseComObject(shortcut);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(shell);
        }
    }

    /// 安装失败补偿清理（自研安装器没有 MSI 的事务回滚，做「尽力清到可重装」）：
    /// 服务停删（防半成品 binPath 反复崩溃启动）、卸载键、快捷方式都回退；
    /// 程序文件**保留**——覆盖安装场景删文件会毁掉旧版残留，重装直接覆盖即可。
    /// 各动作独立 try：任何一步失败都记录后继续，不让补偿自身抛异常。
    ///
    /// 已知局限（无法完美解决）：补偿分不清「本次新建的」和「旧版原有的」。
    /// 快捷方式按本次具体文件名逐个删、目录空了才删，旧版组里其他内容尽量保住；
    /// 卸载键没有旧值可恢复，维持整树删除 —— 半写的键比缺失更糟，重装即恢复。
    public void Compensate(int failedStepIndex, List<string> log)
    {
        void Try(string what, Action act)
        {
            try { act(); log.Add("已回退：" + what); }
            catch (Exception ex) { log.Add($"回退失败（{what}）：{ex.Message}"); }
        }

        for (var i = failedStepIndex; i >= 0; i--)
        {
            switch (i)
            {
                case 5: // 登记卸载信息
                    Try("卸载登记", () =>
                        Registry.LocalMachine.DeleteSubKeyTree(Defs.UninstallKeyPath, throwOnMissingSubKey: false));
                    break;
                case 4: // 创建快捷方式
                    Try("快捷方式", () =>
                    {
                        var programs = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.Programs), "NetPeek");
                        // 只删本次安装会写的两枚 lnk，不递归删整个目录：
                        // 覆盖安装失败时目录里可能还有旧版快捷方式，整删等于把旧版的
                        // 开始菜单入口一并带走。目录空了才收掉空壳。
                        if (Directory.Exists(programs))
                        {
                            foreach (var lnk in new[] { "NetPeek.lnk", "卸载 NetPeek.lnk" })
                            {
                                var p = Path.Combine(programs, lnk);
                                if (File.Exists(p)) File.Delete(p);
                            }
                            if (!Directory.EnumerateFileSystemEntries(programs).Any())
                                Directory.Delete(programs);
                        }
                        var desktop = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "NetPeek.lnk");
                        if (File.Exists(desktop)) File.Delete(desktop);
                    });
                    break;
                case 3: // 安装并启动采集服务
                    Try("采集服务", () =>
                    {
                        if (!Svc.Exists(Defs.ServiceName)) return;
                        Svc.Stop(Defs.ServiceName);
                        Svc.Delete(Defs.ServiceName);
                    });
                    break;
            }
        }
        log.Add("程序文件保留在 " + InstallDir + "（重装可直接覆盖，或手动删除）");
    }
}

/// WebView2 运行时的检测与静默安装，全部按微软官方文档落地。
/// 检测：pv 值（64 位系统查 HKLM\SOFTWARE\WOW6432Node 下的 EdgeUpdate Clients 键，
/// 或 HKCU 同名键）；>0.0.0.0 即已装。安装：官方引导器（约 2MB）静默跑，
/// 与 Tauri 官方安装器的 downloadBootstrapper 默认行为一致。
internal static class WebView2Runtime
{
    private const string ClientsGuid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    /// 官方固定链接（learn.microsoft.com 的分发文档引用的 Bootstrapper 下载入口）。
    private const string BootstrapperUrl = "https://go.microsoft.com/fwlink/?linkid=2124701";

    public static string? FindVersion()
    {
        foreach (var (root, path) in new[]
        {
            (Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\" + ClientsGuid),
            (Registry.CurrentUser, @"Software\Microsoft\EdgeUpdate\Clients\" + ClientsGuid),
        })
        {
            using var k = root.OpenSubKey(path);
            if (k?.GetValue("pv") as string is not { Length: > 0 } pv) continue;
            if (pv != "0.0.0.0") return pv;
        }
        return null;
    }

    public static void InstallViaBootstrapper()
    {
        var bootstrapper = Path.Combine(Path.GetTempPath(), "MicrosoftEdgeWebview2Setup.exe");
        try
        {
            using (var http = new System.Net.Http.HttpClient { Timeout = TimeSpan.FromMinutes(3) })
            {
                // Step 委托在后台线程同步执行（RunSteps 的 Task.Run），阻塞取回即可。
                // 下载失败必须翻译成中文可操作信息：HttpClient 抛的是英文原始异常，
                // 直接冒给用户只会看到一堆 "The SSL connection could not be established"。
                byte[] bytes;
                try
                {
                    bytes = http.GetByteArrayAsync(BootstrapperUrl).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException(
                        "下载 WebView2 引导器失败（需要联网）：" + ex.Message +
                        "。可从 https://developer.microsoft.com/microsoft-edge/webview2 手动安装 Evergreen Runtime 后重试。");
                }
                File.WriteAllBytes(bootstrapper, bytes);
            }

            using var p = Process.Start(new ProcessStartInfo(bootstrapper, "/silent /install")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            })!;
            // 引导器要联网拉完整运行时（百 MB 级），给足 6 分钟。
            // 超时**故意不 Kill**（二次复审 P3 定为保留行为）：半截杀掉 WebView2
            // 安装可能留下损坏的运行时；让引导器在后台继续装，即便本次中止，
            // 它稍后装完，下次运行检测到 pv 就会跳过 —— 行为可自愈。
            if (!p.WaitForExit(360_000))
            {
                throw new InvalidOperationException(
                    "WebView2 运行时自动安装超时（6 分钟未完成），安装进程已留在后台继续。" +
                    "稍等片刻后重新运行安装程序即可继续；也可从 " +
                    "https://developer.microsoft.com/microsoft-edge/webview2 手动安装 Evergreen Runtime。");
            }
            if (p.ExitCode != 0)
            {
                throw new InvalidOperationException(
                    "WebView2 运行时自动安装未成功（引导器退出码 " + p.ExitCode + "，需要联网）。" +
                    "请从 https://developer.microsoft.com/microsoft-edge/webview2 手动安装 Evergreen Runtime 后重试。");
            }
        }
        finally
        {
            // 用完即清，不在 %TEMP% 留 2MB 的引导器残骸；进程未退等场景删不掉就算了。
            try { File.Delete(bootstrapper); } catch { }
        }
    }
}
