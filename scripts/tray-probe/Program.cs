// 托盘状态探针：站在应用外面，读托盘图标 tooltip 与右键菜单的**真实文本**，
// 并支持截屏判读 —— 把「托盘状态有没有跟实际同步」这件事纳入可重复的验证。
//
// 为什么需要它：托盘菜单是 explorer 的原生 HMENU，Tauri 侧只能"发出" set_text 请求，
// 自己无法确认原生菜单是否真的刷新了；Web 侧与 headless Chrome 更是完全看不到它
// （docs/开发进度.md §13.4 为此留过一句「托盘同步是原生菜单，headless 测不了」）。
// 这个探针补的就是那个缺口：它读到的就是用户眼睛看到的那份文本。
//
// 用法（先 dotnet build -c Release，再跑 bin/Release/net8.0-windows/trayprobe.exe）：
//   trayrect              打印任务栏 / 通知区域 / 溢出窗口的几何（定位用）
//   dump                  打印托盘区域 UIA 子树（结构探测用）
//   find   [匹配]         全桌面找名字含匹配串的 UIA 元素
//   tooltip|menu [匹配]   读图标 tooltip / 右键弹出菜单并读全部菜单项文本
//   menushot <png>        右键弹出菜单，截菜单窗口并报告主色/亮度（判读菜单深浅，§37）
//   shot   <路径> <x> <y> <w> <h>   区域截屏（不带坐标则截任务栏右侧一条）
//   move   <x> <y> [ms]   移动鼠标并停留
//   lclick|rclick <x> <y> 左键 / 右键点击
//   esc                   发 ESC（关掉弹出的菜单）
//
// 实测踩过的三个坑，动这个文件前先看：
//   1. **必须先 SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)**（见 Main），
//      否则 GetWindowRect 与 CopyFromScreen 活在两套坐标系里，截出来的"任务栏"是
//      IDE 状态栏。本机屏幕 1920×1200，任务栏自动隐藏：平时 Shell_TrayWnd 顶在
//      y=1198（只剩 2px），先把鼠标移到底部才会滑出到 y=1128。
//   2. **UIA 读不到 Win11 托盘的图标**：Shell_TrayWnd 整棵子树只有 2 个 UIA 元素，
//      XAML 托盘不暴露图标节点。所以图标只能靠截图判读 —— NetPeek 默认折叠在溢出区
//      （`^` 箭头，本机约 x=1515,y=1164），展开后图标约在 (1426,1010)。
//   3. tooltip 气泡要"移入"才触发：鼠标已经在图标上时再 move 同一坐标不会弹。
//      先移到旁边（如 x+26）停一下，再移回图标。
//
// 用法示例见 docs/开发进度.md §34.6 的那张验证表。

using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using System.Windows.Automation;

namespace TrayProbe;

internal static class Program
{
    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        // 必须 DPI 感知：否则 GetWindowRect 与 CopyFromScreen 活在两套坐标系里，
        // 截出来的"任务栏"是 IDE 状态栏（实测踩过）。
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
        var cmd = args.Length > 0 ? args[0] : "dump";
        var match = args.Length > 1 ? args[1] : "NetPeek";

        var tray = FindTrayRoot();
        if (tray == null)
        {
            Console.WriteLine("PROBE-ERROR 找不到 Shell_TrayWnd");
            return 2;
        }

