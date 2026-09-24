using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace NetPeek.Installer;

public partial class App : Application
{
    /// 安装/卸载单实例互斥。NSIS/Inno 同款语义：并发跑两个安装器时，
    /// sc create 撞服务名、exe 写一半被另一实例覆盖。放在提权判定**之后**创建 ——
    /// 提权重启的中间态进程（马上就要退出的那个壳）不能抢锁，否则新进程会被挡在门外。
    private static Mutex? _singleInstance;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var args = e.Args ?? Array.Empty<string>();

        bool uninstall = Has(args, "--uninstall");
        bool silent = Has(args, "--silent") || Has(args, "/S");
        bool preview = Has(args, "--preview");

        // --shot-all：离屏渲染三页直接落 PNG（不出窗口、零打扰），UI 验收专用。
        if (Has(args, "--shot-all"))
        {
            ShotAll();
            Shutdown();
            return;
        }

        // --preview：UI 验收专用。假流程、不写盘、不碰服务、零 UAC（manifest 是 asInvoker）。
        // --preview-steps：进一步自动推进到进度页（供截进度/完成两页）。
        if (preview)
        {
            new MainWindow(preview: true, autoRun: Has(args, "--preview-steps")).Show();
            return;
        }

        // 安装/卸载都要动 HKLM 与系统服务：非提权时用 runas 重启自己（弹一次 UAC）。
        // manifest 故意不写 requireAdministrator，就是为了 --preview 能免提权跑 UI。
        if (!Elevation.IsElevated())
        {
            // 两个分支都必须显式收场：App 是 OnExplicitShutdown，无窗口路径不关
            // Shutdown 就是僵尸进程（占任务管理器、占 exe 映像、令 SelfDelete 删不掉文件）。
            if (!Elevation.RelaunchElevated(args))
            {
                Shutdown(1); // 用户拒绝了 UAC：什么都不装，安静退出
            }
            else
            {
                Shutdown(0); // 提权子进程已接手，壳进程退场（二次复审 P0）
            }
            return;
        }

