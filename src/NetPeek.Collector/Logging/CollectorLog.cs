using System.Text;
using Microsoft.Extensions.Logging;

namespace NetPeek.Collector.Logging;

/// <summary>
/// 采集服务的落盘日志。
///
/// 为什么不用第三方日志库：服务以 LocalSystem 身份运行，日志量极小（1Hz 快照不打日志），
/// 引入 Serilog/NLog 只会增加发布体积与升级面。这里只要「任何异常都有痕可查」这一件事。
///
/// 路径固定 %ProgramData%\NetPeek\collector.log —— ProgramData 默认允许 Users 读取，
/// 界面进程（普通用户令牌）无需提权即可打开查看。
///
/// 设计约束：日志自身绝不能成为故障源。目录创建、轮转、写入全部吞异常，
/// 写不进去就静默放弃，绝不上抛。
/// </summary>
public static class CollectorLog
{
    /// <summary>单个日志文件上限：超过即轮转。</summary>
    private const long MaxBytes = 2 * 1024 * 1024;

    /// <summary>保留的历史归档数（collector.log.1 ... .N）。</summary>
    private const int MaxArchives = 2;

    private static readonly object Gate = new();

    public static string DirectoryPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "NetPeek");

    public static string FilePath { get; } = Path.Combine(DirectoryPath, "collector.log");

    /// <summary>写一行日志。level 为 FATAL/ERROR/WARN/INFO/DEBUG。</summary>
    public static void Write(string level, string message, Exception? exception = null)
    {
        var sb = new StringBuilder(message.Length + 128);
        sb.Append(DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss.fff zzz"))
          .Append(" [").Append(level).Append("] ")
          .Append(message);

        if (exception is not null)
        {
            // ToString() 带类型、消息与堆栈——排查只靠这一份文件，不能只留 Message。
            sb.AppendLine().Append(exception);
        }

        sb.AppendLine();

        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(DirectoryPath);
                RotateIfNeeded();
                File.AppendAllText(FilePath, sb.ToString(), Encoding.UTF8);
            }
        }
        catch
        {
            // 日志写不进去（磁盘满 / 权限异常）不是致命问题，宁可丢日志也不拖垮采集。
        }
    }

    /// <summary>把当前文件挪成 .1，旧的依次后移。调用方必须已持有锁。</summary>
    private static void RotateIfNeeded()
    {
        try
        {
            var info = new FileInfo(FilePath);
            if (!info.Exists || info.Length < MaxBytes)
            {
                return;
            }

            for (var i = MaxArchives - 1; i >= 1; i--)
            {
                var from = $"{FilePath}.{i}";
                if (File.Exists(from))
                {
                    File.Move(from, $"{FilePath}.{i + 1}", overwrite: true);
                }
            }

            File.Move(FilePath, $"{FilePath}.1", overwrite: true);
        }
        catch
        {
            // 轮转失败就继续往原文件追加，不做任何补救。
        }
    }
}

/// <summary>
/// 把 ILogger 桥接到 <see cref="CollectorLog"/>。
/// 采集端已有的 _logger.LogError(...) 调用无需改动即可全部落盘。
/// </summary>
public sealed class FileLoggerProvider : ILoggerProvider
{
    private readonly LogLevel _minimum;

    public FileLoggerProvider(LogLevel minimum = LogLevel.Information) => _minimum = minimum;

    public ILogger CreateLogger(string categoryName) => new FileLogger(categoryName, _minimum);

    public void Dispose()
    {
        // 无缓冲、无句柄，无需释放。
    }

    private sealed class FileLogger : ILogger
    {
        private readonly string _category;
        private readonly LogLevel _minimum;

        public FileLogger(string category, LogLevel minimum)
        {
            // 只保留类名，省掉 NetPeek.Collector.Sources. 这类长前缀。
            var dot = category.LastIndexOf('.');
            _category = dot >= 0 && dot < category.Length - 1 ? category[(dot + 1)..] : category;
            _minimum = minimum;
        }

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) =>
            logLevel != LogLevel.None && logLevel >= _minimum;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            CollectorLog.Write(LevelText(logLevel), $"[{_category}] {formatter(state, exception)}", exception);
        }

        private static string LevelText(LogLevel level) => level switch
        {
            LogLevel.Critical => "FATAL",
            LogLevel.Error => "ERROR",
            LogLevel.Warning => "WARN",
            LogLevel.Information => "INFO",
            LogLevel.Debug => "DEBUG",
            LogLevel.Trace => "TRACE",
            _ => "INFO",
        };
    }
}
