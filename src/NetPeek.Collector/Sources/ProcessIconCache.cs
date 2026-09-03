using System.Collections.Concurrent;
using System.Drawing;
using System.Drawing.Imaging;

namespace NetPeek.Collector.Sources;

/// <summary>
/// 进程图标缓存：按可执行文件路径提取一次图标，转 16x16 PNG 的 data URL 后长期复用。
/// 提取成本较高，只在快照线程调用；ETW 回调内绝不使用。
/// 失败（无图标/权限不足）时返回空串，UI 侧回退到通用占位图标。
/// </summary>
public sealed class ProcessIconCache
{
    private const int IconSize = 16;

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
            using var resized = new Bitmap(bitmap, IconSize, IconSize);
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