        // 到这里的必然是真正干活的提权进程，才轮到它拿互斥锁。
        // 显式 DACL：只授管理员与 SYSTEM 完全控制。防止低权限进程预创建同名 Global 互斥体、
        // 令提权后的安装器误判「已在运行」而退出（安装/卸载被 DoS）。Global 命名空间本已需
        // SeCreateGlobalPrivilege，此处再收 DACL 作纵深防御，也把「谁可拥有这把锁」写清楚。
        var mutexSec = new MutexSecurity();
        mutexSec.AddAccessRule(new MutexAccessRule(
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
            MutexRights.FullControl, AccessControlType.Allow));
        mutexSec.AddAccessRule(new MutexAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            MutexRights.FullControl, AccessControlType.Allow));
        _singleInstance = MutexAcl.Create(
            initiallyOwned: true, @"Global\NetPeek.Setup.Installing", out var createdNew, mutexSec);
        if (!createdNew)
        {
            if (!silent)
                MessageBox.Show("NetPeek 安装/卸载程序已在运行，请先完成当前窗口的操作。",
                    "NetPeek 安装程序", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown(0);
            return;
        }

        if (uninstall)
        {
            RunUninstall(silent);
            return;
        }

        new MainWindow().Show();
    }

    private void RunUninstall(bool silent)
    {
        // 非静默时给一次确认：卸载会停删采集服务并清除全部数据（含历史库），
        // 用户拍板「数据全部清理」，但不可逆动作前必须让人知道发生了什么。
        if (!silent)
        {
            var ok = MessageBox.Show(
                "即将卸载 NetPeek。\n\n将停止并删除采集服务，主程序与全部数据（含历史记录）都会被删除。\n\n继续吗？",
                "卸载 NetPeek", MessageBoxButton.YesNo, MessageBoxImage.Warning,
                MessageBoxResult.No) != MessageBoxResult.No;
            if (!ok)
            {
                Shutdown(0);
                return;
            }
        }

        var result = UninstallFlow.Run(silent ? null : msg => MessageBox.Show(msg, "卸载 NetPeek",
            MessageBoxButton.OK, MessageBoxImage.Information));
        if (result.Success)
        {
            if (!silent)
            {
                MessageBox.Show("NetPeek 已卸载，数据已清除。", "卸载完成",
                    MessageBoxButton.OK, MessageBoxImage.Information);
            }
            // 日志是排障用的临时面：卸载成功即清；失败留着给用户看。
            SetupLog.TryClean();
            // 自删：卸载器就是 $INSTDIR 里的文件，得等本进程退出后由 cmd 延迟删除；
            // 传安装目录做守卫——不是从安装目录跑的绝不递归删目录
            UninstallFlow.SelfDelete(result.InstallDir);
        }
        else
        {
            MessageBox.Show("卸载未完全成功：\n" + result.Error + "\n\n部分文件可能在重启后自动清理。" +
                            "\n\n日志：" + SetupLog.FilePath,
                "卸载 NetPeek", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        Shutdown(result.Success ? 0 : 2);
    }

    private static bool Has(string[] args, string value) =>
        args.Any(a => string.Equals(a, value, StringComparison.OrdinalIgnoreCase));

    /// 离屏渲染三页（欢迎/进度/完成）到 PNG。窗口开在屏幕外 (-4000,-4000)、
    /// 不激活、不进任务栏 —— 走真实布局管线（纯离屏 Measure/Arrange 渲染出来
    /// 是空白），用户侧完全无感。沙箱里的确定性 UI 验收通道。
    private static void ShotAll()
    {
        // 输出点：环境变量可覆盖，默认取当前工作目录下的 .workbuddy\tmp ——
        // 不写死 D:\NetPeek 绝对路径，换机器/换检出位置照样可用。
        var dir = Environment.GetEnvironmentVariable("NETPEEK_SHOT_DIR");
        if (string.IsNullOrWhiteSpace(dir))
            dir = Path.Combine(Environment.CurrentDirectory, ".workbuddy", "tmp");
        Directory.CreateDirectory(dir); // 输出点被清理过时自建，别让 PNG 落盘一步才崩
        var win = new MainWindow(preview: true)
        {
            WindowStartupLocation = WindowStartupLocation.Manual,
            Left = -4000,
            Top = -4000,
            ShowActivated = false,
            ShowInTaskbar = false,
        };
        win.Show();
        Shot(win, Path.Combine(dir, "shot_welcome.png"));
        win.EnterProgressShot();
        win.UpdateLayout();
        FlushRender();
        Shot(win, Path.Combine(dir, "shot_progress.png"));
        win.EnterDoneShot();
        win.UpdateLayout();
        FlushRender();
        Shot(win, Path.Combine(dir, "shot_done.png"));
        win.Close();
        Console.WriteLine("shot-all done -> " + dir);
    }

    /// 跑完一帧渲染管道：切页后 RenderTargetBitmap 才拿得到新状态
    ///（Show 的首帧之外，Visibility 切换必须显式过一遍 Dispatcher）。
    private static void FlushRender()
    {
        var frame = new System.Windows.Threading.DispatcherFrame();
        System.Windows.Threading.Dispatcher.CurrentDispatcher.BeginInvoke(
            System.Windows.Threading.DispatcherPriority.Loaded,
            new System.Windows.Threading.DispatcherOperationCallback(f =>
            {
                ((System.Windows.Threading.DispatcherFrame)f).Continue = false;
                return null;
            }), frame);
        System.Windows.Threading.Dispatcher.PushFrame(frame);
    }

    private static void Shot(Window win, string path)
    {
        if (win.Content is not Visual visual) return;
        var rtb = new RenderTargetBitmap(760, 500, 96, 96, PixelFormats.Pbgra32);
        rtb.Render(visual);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(rtb));
        using var fs = File.Create(path);
        encoder.Save(fs);
    }
}
