using NetPeek.Collector;
using NetPeek.Collector.Ipc;
using NetPeek.Collector.Sources;

var builder = Host.CreateApplicationBuilder(args);

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
host.Run();
