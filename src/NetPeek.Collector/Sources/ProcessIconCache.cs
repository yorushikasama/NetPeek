using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Security.Cryptography;
using System.Text;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 进程图标缓存：按可执行文件路径提取一次图标，转 32x32 PNG 的 data URL 后复用。
/// 提取成本较高，只在快照线程调用；ETW 回调内绝不使用。
/// 失败（无图标/权限不足）时返回空 id 与空图，UI 侧回退到通用占位图标。
///
/// 每条记录同时给出稳定的 <c>Id</c>（路径哈希），用于让管道层按连接去重：
/// 图标内容是静态的，同一 id 只需在一条连接内传输一次，避免每帧重复搬运 1~3 KB base64。
///
/// 尺寸说明：UI 列表/卡片/详情分别按 18/24/32px 渲染，高 DPI（150%~200%）下还会放大到
/// 48~64px。之前缩到 16px 再被 CSS 放大，是图标糊的根因。ExtractAssociatedIcon 最多返回
/// 约 32px 的单尺寸图标，这里取 32px 并用高质量双三次插值，小尺寸由 UI 端降采样（降采样
/// 不丢细节、保持锐利）。如需 150%+ DPI 下详情窗也完全锐利，可进一步用 SHIL_JUMBO（256px）
/// 或 IShellItemImageFactory 提取大图再降采样，属后续增强项。
///
/// 容量：常驻服务会持续见到新路径（安装/更新/临时程序），无上限的字典会缓慢膨胀。
/// 超过 <see cref="MaxEntries"/> 时整体清空重建——图标可随时重新提取，丢缓存只是一次
/// 额外提取开销，不影响正确性，比维护 LRU 链表更简单可靠。
/// </summary>
public sealed class ProcessIconCache
{
    private const int IconSize = 32;

    /// <summary>缓存条目上限。每条约 1~3 KB，1024 条约 1~3 MB，符合服务工作集预算。</summary>
    private const int MaxEntries = 1024;

    /// <summary>一个可执行文件对应的图标：稳定 id + base64 data URL。</summary>
    public readonly record struct IconEntry(string Id, string DataUrl)
    {
        public static readonly IconEntry None = new("", "");
    }

    private readonly ConcurrentDictionary<string, IconEntry> _icons = new(StringComparer.OrdinalIgnoreCase);

    public IconEntry Get(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return IconEntry.None;
        }

        if (_icons.TryGetValue(path, out var cached))
        {
            return cached;
        }

        // 超出上限时整体清空重建，避免常驻服务无界增长。
        if (_icons.Count >= MaxEntries)
        {
            _icons.Clear();
        }

        var entry = Extract(path);
        _icons[path] = entry;
        return entry;
    }

    private static IconEntry Extract(string path)
    {
        var id = MakeId(path);
        try
        {
            using var icon = Icon.ExtractAssociatedIcon(path);
            if (icon is null)
            {
                return IconEntry.None;
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
            return new IconEntry(id, "data:image/png;base64," + Convert.ToBase64String(ms.ToArray()));
        }
        catch
        {
            return IconEntry.None;
        }
    }

    /// <summary>路径 → 稳定短 id。仅用于缓存键匹配，非安全用途，取哈希前 8 字节足够避免碰撞。</summary>
    private static string MakeId(string path)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(path.ToLowerInvariant()));
        return Convert.ToHexString(bytes, 0, 8);
    }
}
