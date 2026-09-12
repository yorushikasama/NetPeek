using NetPeek.Collector;
using NetPeek.Collector.Ipc;
using NetPeek.Collector.Logging;
using NetPeek.Collector.Sources;

// 全局兜底必须最先注册。服务以 LocalSystem 身份运行，没有控制台、没有调试器在场，
// 未捕获异常的唯一可观测渠道就是这个文件；注册晚了就赶不上启动阶段的崩溃。
AppDomain.CurrentDomain.UnhandledException += (_, e) =>
{
    if (e.ExceptionObject is Exception ex)
    {
        CollectorLog.Write("FATAL", $"未捕获异常（IsTerminating={e.IsTerminating}）", ex);
    }
    else
    {
        CollectorLog.Write("FATAL", $"未捕获的非异常对象：{e.ExceptionObject}");
    }
};

TaskScheduler.UnobservedTaskException += (_, e) =>
{
    // 后台 Task 的异常默认只在 GC 终结时触发本事件；不 SetObserved 会被升级为进程级崩溃。
    CollectorLog.Write("ERROR", "未观察的任务异常", e.Exception);
    e.SetObserved();
};

var builder = Host.CreateApplicationBuilder(args);

// 落盘日志：默认的 Console / EventSource provider 在 Windows 服务模式下无处可去，
// 「ETW 会话启动失败（需要管理员权限）」这类关键错误本来会彻底失声。
builder.Logging.AddProvider(new FileLoggerProvider());

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "NetPeek.Collector";
});

// 数据源：ETW 采集（订阅内核网络事件，按 payload PID 聚合）。
// 需管理员权限；在开发机前台调试时请以管理员身份运行。如需无权限跑通链路可临时改回 StubSnapshotSource。
builder.Services.AddSingleton<ProcessMetadataCache>();
builder.Services.AddSingleton<ProcessIconCache>();
builder.Services.AddSingleton<ISnapshotSource, EtwSnapshotSource>();
builder.Services.AddSingleton<SnapshotPipeServer>();
builder.Services.AddHostedService<CollectorService>();
// 反向控制通道：接收 UI 的暂停/恢复监控命令。
builder.Services.AddHostedService<SnapshotControlServer>();

var host = builder.Build();

// 启动横幅：把「日志为什么是空的 / 服务到底起没起」这类问题一次性回答掉。
CollectorLog.Write(
    "INFO",
    $"采集服务进程启动 pid={Environment.ProcessId} 用户={Environment.UserName} 日志={CollectorLog.FilePath}");

host.Run();

CollectorLog.Write("INFO", "采集服务进程已退出");
