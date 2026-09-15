using System.IO;
using System.Reflection;

namespace NetPeek.Installer;

/// 内嵌产物读取。资源名对应 csproj 里的 LogicalName；payload 由 build-installer.ps1 填充。
internal static class Payload
{
    public const string AppResource = "NetPeek.payload.App.exe";
    public const string CollectorResource = "NetPeek.payload.Collector.exe";

    private static readonly string[] All = [AppResource, CollectorResource];

    public static bool HasAll()
    {
        var names = Assembly.GetExecutingAssembly().GetManifestResourceNames();
        return All.All(names.Contains);
    }

    /// 读出指定内嵌产物。缺 payload 时给出可操作的错误——这不该在用户机器上发生，
    /// 它只说明构建链断了（发布安装器前没填 payload）。
    public static byte[] Read(string resourceName)
    {
        var asm = Assembly.GetExecutingAssembly();
        using var stream = asm.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException(
                $"内嵌产物缺失：{resourceName}。请用 scripts/build-installer.ps1 构建（它会先填充 payload 再发布安装器）。");
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    /// 只问大小、不取内容。EstimatedSize 登记用：主程序 ~14MB + 采集服务 ~37MB，
    /// 用 Read() 算大小等于把两个 payload 完整 memcpy 进内存再扔掉，纯浪费。
    public static long SizeOf(string resourceName)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException(
                $"内嵌产物缺失：{resourceName}。请用 scripts/build-installer.ps1 构建（它会先填充 payload 再发布安装器）。");
        return stream.Length;
    }
}
