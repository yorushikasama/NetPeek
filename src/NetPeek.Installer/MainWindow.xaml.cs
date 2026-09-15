using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Win32; // OpenFolderDialog

namespace NetPeek.Installer;

public partial class MainWindow : Window
{
    private readonly bool _preview;
    private readonly bool _autoRun;
    private InstallFlow? _flow;
    /// 安装中止信号。取消只能到步骤边界（sc/msiexec 等子进程无法从外部安全中断），
    /// 但「确认退出后不再启动下一步」已经能把半装状态从「随机多走几步」收到
    /// 「最多停在当前一步」；失败弹框也据此跳过 —— 窗口都关了再弹只是抛异常。
    private CancellationTokenSource? _cts;

    public MainWindow(bool preview = false, bool autoRun = false)
    {
        InitializeComponent();
        _preview = preview;
        _autoRun = autoRun;
        BrandVersion.Text = "版本 " + InstallFlow.VersionText() + (preview ? "（预览模式）" : "");
        DirBox.Text = Defs.DefaultInstallDir;
        if (preview)
        {
            // 预览模式：照常走三页，只是步骤动作换成假推进（见 RunSteps 的 preview 分支）
            Title += "（预览）";
        }
        if (autoRun)
        {
            // 截屏验收用：启动即自动进进度页慢速推进，无需人点按钮
            Loaded += (_, _) =>
            {
                _cts = new CancellationTokenSource();
                _flow = new InstallFlow(Defs.DefaultInstallDir, desktopShortcut: true);
                SwitchTo(ProgressPage);
                BuildStepList(_flow.BuildSteps());
                RunSteps(_flow.BuildSteps(), Defs.DefaultInstallDir);
            };
        }
        // App 是 OnExplicitShutdown：窗口关了进程不会自己退（正常完成/中途取消都走
        // Close）。不显式收场就留下一个**持互斥锁**的僵尸进程 —— 下一次安装/卸载
        // 会被「已在运行」永久挡住（二次复审 P0）。
        Closed += (_, _) => Application.Current.Shutdown();
        MouseLeftButtonDown += (_, ev) =>
        {
            if (ev.Source is Button) return;
            try { DragMove(); } catch { /* 拖动中还原等场景忽略 */ }
        };
    }

    // ---------- 窗控与拖动 ----------

