using NetPeek.Collector;
using NetPeek.Collector.Ipc;
using NetPeek.Collector.Sources;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "NetPeek.Collector";
});

// 数据源：先用桩实现跑通链路，ETW 就绪后替换为 EtwSnapshotSource。
builder.Services.AddSingleton<ISnapshotSource, StubSnapshotSource>();
builder.Services.AddSingleton<SnapshotPipeServer>();
builder.Services.AddHostedService<CollectorService>();

var host = builder.Build();
host.Run();
