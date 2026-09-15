using System.IO;

namespace NetPeek.Installer;

/// 安装/卸载持久日志：ProgramData\NetPeek\setup.log。
/// 用户报障时只有这一个可查证据面（UI 弹窗关掉就没了）。写入失败永不影响主流程。
internal static class SetupLog
{
    private static readonly object Gate = new();

    public static string Dir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NetPeek");

    public static string FilePath => Path.Combine(Dir, "setup.log");

    public static void Write(string line)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Dir);
                File.AppendAllText(FilePath,
                    $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {line}{Environment.NewLine}");
            }
        }
        catch { /* 日志只是辅助面：盘满/权限等场景静默放弃 */ }
    }

    /// 卸载收尾时清掉日志目录（用户拍板「数据全部清理」的精神；失败忽略——
    /// 最后一条日志写完才调它，删不掉就留给用户看）。
    public static void TryClean()
    {
        try { Directory.Delete(Dir, recursive: true); } catch { }
    }
}