    private void OnTitleBarMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.Source is Button) return;
        try { DragMove(); } catch { /* 拖动中还原等场景忽略 */ }
    }

    private void OnMinimizeClick(object sender, RoutedEventArgs e) =>
        WindowState = WindowState.Minimized;

    private void OnCloseClick(object sender, RoutedEventArgs e)
    {
        // 安装中途关闭 = 中止：步骤不原子（旧服务已删、文件写了一半），
        // 提示一句再放走；非安装中直接关。
        if (ProgressPage.Visibility == Visibility.Visible && ProgressTitle.Text != "安装失败")
        {
            var ok = MessageBox.Show(this, "安装尚未完成，确定退出吗？\n\n退出后旧版本可能已被移除，建议重新运行安装程序完成安装。",
                "NetPeek 安装程序", MessageBoxButton.YesNo, MessageBoxImage.Warning,
                MessageBoxResult.No) != MessageBoxResult.No;
            if (!ok) return;
            _cts?.Cancel(); // 确认退出：RunSteps 跑完当前一步后不再启动后续步骤
        }
        Close();
    }

    private void OnBrowseClick(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择安装位置",
            InitialDirectory = DirBox.Text,
        };
        if (dialog.ShowDialog(this) == true)
        {
            DirBox.Text = dialog.FolderName;
            DirError.Visibility = Visibility.Collapsed;
        }
    }

    private void OnInstallClick(object sender, RoutedEventArgs e)
    {
        string dir;
        try
        {
            dir = InstallFlow.ValidateDir(DirBox.Text);
        }
        catch (Exception ex)
        {
            DirError.Text = ex.Message;
            DirError.Visibility = Visibility.Visible;
            return;
        }
        if (!_preview && !Payload.HasAll())
        {
            DirError.Text = "安装包不完整（内嵌产物缺失），请用 scripts/build-installer.ps1 重新构建。";
            DirError.Visibility = Visibility.Visible;
            return;
        }

        _cts = new CancellationTokenSource();
        _flow = new InstallFlow(dir, DesktopShortcutBox.IsChecked == true);
        SwitchTo(ProgressPage);
        BuildStepList(_flow.BuildSteps());
        RunSteps(_flow.BuildSteps(), dir);
    }

    private void OnFinishClick(object sender, RoutedEventArgs e)
    {
        if (RunNowBox.IsChecked == true && _preview == false)
        {
            // 提权进程直接 Start 子进程会继承管理员令牌；主应用不需要也不该要管理员。
            // 经 explorer 拉起即以普通用户身份运行。
            var exe = Path.Combine(_flow!.InstallDir, Defs.AppExeName);
            Process.Start(new ProcessStartInfo("explorer.exe", "\"" + exe + "\"")
            {
                UseShellExecute = true,
            });
        }
        Close();
    }

    /// 离屏验收：把进度页摆到「2 完成 + 1 进行」的状态（App.ShotAll 调用）。
    public void EnterProgressShot()
    {
        SwitchTo(ProgressPage);
        var steps = new InstallFlow(Defs.DefaultInstallDir).BuildSteps();
        BuildStepList(steps);
        MarkStep(0, "done");
        MarkStep(1, "run");
        ProgressTitle.Text = "正在安装…";
    }

    /// 离屏验收：完成页（App.ShotAll 调用）。
    public void EnterDoneShot()
    {
        SwitchTo(DonePage);
        Bar.Value = 100;
        DoneNote.Text = "已安装到 " + Defs.DefaultInstallDir +
                        "\n采集服务已随系统启动，随时打开主界面即可查看实时流量。";
    }

    // ---------- 页面切换与步骤渲染 ----------

    private void SwitchTo(UIElement page)
    {
        WelcomePage.Visibility = page == WelcomePage ? Visibility.Visible : Visibility.Collapsed;
        ProgressPage.Visibility = page == ProgressPage ? Visibility.Visible : Visibility.Collapsed;
        DonePage.Visibility = page == DonePage ? Visibility.Visible : Visibility.Collapsed;
    }

    private readonly List<TextBlock> _stepRows = new();

    private void BuildStepList(IReadOnlyList<InstallFlow.Step> steps)
    {
        StepList.Children.Clear();
        _stepRows.Clear();
        foreach (var step in steps)
        {
            var row = new TextBlock
            {
                Text = "·  " + step.Title,
                FontSize = 13,
                Foreground = new SolidColorBrush((Color)ColorConverter.ConvertFromString("#9AA0A6")),
                Margin = new Thickness(0, 7, 0, 0),
            };
            StepList.Children.Add(row);
            _stepRows.Add(row);
        }
    }

    private void MarkStep(int index, string state)
    {
        if (index < 0 || index >= _stepRows.Count) return;
        var row = _stepRows[index];
        var title = row.Text[3..]; // 去掉前缀符号重新着色
        row.Text = state switch
        {
            "run" => "▸  " + title,
            "done" => "✓  " + title,
            "fail" => "✕  " + title,
            _ => row.Text,
        };
        // 语义色对齐 v2：进行=反白（accent 语义）、完成=--ok、失败=--error、待办=text-3
        var color = state switch
        {
            "run" => (Color)ColorConverter.ConvertFromString("#E3E5E9"),
            "done" => (Color)ColorConverter.ConvertFromString("#4CC38A"),
            "fail" => (Color)ColorConverter.ConvertFromString("#E57373"),
            _ => (Color)ColorConverter.ConvertFromString("#686E77"),
        };
        row.Foreground = new SolidColorBrush(color);
        Bar.Value = state == "done" ? Math.Min(100, (index + 1) * 100.0 / _stepRows.Count) : Bar.Value;
    }

    /// 步骤驱动。preview 模式：不执行动作，按固定节奏推进，供截屏验收。
    /// 真实流程每步写 ProgramData\NetPeek\setup.log（用户报障的唯一证据面），
    /// 失败时调 Compensate 尽力清理已注册的服务/快捷方式/卸载键。
    private async void RunSteps(IReadOnlyList<InstallFlow.Step> steps, string dir)
    {
        var ct = _cts?.Token ?? CancellationToken.None;
        SetupLog.Write("安装开始，目标目录=" + dir + "，版本=" + InstallFlow.VersionText());
        ProgressTitle.Text = _preview ? "正在预览安装流程…" : "正在安装…";
        for (var i = 0; i < steps.Count; i++)
        {
            if (ct.IsCancellationRequested) return; // 用户已确认退出：止步于当前进度
            MarkStep(i, "run");
            try
            {
                if (_preview)
                {
                    // 慢速推进：给截屏留时间窗（autoRun 档由跨进程编排触发，节奏放宽到 3s/步）
                    await Task.Delay(_autoRun ? 3000 : 600, ct);
                }
                else
                {
                    var note = await Task.Run(steps[i].Run);
                    SetupLog.Write($"步骤完成[{i}]：{steps[i].Title}" + (string.IsNullOrEmpty(note) ? "" : "（" + note + "）"));
                }
                MarkStep(i, "done");
            }
            catch (OperationCanceledException)
            {
                return; // 等待推进时被取消：与循环头的检查同语义，安静收场
            }
            catch (Exception ex)
            {
                MarkStep(i, "fail");
                SetupLog.Write($"步骤失败[{i}]：{steps[i].Title}：{ex.Message}");
                if (ct.IsCancellationRequested) return; // 窗口已关：不再补偿、不再弹框

                var comp = new List<string>();
                try { await Task.Run(() => _flow!.Compensate(i, comp)); }
                catch { /* 补偿尽力而为 */ }
                foreach (var line in comp) SetupLog.Write("补偿清理：" + line);

                ProgressTitle.Text = "安装失败";
                // 不挂 owner：用户可能已经把窗口关掉，对已关闭窗口 Show(owner) 会抛
                // InvalidOperationException，async void 里没人接 —— 进程直接崩。
                MessageBox.Show(steps[i].Title + "失败：\n" + ex.Message +
                                "\n\n已尽力清理本次安装注册的服务与卸载项，程序文件保留在 " +
                                _flow!.InstallDir + "（重装可直接覆盖）。\n\n日志：" + SetupLog.FilePath,
                    "NetPeek 安装程序", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }
        }
        SetupLog.Write("安装完成");
        Bar.Value = 100;
        SwitchTo(DonePage);
        DoneNote.Text = "已安装到 " + dir +
                        (_preview ? "\n（预览模式：未写入任何文件、未注册任何服务）"
                                  : "\n采集服务已随系统启动，随时打开主界面即可查看实时流量。");
    }
}
