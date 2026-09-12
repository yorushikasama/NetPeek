using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 进程图标缓存：按可执行文件路径提取一次图标，转 32x32 PNG 的 data URL 后长期复用。
///
/// **提取是异步的**，快照线程绝不等它。原实现在 <c>GetSnapshot</c> 里同步调
/// <c>Icon.ExtractAssociatedIcon</c> + 缩放 + PNG 编码，单个约 9ms，实测 110 个图标
/// 耗时 971ms（冷文件系统缓存时到过 4.4s）—— 而 GetSnapshot 是被管道写帧循环同步调用的，
/// 这一整段全压在「UI 连上后的第一帧」上，管道上什么都没有，界面只能干等。
/// 现在 <see cref="TryGetDataUrl"/> 立即返回：命中缓存就给值，没有就把路径丢进队列由
/// 后台线程提取，本帧不带这个图标，等就绪后的某一帧再发（UI 侧图标本来就是渐进出现的）。
///
/// 线程模型：<see cref="TryGetDataUrl"/> 只由快照线程调用；提取只在后台单线程执行。
/// 结果字典是 ConcurrentDictionary，两侧安全。刻意用单线程而非线程池并发提取 ——
/// 图标提取要读磁盘上的 PE 资源节，几十个并发只会把机械盘/受压的系统盘拖得更慢，
/// 而且这活儿本来就不着急，慢几帧无所谓，不该跟采集抢 CPU。
///
/// 尺寸说明：UI 列表/卡片/详情分别按 18/24/32px 渲染，高 DPI（150%~200%）下还会放大到
/// 48~64px。之前缩到 16px 再被 CSS 放大，是图标糊的根因。ExtractAssociatedIcon 最多返回
/// 约 32px 的单尺寸图标，这里取 32px 并用高质量双三次插值，小尺寸由 UI 端降采样（降采样
/// 不丢细节、保持锐利）。如需 150%+ DPI 下详情窗也完全锐利，可进一步用 SHIL_JUMBO（256px）
/// 或 IShellItemImageFactory 提取大图再降采样，属后续增强项。
/// </summary>
public sealed class ProcessIconCache : IDisposable
{
    private const int IconSize = 32;

    /// <summary>路径 → data URL。空串 = 提取失败（无图标/权限不足），不再重试。</summary>
    private readonly ConcurrentDictionary<string, string> _icons = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>已排队待提取的路径，避免同一路径反复入队。</summary>
    private readonly ConcurrentDictionary<string, bool> _queued = new(StringComparer.OrdinalIgnoreCase);

    private readonly BlockingCollection<string> _pending = new(new ConcurrentQueue<string>());
    private readonly Thread _worker;
    private volatile bool _disposed;

    public ProcessIconCache()
    {
        _worker = new Thread(ExtractLoop)
        {
            IsBackground = true,
            Name = "NetPeek.Icons",
            // 低于普通线程：采集与推帧优先，图标是可以等的装饰。
            Priority = ThreadPriority.BelowNormal,
        };
        _worker.Start();
    }

    /// <summary>
    /// 尝试取图标。已解析（含解析失败）返回 true，<paramref name="dataUrl"/> 为 data URL 或空串；
    /// 尚未提取则入队并返回 false —— 调用方应保持该路径「未下发」，下一帧再问。
    /// 绝不阻塞。
    /// </summary>
    public bool TryGetDataUrl(string path, out string dataUrl)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            dataUrl = "";
            return true; // 没有路径就没有图标，视为已解析，免得调用方反复重试。
        }

        if (_icons.TryGetValue(path, out var cached))
        {
            dataUrl = cached;
            return true;
        }

        dataUrl = "";
        if (!_disposed && _queued.TryAdd(path, true))
        {
            try
            {
                _pending.Add(path);
            }
            catch (InvalidOperationException)
            {
                // 队列已随 Dispose 关闭，丢弃即可。
            }
        }

        return false;
    }

    private void ExtractLoop()
    {
        try
        {
            foreach (var path in _pending.GetConsumingEnumerable())
            {
                _icons[path] = ExtractIcon(path);
                _queued.TryRemove(path, out _);
            }
        }
        catch (ObjectDisposedException)
        {
            // Dispose 与 GetConsumingEnumerable 竞争时的正常退出路径。
        }
    }

    private static string ExtractIcon(string path)
    {
        try
        {
            using var icon = Icon.ExtractAssociatedIcon(path);
            if (icon is null)
            {
                return "";
            }

            using var bitmap = icon.ToBitmap();
            // 高质量双三次缩放：默认 Bitmap(Image, w, h) 是双线性，边缘偏糊。
            using var resized = new Bitmap(IconSize, IconSize, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(resized))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(bitmap, 0, 0, IconSize, IconSize);
            }
            using var ms = new MemoryStream();
            resized.Save(ms, ImageFormat.Png);
            return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
        }
        catch
        {
            return "";
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _pending.CompleteAdding();
        if (_worker.IsAlive && _worker != Thread.CurrentThread)
        {
            _worker.Join(TimeSpan.FromSeconds(1));
        }
        _pending.Dispose();
    }
}
