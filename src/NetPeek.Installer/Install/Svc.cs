using System.Diagnostics;

namespace NetPeek.Installer;

/// sc.exe / net.exe 薄封装。不引 ServiceBase 或 P/Invoke：安装/卸载各跑一次，
/// 进程调用足够，且输出文本与 WiX ServiceControl 时代语义一一对应，排查时有据可查。
/// 调用方持有管理员令牌（App 入口已保证），这里不再做权限检查。
internal static class Svc
{
    public static bool Exists(string name)
    {
        // sc query 对不存在的服务返回 1060，exit code 即判定依据
        return RunRaw("sc", $"query \"{name}\"").Code == 0;
    }

    /// 停止服务。「服务未启动」（net exit 2）不算失败——目标本来就是让它停下来。
    public static (bool Ok, string Output) Stop(string name)
    {
        var (_, output) = Run("net", $"stop \"{name}\"", ignoreExitCode: true);
        return (true, output);
    }

    public static (bool Ok, string Output) Delete(string name) => Run("sc", $"delete \"{name}\"", ignoreExitCode: true);

    public static (bool Ok, string Output) Create(string name, string binPath) =>
        Run("sc", $"create \"{name}\" binPath= \"{binPath}\" start= auto obj= LocalSystem DisplayName= \"{Defs.ServiceDisplayName}\"");

    public static (bool Ok, string Output) SetDescription(string name, string desc) =>
        Run("sc", $"description \"{name}\" \"{desc}\"");

    public static (bool Ok, string Output) Start(string name) => Run("sc", $"start \"{name}\"", ignoreExitCode: true);

    /// 故障自恢复：首次失败 60 秒后重启、二三次各 60 秒，24 小时无失败则重置计数。
    /// 采集端是监控工具的命根子，进程崩溃不该等人手动拉起。
    public static (bool Ok, string Output) Recover(string name) =>
        Run("sc", $"failure \"{name}\" reset= 86400 actions= restart/60000/restart/60000/restart/60000", ignoreExitCode: true);

    /// 等服务真正进入 STOPPED（或从 SCM 消失）。
    ///
    /// 为什么不能只靠固定 Sleep：sc delete 对仍在运行的服务只能「标记删除」，
    /// 服务真正退出之前，紧接着 sc create 同名服务会撞 1072
    /// （ERROR_SERVICE_MARKED_FOR_DELETE）；net stop 对卡在 STOP_PENDING 的服务
    /// 返回失败也不会等到底。轮询 sc query 直到出现 STOPPED（STOP_PENDING 里
    /// 没有 "STOPPED" 子串，不会误判）或确认服务已不存在。
    ///
    /// 「已不存在」只认 1060：其它退出码（权限等）意味着状态未知，宁可等满
    /// 超时让调用方报「停止超时」，也不误判成已停 —— 误判的下一步是 Create，
    /// 那个错误比「停止超时」难懂得多（二次复审 P3-5）。
    public static bool WaitStopped(string name, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        while (sw.ElapsedMilliseconds < timeoutMs)
        {
            var (code, output) = RunRaw("sc", $"query \"{name}\"");
            if (code == 1060) return true;                        // ERROR_SERVICE_DOES_NOT_EXIST：已停
            if (code == 0 && output.Contains("STOPPED")) return true; // RUNNING/START_PENDING 继续等
            Thread.Sleep(200);
        }
        return false;
    }

    private static (bool Ok, string Output) Run(string file, string arguments, bool ignoreExitCode = false)
    {
        var (code, output) = RunRaw(file, arguments);
        return (ignoreExitCode || code == 0, output);
    }

    /// 原始执行：返回真实退出码与合并输出，供需要区分「失败原因」的调用方（WaitStopped）。
    private static (int Code, string Output) RunRaw(string file, string arguments)
    {
        var psi = new ProcessStartInfo(file, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var p = Process.Start(psi)!;
        // 两个流必须并行读：顺序 ReadToEnd 是 .NET 明示的死锁模式 —— 若子进程先写满
        // stderr 的管道缓冲，本方法还挂在 stdout 的 ReadToEnd 上，两边互相等死。
        var outTask = p.StandardOutput.ReadToEndAsync();
        var errTask = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(30_000))
        {
            // 超时不留活口：sc/net 卡死时进程要收掉，否则每轮重试都在泄漏一个子进程。
            try { p.Kill(entireProcessTree: true); } catch { /* 已自行退出等场景忽略 */ }
            // 收尸后管道随即关闭，给读流任务两秒收尾：不把 faulted task 遗弃给
            // finalizer（那会被记为 unobserved exception）（二次复审 P3-3）。
            try { Task.WhenAll(outTask, errTask).Wait(2_000); } catch { /* 结果已不再需要 */ }
            return (-1, "命令 30 秒未返回，已强制终止");
        }
        var output = outTask.GetAwaiter().GetResult() + errTask.GetAwaiter().GetResult();
        return (p.ExitCode, output.Trim());
    }
}
