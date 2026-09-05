using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 进程图标缓存：按可执行文件路径提取一次图标，转 32x32 PNG 的 data URL 后长期复用。
/// 提取成本较高，只在快照线程调用；ETW 回调内绝不使用。
/// 失败（无图标/权限不足）时返回空串，UI 侧回退到通用占位图标。
///
/// 尺寸说明：UI 列表/卡片/详情分别按 18/24/32px 渲染，高 DPI（150%~200%）下还会放大到
/// 48~64px。之前缩到 16px 再被 CSS 放大，是图标糊的根因。ExtractAssociatedIcon 最多返回
/// 约 32px 的单尺寸图标，这里取 32px 并用高质量双三次插值，小尺寸由 UI 端降采样（降采样
/// 不丢细节、保持锐利）。如需 150%+ DPI 下详情窗也完全锐利，可进一步用 SHIL_JUMBO（256px）
/// 或 IShellItemImageFactory 提取大图再降采样，属后续增强项。
/// </summary>
public sealed class ProcessIconCache
{
    private const int IconSize = 32;

    private readonly ConcurrentDictionary<string, string> _icons = new(StringComparer.OrdinalIgnoreCase);

    public string GetDataUrl(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return "";
        }

        return _icons.GetOrAdd(path, static p => ExtractIcon(p));
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
}
