using NetPeek.Shared.Protocol;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 临时数据源：产生几条伪造流量，用于在 ETW 接入前验证 IPC 链路与 UI 渲染。
/// ETW 就绪后删除，并在 Program.cs 中把注册改为 <see cref="EtwSnapshotSource"/>。
/// </summary>
public sealed class StubSnapshotSource : ISnapshotSource
{
    private readonly Random _random = new();
    private bool _paused;

    public bool IsPaused => _paused;
    public void Pause() => _paused = true;
    public void Resume() => _paused = false;

    // 每个假进程独立累计，避免全局总量混入单个进程的 DownloadTotal/UploadTotal。
    private readonly ulong[] _downTotal = new ulong[3];
    private readonly ulong[] _upTotal = new ulong[3];

    private static readonly string[] Names = { "chrome.exe", "Discord.exe", "steam.exe" };

    public TrafficSnapshot GetSnapshot()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var processes = new List<ProcessTraffic>(Names.Length);
        ulong totalDown = 0, totalUp = 0;

        for (int i = 0; i < Names.Length; i++)
        {
            // 暂停时本周期速率置 0、不累计，恢复后继续累计。
            var down = _paused ? 0UL : (ulong)_random.Next(1000, 200_000);
            var up = _paused ? 0UL : (ulong)_random.Next(200, 40_000);
            totalDown += down;
            totalUp += up;

            _downTotal[i] += down;
            _upTotal[i] += up;

            processes.Add(new ProcessTraffic
            {
                Pid = (uint)(1000 + i * 137),
                Name = Names[i],
                DownloadBytes = down,
                UploadBytes = up,
                DownloadTotal = _downTotal[i],
                UploadTotal = _upTotal[i],
            });
        }

        return new TrafficSnapshot
        {
            TimestampUnixMs = now,
            TotalDownloadBytes = totalDown,
            TotalUploadBytes = totalUp,
            EventsLost = 0,
            Status = _paused ? "paused" : "ok",
            Processes = processes,
        };
    }
}
