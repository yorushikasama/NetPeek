"""校验主窗口是否落在显示器**工作区**的正中。

为什么需要它：窗口位置在 tauri.conf.json 里没写时，tao 会把 `(CW_USEDEFAULT,
CW_USEDEFAULT)` 交给 `CreateWindowExW`，由 Windows 自己挑位置 —— 而 Windows
的规则是「从工作区左上角起算的级联偏移」，且**每次启动还会往下再串一格**。
于是表现为「启动时窗口偏右下」，而且位置不稳定。

图片截屏看不出「居中」这件事（居中是个相对量，得知道屏幕多大才算得出来），
所以这里直接问系统要三组数：窗口矩形、显示器矩形、显示器工作区矩形。

用 ctypes 而不是 PowerShell 的 Add-Type 是因为本机安全策略拦 Add-Type
（"Add-Type compiles and loads .NET code at runtime"）。

用法：
    # 应用已经在跑的时候执行
    python tools/check_window_center.py
    python tools/check_window_center.py --tolerance 1

退出码 0 = 居中（容差内），1 = 不居中或没找到窗口。
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as w
import sys

user32 = ctypes.WinDLL("user32", use_last_error=True)
try:
    shcore = ctypes.WinDLL("shcore", use_last_error=True)
except OSError:  # pragma: no cover - Win7 没有 shcore
    shcore = None


# ------------------------------------------------------------------ DPI
# 这步不能省。非 DPI 感知的进程调 GetWindowRect / GetMonitorInfo 拿到的是
# **虚拟化**过的坐标（系统按缩放比折算），跟 DPI 感知进程写进去的物理坐标
# 不同源，两个数一减就会得出「差了 200 多像素」这种假阳性。
def make_dpi_aware() -> str:
    # PER_MONITOR_AWARE_V2 = -4
    if user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
        return "per-monitor-v2"
    if shcore is not None and shcore.SetProcessDpiAwareness(2) == 0:
        return "per-monitor"
    if user32.SetProcessDPIAware():
        return "system"
    return "none"


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", w.DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", w.DWORD),
    ]


MONITORENUMPROC = ctypes.WINFUNCTYPE(
    ctypes.c_int, w.HMONITOR, w.HDC, ctypes.POINTER(RECT), w.LPARAM
)


def monitor_dpi(hmon) -> int:
    """该显示器的有效 DPI。0 = 查不到。

    为什么要单独查：窗口尺寸在配置里是**逻辑**像素（1180×720），系统按缩放比
    乘出物理尺寸。150% 的机器上它其实是 1770×1080 —— 不知道这个数，看到
    「窗口 1770 宽」会以为是哪里写错了。
    """
    if shcore is None:
        return 0
    try:
        shcore.GetDpiForMonitor.argtypes = [
            w.HMONITOR, ctypes.c_int,
            ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint),
        ]
        dx, dy = ctypes.c_uint(0), ctypes.c_uint(0)
        if shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dx), ctypes.byref(dy)) == 0:
            return int(dx.value)
    except Exception:
        pass
    return 0


def monitors() -> list[dict]:
    out: list[dict] = []

    def cb(hmon, _hdc, _rect, _lp):
        mi = MONITORINFO()
        mi.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
            out.append(
                {
                    "hmon": hmon,
                    "monitor": (mi.rcMonitor.left, mi.rcMonitor.top,
                                mi.rcMonitor.right, mi.rcMonitor.bottom),
                    "work": (mi.rcWork.left, mi.rcWork.top,
                             mi.rcWork.right, mi.rcWork.bottom),
                    "primary": bool(mi.dwFlags & 1),
                    "dpi": monitor_dpi(hmon),
                }
            )
        return 1

    user32.EnumDisplayMonitors(None, None, MONITORENUMPROC(cb), 0)
    return out


def windows() -> list[dict]:
    """所有顶层窗口。**不过滤可见性** —— 隐藏窗口的矩形照样是有效的，
    而 NetPeek 的主窗在托盘里就是隐藏态，那种情况下位置仍然要能量得到。"""
    out: list[dict] = []

    def cb(hwnd, _lp):
        n = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(n + 2)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        cbuf = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cbuf, 256)
        r = RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return 1
        out.append(
            {
                "hwnd": hwnd,
                "title": buf.value,
                "cls": cbuf.value,
                "rect": (r.left, r.top, r.right, r.bottom),
                "visible": bool(user32.IsWindowVisible(hwnd)),
                # 最小化的窗口 GetWindowRect 返回 (-32000, -32000) 这个**哨兵值**，
                # 不是位置。不把它标出来，就会拿哨兵值去减工作区，得出
                # 「偏了 32841 像素」这种一眼假的结论。实测踩过。
                "iconic": bool(user32.IsIconic(hwnd)),
            }
        )
        return 1

    user32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_int, w.HWND, w.LPARAM)(cb), 0)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--title", default="NetPeek",
                    help="主窗标题（精确匹配，用来区分同类名的迷你窗）")
    ap.add_argument("--class", dest="cls", default="netpeek",
                    help="窗口类名里包含的关键字（不区分大小写），标题匹配的兜底")
    ap.add_argument("--min-width", type=int, default=900,
                    help="主窗最小宽度，用来把小窗/托盘窗排除掉")
    ap.add_argument("--tolerance", type=float, default=1.0,
                    help="允许的居中偏差（像素）")
    args = ap.parse_args()

    aware = make_dpi_aware()
    mons = monitors()
    allwins = windows()

    # 匹配口径按标题，不按类名。实测 Tauri 主窗与迷你窗的类名**都是** "Tauri Window"
    # （tauri 用的是系统里的通用窗口类，不带应用标识），只有标题能区分；
    # 而带应用标识的 "com.netpeek.app-sic" 是单实例插件那个 22×22 的消息窗，不是主窗。
    # 所以：标题精确等于 --title，或标题含 --title 且宽 >= --min-width。
    def is_main(x: dict) -> bool:
        t = x["title"]
        if t == args.title:
            return True
        return args.cls in x["cls"].lower() and \
            (x["rect"][2] - x["rect"][0]) >= args.min_width

    wins = [x for x in allwins if is_main(x)]
    if wins and not any(not x["iconic"] for x in wins):
        print("主窗口当前是**最小化**状态，量不了位置：")
        print("  最小化窗口的 GetWindowRect 返回 (-32000, -32000) 哨兵值而非真实坐标。")
        print("  从任务栏还原（或托盘菜单「打开主界面」）后重跑。")
        return 2
    wins = [x for x in wins if not x["iconic"]]
    if not wins:
        print(f"没找到 NetPeek 主窗口（标题 {args.title!r}，或类名含 {args.cls!r} 且宽 >= {args.min_width}）")
        print("—— 进程可能还没起来（主窗在首绘完成时才创建/显示）。"
              "冷启动首次约 3~5s，稍等后重跑。")
        print("当前可见窗口：")
        for x in allwins:
            if not x["visible"]:
                continue
            w = x["rect"][2] - x["rect"][0]
            mark = "候选 " if (args.cls in x["cls"].lower() or args.title.lower() in x["title"].lower()) else "     "
            print(f"  {mark}cls={x['cls']!r} title={x['title']!r} "
                  f"rect={x['rect']} size={w}×{x['rect'][3] - x['rect'][1]}"
                  f"{'  [已最小化]' if x['iconic'] else ''}")
        for m in mons:
            ml, mt, mr, mb = m["monitor"]
            kl, kt, kr, kb = m["work"]
            print(f"  {'*' if m['primary'] else ' '} 显示器 {mr - ml}×{mb - mt} @({ml}, {mt})"
                  f"  DPI={m['dpi'] or '?'}   工作区 ({kl}, {kt})-({kr}, {kb})")
        return 1

    win = max(wins, key=lambda x: (x["rect"][2] - x["rect"][0]) * (x["rect"][3] - x["rect"][1]))
    wl, wt, wr, wb = win["rect"]
    ww, wh = wr - wl, wb - wt
    wcx, wcy = (wl + wr) / 2.0, (wt + wb) / 2.0

    print(f"DPI 感知：{aware}")
    print(f"主窗口  {win['cls']!r} title={win['title']!r} hwnd={win['hwnd']:#x}"
          f"  {'可见' if win['visible'] else '**不可见**（收在托盘 / 尚未 show；位置仍按已创建窗口量取）'}")
    print(f"  外框（物理）{ww}×{wh} @ ({wl}, {wt})   中心 ({wcx:.0f}, {wcy:.0f})")

    # 窗口中心落在哪个显示器上，就用那个显示器的工作区做判据 ——
    # 多屏时按主屏算会得出「差了一整个屏宽」这种没意义的结论。
    hit = None
    for m in mons:
        ml, mt, mr, mb = m["monitor"]
        if ml <= wcx < mr and mt <= wcy < mb:
            hit = m
            break
    if hit is None:
        hit = next((m for m in mons if m["primary"]), None)
    if hit is None:
        print("枚举不到显示器")
        return 1

    for m in mons:
        ml, mt, mr, mb = m["monitor"]
        kl, kt, kr, kb = m["work"]
        tag = " <-窗口所在" if m is hit else ("  主屏" if m["primary"] else "")
        star = "*" if m["primary"] else " "
        dpi = m["dpi"]
        scale = f"{dpi / 96 * 100:.0f}%" if dpi else "?"
        print(f" {star} 显示器 {mr - ml}×{mb - mt} @({ml}, {mt})  DPI={dpi or '?'}({scale})"
              f"   工作区 ({kl}, {kt})-({kr}, {kb}) = {kr - kl}×{kb - kt}{tag}")
    if hit["dpi"]:
        s = hit["dpi"] / 96.0
        print(f"  窗口逻辑尺寸 {ww / s:.0f}×{wh / s:.0f}（物理 ÷ {s:g}）")

    kl, kt, kr, kb = hit["work"]
    kw, kh = kr - kl, kb - kt
    ex, ey = kl + (kw - ww) // 2, kt + (kh - wh) // 2
    ecx, ecy = ex + ww / 2.0, ey + wh / 2.0
    dx, dy = wcx - ecx, wcy - ecy
    off_mid = abs(dx) <= args.tolerance and abs(dy) <= args.tolerance
    # 工作区可能比窗口小（例如 1180 宽的窗放在 1024 宽的屏上）。
    # 那种情况「居中」没有意义，只要求窗口完全落在工作区内。
    fits = kl <= wl and wt >= kt and wr <= kr and wb <= kb
    ok = fits and (off_mid or kw < ww or kh < wh)

    print()
    print(f"期望左上角 ({ex}, {ey})  →  期望中心 ({ecx:.0f}, {ecy:.0f})")
    print(f"实际偏中心 Δ = ({dx:+.0f}, {dy:+.0f}) px   容差 ±{args.tolerance:g}")
    print(f"四边留白  左 {wl - kl}  右 {kr - wr}  上 {wt - kt}  下 {kb - wb}"
          "   （居中时四边两两相等）")
    print(f"窗口完全落在工作区内：{'是' if fits else '否'}")
    print("居中   判定：" + ("通过" if ok else "**不居中**"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