        switch (cmd)
        {
            case "dump":
                Dump(tray, 0, 6);
                return 0;
            case "tooltip":
            {
                var icon = FindIcon(tray, match);
                if (icon == null) { Console.WriteLine("PROBE-ERROR 找不到托盘图标 " + match); return 3; }
                Console.WriteLine("TOOLTIP=" + icon.Current.Name);
                return 0;
            }
            case "menu":
            {
                var icon = FindIcon(tray, match);
                if (icon == null) { Console.WriteLine("PROBE-ERROR 找不到托盘图标 " + match); return 3; }
                Console.WriteLine("TOOLTIP=" + icon.Current.Name);
                foreach (var t in ReadMenu(icon)) Console.WriteLine("MENUITEM=" + t);
                return 0;
            }
            case "find":
                FindAll(match);
                return 0;
            case "shot":
                if (args.Length >= 6)
                {
                    ShotArea(args[1], int.Parse(args[2]), int.Parse(args[3]), int.Parse(args[4]), int.Parse(args[5]));
                }
                else
                {
                    Shot(args.Length > 1 ? args[1] : "shot.png", args.Length > 2 && args[2] == "full");
                }
                return 0;
            case "rclick":
            {
                int cx = int.Parse(args[1]);
                int cy = int.Parse(args[2]);
                Native.SetCursorPos2(cx, cy);
                Thread.Sleep(150);
                Native.RightClick();
                Thread.Sleep(700);
                return 0;
            }
            case "lclick":
            {
                Native.SetCursorPos2(int.Parse(args[1]), int.Parse(args[2]));
                Thread.Sleep(150);
                Native.LeftClick();
                Thread.Sleep(700);
                return 0;
            }
            case "move":
                Native.SetCursorPos2(int.Parse(args[1]), int.Parse(args[2]));
                Thread.Sleep(args.Length > 3 ? int.Parse(args[3]) : 900);
                return 0;
            case "esc":
                Native.Escape();
                return 0;
            case "menushot":
                MenuShot(args.Length > 2 ? args[2] : null);
                return 0;
            case "trayrect":
                TrayRect();
                return 0;
            case "minimize":
                Minimize(args.Length > 1 ? args[1] : "NetPeek");
                return 0;
            default:
                Console.WriteLine("用法：trayprobe dump|tooltip|menu [匹配名]");
                return 1;
        }
    }

    private static void ShotArea(string path, int x, int y, int w, int h)
    {
        using var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h));
        }
        bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        Console.WriteLine($"SHOT={path} area={x},{y},{w}x{h}");
    }

    // ---------- 菜单配色判读（§37） ----------

    /// <summary>
    /// 右键弹出托盘菜单，抓取菜单窗口（类名 #32768）的真实像素，并报告主色与亮度。
    /// 存在的理由：「菜单有没有跟着应用主题变深」这件事，肉眼看截图容易自我说服，
    /// 而菜单背景色是系统画上去的，只有取到真实像素才算证据。主色取全部像素的
    /// 众数（量化到 8 级），菜单背景占比压倒性，因此众数≈背景色。
    /// </summary>
    private static void MenuShot(string path)
    {
        var tray = FindTrayRoot();
        if (tray == null) { Console.WriteLine("PROBE-ERROR 找不到 Shell_TrayWnd"); return; }
        var icon = FindIcon(tray, "NetPeek");
        if (icon == null) { Console.WriteLine("PROBE-ERROR 找不到托盘图标 NetPeek"); return; }
        var r = icon.Current.BoundingRectangle;
        if (r.IsEmpty) { Console.WriteLine("PROBE-ERROR 图标矩形为空（可能仍折叠在溢出区）"); return; }

        int ix = (int)(r.Left + r.Width / 2);
        int iy = (int)(r.Top + r.Height / 2);
        Native.SetCursorPos2(ix, iy);
        Thread.Sleep(150);
        Native.RightClick();
        Thread.Sleep(900);

        var hMenu = FindPopupMenu(out var mr);
        if (hMenu == IntPtr.Zero)
        {
            Console.WriteLine("PROBE-ERROR 找不到可见的 #32768 弹出菜单窗口");
            Native.Escape();
            return;
        }

        int w = mr.Right - mr.Left;
        int h = mr.Bottom - mr.Top;
        Console.WriteLine($"MENURECT={mr.Left},{mr.Top},{w}x{h} hwnd=0x{hMenu.ToInt64():X}");

        using var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(mr.Left, mr.Top, 0, 0, new System.Drawing.Size(w, h));
        }
        if (!string.IsNullOrEmpty(path))
        {
            bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            Console.WriteLine($"SHOT={path}");
        }

        // 众数色 + 平均亮度。量化到 8 级（每通道 32 一档）抗抗锯齿噪点。
        var buckets = new Dictionary<int, int>();
        long sumLum = 0;
        int total = 0;
        for (int y = 0; y < h; y++)
        {
            for (int x = 0; x < w; x++)
            {
                var c = bmp.GetPixel(x, y);
                int key = (c.R >> 3) << 10 | (c.G >> 3) << 5 | (c.B >> 3);
                buckets.TryGetValue(key, out var n);
                buckets[key] = n + 1;
                sumLum += (299 * c.R + 587 * c.G + 114 * c.B) / 1000;
                total++;
            }
        }
        int bestKey = 0, bestN = -1;
        foreach (var kv in buckets)
        {
            if (kv.Value > bestN) { bestN = kv.Value; bestKey = kv.Key; }
        }
        int br = ((bestKey >> 10) & 31) << 3;
        int bg = ((bestKey >> 5) & 31) << 3;
        int bb = (bestKey & 31) << 3;
        Console.WriteLine($"MENUBG=#{br:X2}{bg:X2}{bb:X2} share={(double)bestN / total:P1}");
        Console.WriteLine($"MENULUMA_AVG={sumLum / Math.Max(1, total)}");
        Console.WriteLine("MENUTHEME=" + (sumLum / Math.Max(1, total) < 120 ? "DARK" : "LIGHT"));

        Native.Escape();
        Thread.Sleep(250);
    }

    /// <summary>找当前可见的 #32768（系统弹出菜单）顶层窗口，取面积最大的那个。</summary>
    private static IntPtr FindPopupMenu(out Native.RECT found)
    {
        Native.RECT bestRect = default;
        IntPtr best = IntPtr.Zero;
        long bestArea = -1;
        Native.EnumWindows((hwnd, _) =>
        {
            var sb = new StringBuilder(64);
            Native.GetClassNameW(hwnd, sb, sb.Capacity);
            if (sb.ToString() != "#32768") return true;
            if (!Native.IsWindowVisible(hwnd)) return true;
            if (!Native.GetWindowRect(hwnd, out var rr)) return true;
            long area = (long)(rr.Right - rr.Left) * (rr.Bottom - rr.Top);
            if (area > bestArea) { bestArea = area; best = hwnd; bestRect = rr; }
            return true;
        }, IntPtr.Zero);
        found = bestRect;
        return best;
    }

    // ---------- 任务栏几何 ----------

    /// <summary>按标题最小化窗口（SW_MINIMIZE）。用来验「最小化时托盘菜单该写什么」。</summary>
    private static void Minimize(string title)
    {
        var h = Native.FindWindowW(null, title);
        if (h == IntPtr.Zero)
        {
            Console.WriteLine("PROBE-ERROR 找不到窗口：" + title);
            return;
        }
        Native.ShowWindow(h, 6 /* SW_MINIMIZE */);
        Console.WriteLine($"MINIMIZED hwnd=0x{h.ToInt64():X} title={title}");
    }

    private static void TrayRect()
    {
        Console.WriteLine($"SCREEN={Native.GetSystemMetrics(0)}x{Native.GetSystemMetrics(1)}");
        foreach (var cls in new[] { "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland" })
        {
            var h = Native.FindWindowW(cls, null);
            if (h == IntPtr.Zero) { Console.WriteLine($"{cls}: (无)"); continue; }
            Native.GetWindowRect(h, out var r);
            Console.WriteLine($"{cls}: hwnd=0x{h.ToInt64():X} rect={r.Left},{r.Top},{r.Right - r.Left}x{r.Bottom - r.Top} visible={Native.IsWindowVisible(h)}");
            // 子窗口里找托盘工具条
            Native.EnumChildWindows(h, (child, _) =>
            {
                var sb = new StringBuilder(256);
                Native.GetClassNameW(child, sb, sb.Capacity);
                if (Native.GetWindowRect(child, out var cr) && cr.Right > cr.Left)
                {
                    var n = sb.ToString();
                    if (n.Contains("Toolbar") || n.Contains("Tray") || n.Contains("SysPager"))
                        Console.WriteLine($"   child cls='{n}' rect={cr.Left},{cr.Top},{cr.Right - cr.Left}x{cr.Bottom - cr.Top} vis={Native.IsWindowVisible(child)}");
                }
                return true;
            }, IntPtr.Zero);
        }
    }

    // ---------- 截屏 ----------

    /// <summary>
    /// 截屏。默认只截任务栏那一条（屏幕底部右侧 900×60 交给它足够看清托盘），
    /// full 参数则截整个虚拟屏幕。物理像素坐标，不做 DPI 换算。
    /// </summary>
    private static void Shot(string path, bool full)
    {
        int vx = Native.GetSystemMetrics(76);  // SM_XVIRTUALSCREEN
        int vy = Native.GetSystemMetrics(77);
        int vw = Native.GetSystemMetrics(78);
        int vh = Native.GetSystemMetrics(79);
        int x, y, w, h;
        if (full)
        {
            x = vx; y = vy; w = vw; h = vh;
        }
        else
        {
            // 任务栏在屏幕底部；右半边 40% 宽 × 80px 高足够覆盖通知区域。
            int sw = Native.GetSystemMetrics(0);
            int sh = Native.GetSystemMetrics(1);
            w = Math.Min(1400, sw);
            h = 80;
            x = sw - w;
            y = sh - h;
        }

        using var bmp = new System.Drawing.Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = System.Drawing.Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(x, y, 0, 0, new System.Drawing.Size(w, h));
        }
        bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        Console.WriteLine($"SHOT={path} area={x},{y},{w}x{h} screen={Native.GetSystemMetrics(0)}x{Native.GetSystemMetrics(1)}");
    }

    // ---------- 全局查找 ----------

    /// <summary>在整棵桌面 UIA 树里找名字/帮助文本含匹配串的元素，打印其路径线索。</summary>
    private static void FindAll(string match)
    {
        var root = AutomationElement.RootElement;
        int seen = 0;
        var wins = root.FindAll(TreeScope.Children, Condition.TrueCondition);
        foreach (AutomationElement w in wins)
        {
            string wcls, wname;
            try { wcls = w.Current.ClassName; wname = w.Current.Name; } catch { continue; }
            if (wcls != "Shell_TrayWnd" && wcls != "Shell_SecondaryTrayWnd"
                && wcls != "NotifyIconOverflowWindow" && wcls != "TopLevelWindowForOverflowXamlIsland")
                continue;
            Console.WriteLine($"== 顶层窗口 cls='{wcls}' name='{wname}'");
            AutomationElementCollection all;
            try { all = w.FindAll(TreeScope.Descendants, Condition.TrueCondition); }
            catch (Exception ex) { Console.WriteLine("   枚举失败：" + ex.Message); continue; }
            foreach (AutomationElement e in all)
            {
                string name, cls, help;
                try
                {
                    name = e.Current.Name; cls = e.Current.ClassName; help = e.Current.HelpText;
                }
                catch { continue; }
                seen++;
                var hit = (name != null && name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0)
                          || (help != null && help.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0);
                if (!hit) continue;
                var r = e.Current.BoundingRectangle;
                Console.WriteLine($"   HIT ctl={e.Current.ControlType.ProgrammaticName} cls='{cls}' name='{name}' help='{help}' rect={r.Left},{r.Top},{r.Width}x{r.Height}");
            }
            Console.WriteLine($"   （该窗口可见 UIA 元素 {seen} 个）");
        }
    }

    // ---------- 定位 ----------

    private static AutomationElement FindTrayRoot()
    {
        var root = AutomationElement.RootElement;
        foreach (var cls in new[] { "Shell_TrayWnd", "Shell_SecondaryTrayWnd" })
        {
            var e = root.FindFirst(TreeScope.Children,
                new PropertyCondition(AutomationElement.ClassNameProperty, cls));
            if (e != null) return e;
        }
        return null;
    }

    private static AutomationElement FindIcon(AutomationElement tray, string match)
    {
        var all = tray.FindAll(TreeScope.Descendants, new PropertyCondition(
            AutomationElement.ControlTypeProperty, ControlType.Button));
        foreach (AutomationElement b in all)
        {
            var name = b.Current.Name;
            if (!string.IsNullOrEmpty(name) && name.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0)
                return b;
        }
        // Win11 里图标有时挂在工具栏按钮下，Name 为空但 HelpText 带 tooltip。
        var all2 = tray.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        foreach (AutomationElement b in all2)
        {
            var help = b.Current.HelpText;
            if (!string.IsNullOrEmpty(help) && help.IndexOf(match, StringComparison.OrdinalIgnoreCase) >= 0)
                return b;
        }
        return null;
    }

    // ---------- 打印结构 ----------

    private static void Dump(AutomationElement e, int depth, int max)
    {
        if (depth > max) return;
        AutomationElementCollection kids;
        try { kids = e.FindAll(TreeScope.Children, Condition.TrueCondition); }
        catch { return; }
        foreach (AutomationElement c in kids)
        {
            string cls, name, ctl;
            try
            {
                cls = c.Current.ClassName;
                name = c.Current.Name;
                ctl = c.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
            }
            catch { continue; }
            if (name != null && name.Length > 60) name = name.Substring(0, 60) + "…";
            Console.WriteLine(new string(' ', depth * 2) + $"[{ctl}] cls='{cls}' name='{name}'");
            Dump(c, depth + 1, max);
        }
    }

    // ---------- 读菜单 ----------

    private static List<string> ReadMenu(AutomationElement icon)
    {
        var result = new List<string>();
        var r = icon.Current.BoundingRectangle;
        if (r.IsEmpty)
        {
            result.Add("(图标矩形为空，可能在溢出区里)");
            return result;
        }

        // 先把光标挪到图标上并右键，弹出原生菜单。
        int x = (int)(r.Left + r.Width / 2);
        int y = (int)(r.Top + r.Height / 2);
        Native.SetCursorPos2(x, y);
        Thread.Sleep(120);
        Native.RightClick();
        Thread.Sleep(600);

        // 菜单属于另一个进程（explorer 的 XAML 弹窗），从根找 Menu / MenuItem。
        var menus = AutomationElement.RootElement.FindAll(TreeScope.Descendants,
            new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Menu));
        if (menus.Count == 0)
        {
            result.Add("(没读到菜单——可能未弹出，或需要 UIAccess)");
            Native.Escape();
            return result;
        }

        foreach (AutomationElement m in menus)
        {
            var items = m.FindAll(TreeScope.Descendants, new PropertyCondition(
                AutomationElement.ControlTypeProperty, ControlType.MenuItem));
            foreach (AutomationElement it in items)
            {
                try { result.Add(it.Current.Name); } catch { /* 菜单已关 */ }
            }
        }
        Native.Escape();
        Thread.Sleep(200);
        return result;
    }
}

internal static class Native
{
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetSystemMetrics")]
    private static extern int GetSystemMetricsImpl(int index);

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, EntryPoint = "FindWindowW")]
    public static extern IntPtr FindWindowW(string cls, string win);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int cmd);

    [System.Runtime.InteropServices.DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    public static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);

    public delegate bool EnumChildProc(IntPtr hwnd, IntPtr lparam);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc proc, IntPtr lparam);

    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lparam);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lparam);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }


    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    private const uint RIGHTDOWN = 0x0008;
    private const uint RIGHTUP = 0x0010;
    private const uint LEFTDOWN = 0x0002;
    private const uint LEFTUP = 0x0004;
    private const byte VK_ESCAPE = 0x1B;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    public static int GetSystemMetrics(int index) => GetSystemMetricsImpl(index);

    public static void SetCursorPos2(int x, int y) => SetCursorPos(x, y);

    public static void RightClick()
    {
        mouse_event(RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(RIGHTUP, 0, 0, 0, UIntPtr.Zero);
    }

    public static void LeftClick()
    {
        mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
        mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    }

    public static void Escape()
    {
        keybd_event(VK_ESCAPE, 0, 0, UIntPtr.Zero);
        keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}
