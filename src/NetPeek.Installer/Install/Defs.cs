using System.IO;

namespace NetPeek.Installer;

/// 安装器与卸载器共用的常量。服务名沿用 MSI 时代 collector.wxs 的名字（NetPeek.Collector），
/// 换轨后语义不变：§41/§42 的管道与服务诊断文案都建立在这个名字上。
internal static class Defs
{
    public const string ServiceName = "NetPeek.Collector";
    public const string ServiceDisplayName = "NetPeek Collector Service";
    public const string ServiceDescription =
        "Collects per-application network traffic via ETW and serves it to the NetPeek UI over a named pipe";

    public const string AppExeName = "NetPeek.exe";
    public const string SetupExeName = "NetPeek.Setup.exe";
    public const string CollectorRelDir = "collector";
    public const string CollectorExeRelPath = CollectorRelDir + "\\NetPeek.Collector.exe";

    /// 主应用数据目录（Tauri identifier）。用户拍板：卸载时**全部清除**，含历史库。
    public const string AppDataDirName = "com.netpeek.app";

    /// settings.rs 的 AUTOSTART_VALUE：HKCU Run 下的值名。
    public const string RunValueName = "NetPeek";

    public const string UninstallKeyPath = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\NetPeek";
    public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    public const string Publisher = "NetPeek";

    /// MSI 时代 WiX 装出来的 DisplayName（tauri.conf.json productName）。用于换轨迁移：
    /// 枚举卸载键找到 ProductCode 后 msiexec /x 静默卸掉，避免两版并存抢管道（§42.6 的 231）。
    public const string LegacyMsiDisplayName = "NetPeek";

    public static string DefaultInstallDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "NetPeek");
}
