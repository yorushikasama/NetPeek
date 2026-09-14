#!/usr/bin/env python3
"""几何 QA：把拟合出的 SVG 渲染回来，与栅格源做「中心线级」比对。

设计要点（踩过的坑，别退回去）：

1. **源图有底片、渲染图是透明底** —— 直接拿亮度阈值做掩码是不对等的：
   源图的笔画边缘是和深色底片混出来的，渲染图的边缘是和不透明的黑色混出来的，
   同一个阈值在两边切出的粗细不一样。所以两侧都用**逐列 50% 覆盖度**：
   以该列的中位亮度为背景、该列峰值为前景，取覆盖度 = (lum-bg)/(peak-bg) > 0.5
   的那一段。抗锯齿渲染的几何边缘正落在 50% 覆盖处，于是这个判据量的是
   「几何笔画」本身，与底色无关。

2. **测量时必须关掉辉光** —— #pulse-glow 是刻意加宽的模糊复制，
   开着它量出来的"笔画粗细"是辉光的宽度，不是线芯的宽度。
   本工具会把 logo.svg 复制一份并注入 `#pulse-glow{display:none}` 再渲染测量。

3. 本机 chrome.exe 命令行 headless 会静默挂死（Chrome 152），所以渲染走
   tools/rasterize.mjs（Playwright + 系统 Chrome）。

用法：
  python overlay_qa.py logo.svg "D:/NetPeek/图标.png" \
      --out outputs/qa_overlay.png --render-out outputs/final_render.png \
      --report outputs/fit_metrics.json
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
RASTERIZE = HERE / "rasterize.mjs"
NODE = Path("C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe")

# 两条笔画各自的取样窗口（源图 1254×1254 坐标系）。
# main：主波墨迹 y 446..704，向上留余量到 380 装辉光；下沿卡 715 —— 必须低于主波
#       墨迹底(704)、又高于暗波墨迹顶(726)，否则同一列里会同时出现两条线。
# echo：暗波墨迹 y 726..840，窗口底留到 902 供 from_bottom 找峰。
BANDS = {
    "main": dict(y0=380, y1=715, x0=210, x1=1035, label="主波(琥珀)", from_bottom=False),
    "echo": dict(y0=716, y1=902, x0=210, x1=1035, label="暗波(次级)", from_bottom=True),
}
# 「该列有笔画」所需的最小峰高（相对该列 10 分位基底）。
# 主波峰值很高，取大值可顺带滤掉辉光；暗波只有 ~20 亮度差，必须取小。
MIN_PROM = {"main": 40.0, "echo": 10.0}
# 合理的笔画厚度上限（期望值：主波 22px、暗波 17px），用来滤掉辉光碎片。
MAX_THICK = {"main": 34, "echo": 30}


def luminance(a: np.ndarray) -> np.ndarray:
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def render_svg(svg: Path, w: int, h: int, out_png: Path, bg: str = "transparent") -> None:
    out_png.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        [str(NODE), str(RASTERIZE), str(svg), "--out", str(out_png),
         "--w", str(w), "--h", str(h), "--scale", "1", "--bg", bg],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        sys.exit(f"渲染失败（rc={r.returncode}）:\n{r.stdout}\n{r.stderr}")


def strip_glow(svg_text: str) -> str:
    """注入样式把辉光藏掉，供测量用（不影响交付物）。"""
    style = "<style>#pulse-glow{display:none}</style>"
    if "</svg>" not in svg_text:
        sys.exit("SVG 缺少 </svg> 收尾标签")
    return svg_text.replace("</svg>", style + "\n</svg>")


def smooth(col: np.ndarray, k: int = 5) -> np.ndarray:
    if col.size < k:
        return col
    kern = np.ones(k) / k
    return np.convolve(col, kern, mode="same")


def signal_of(img: np.ndarray) -> tuple[np.ndarray, str]:
    """不透明图用亮度当信号；透明图用 alpha（未预乘，边缘像素的亮度仍是笔画本色，
    拿亮度去切会把整个抗锯齿带都算成实心）。"""
    alpha = img[..., 3]
    transparent = float(np.percentile(alpha, 75)) < 240
    if transparent:
        return alpha.astype(float), "alpha"
    return luminance(img), "亮度"


def segment_profile(
    sig: np.ndarray, band: dict, min_prom: float, max_thick: int, from_bottom: bool = False
) -> dict[int, dict]:
    """逐列求「峰值 → 50% 高度」的段。返回 {x: {top, bot, cy, thick}}。

    为什么是 50% 高度而不是固定阈值：抗锯齿渲染的几何边缘正落在峰值与基底的
    中点，所以这个判据量到的是「几何笔画」，与底色深浅无关 —— 源图和渲染图
    因此可以公平对比。

    from_bottom=True 时从窗口底部往上找第一个显著局部峰：
    暗波是画面里最靠下的结构，而主波的辉光尾巴会在同一列造出更高的峰，
    从底部往上找就能稳定跳过辉光。
    """
    y0, y1, x0, x1 = band["y0"], band["y1"], band["x0"], band["x1"]
    out: dict[int, dict] = {}
    for x in range(x0, x1):
        col = smooth(sig[y0:y1, x])
        floor = float(np.percentile(col, 10))
        if col.max() - floor < min_prom:
            continue
        if from_bottom:
            idx = None
            for i in range(col.size - 2, 0, -1):
                if col[i] >= col[i - 1] and col[i] >= col[i + 1] and col[i] - floor >= min_prom:
                    idx = i
                    break
            if idx is None:
                continue
        else:
            idx = int(col.argmax())
        half = (col[idx] + floor) / 2
        a = idx
        while a > 0 and col[a - 1] > half:
            a -= 1
        b = idx
        while b < col.size - 1 and col[b + 1] > half:
            b += 1
        if (b - a + 1) > max_thick:
            continue
        out[x] = {
            "top": int(y0 + a),
            "bot": int(y0 + b),
            "cy": round(y0 + (a + b) / 2, 2),
            "thick": int(b - a + 1),
        }
    return out


def compare(src_prof: dict, ren_prof: dict) -> dict:
    common = sorted(set(src_prof) & set(ren_prof))
    if not common:
        return {"cols": 0}
    dcy = np.array([ren_prof[x]["cy"] - src_prof[x]["cy"] for x in common])
    dth = np.array([ren_prof[x]["thick"] - src_prof[x]["thick"] for x in common])
    worst = sorted(common, key=lambda x: -abs(ren_prof[x]["cy"] - src_prof[x]["cy"]))[:6]
    return {
        "cols": len(common),
        "src_cols": len(src_prof),
        "render_cols": len(ren_prof),
        "coverage": round(len(common) / max(len(src_prof), 1), 3),
        "dcy_mean": round(float(dcy.mean()), 3),
        "dcy_rms": round(float(np.sqrt((dcy**2).mean())), 3),
        "dcy_max": round(float(np.abs(dcy).max()), 3),
        "dthick_mean": round(float(dth.mean()), 3),
        "src_thick_median": int(np.median([src_prof[x]["thick"] for x in common])),
        "render_thick_median": int(np.median([ren_prof[x]["thick"] for x in common])),
        "worst": [
            {"x": x, "src_cy": src_prof[x]["cy"], "render_cy": ren_prof[x]["cy"],
             "d": round(ren_prof[x]["cy"] - src_prof[x]["cy"], 2)}
            for x in worst
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("svg", type=Path)
    ap.add_argument("source", type=Path)
    ap.add_argument("--out", type=Path, required=True, help="叠加图（源为底，渲染笔画涂青）")
    ap.add_argument("--render-out", type=Path, default=None)
    ap.add_argument("--report", type=Path, default=None)
    args = ap.parse_args()

    src = np.asarray(Image.open(args.source).convert("RGBA")).astype(int)
    H, W = src.shape[:2]

    tmp = args.out.parent / ".qa_tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    noglow = tmp / "noglow.svg"
    noglow.write_text(strip_glow(args.svg.read_text(encoding="utf-8")), encoding="utf-8")
    meas_png = tmp / "noglow.png"
    full_png = tmp / "full.png"
    render_svg(noglow, W, H, meas_png)
    render_svg(args.svg, W, H, full_png)

    meas = np.asarray(Image.open(meas_png).convert("RGBA")).astype(int)
    full = np.asarray(Image.open(full_png).convert("RGBA")).astype(int)
    if args.render_out:
        args.render_out.parent.mkdir(parents=True, exist_ok=True)
        Image.open(full_png).save(args.render_out)

    rep: dict = {"svg": str(args.svg).replace("\\", "/"),
                 "source": str(args.source).replace("\\", "/")}
    sig_src, kind_src = signal_of(src)
    sig_ren, kind_ren = signal_of(meas)
    print(f"源图 {W}×{H}   信号：源图用{kind_src}，渲染用{kind_ren}")
    for key, band in BANDS.items():
        sp = segment_profile(sig_src, band, MIN_PROM[key], MAX_THICK[key], band["from_bottom"])
        rp = segment_profile(sig_ren, band, MIN_PROM[key], MAX_THICK[key], band["from_bottom"])
        cmp = compare(sp, rp)
        rep[key] = {"band": {k: v for k, v in band.items() if k not in ("label", "from_bottom")}, **cmp}
        print(f"\n=== {band['label']}  (窗口 y {band['y0']}..{band['y1']}) ===")
        if cmp["cols"] < 5:
            print("  可比列太少，无法判定 —— 先查掩码/窗口是否合适")
            continue
        print(f"  可比列 {cmp['cols']}  源命中 {cmp['src_cols']}  渲染命中 {cmp['render_cols']}  覆盖率 {cmp['coverage']}")
        print(f"  线宽  源中位 {cmp['src_thick_median']}px  渲染中位 {cmp['render_thick_median']}px  Δ中位 {cmp['dthick_mean']:+.2f}")
        print(f"  中心线 Δcy  均值 {cmp['dcy_mean']:+.3f}  RMS {cmp['dcy_rms']:.3f}  最大 {cmp['dcy_max']:.3f}")
        print("  偏差最大的 6 列：")
        for w in cmp["worst"]:
            print(f"    x={w['x']:>5}  源 cy={w['src_cy']:>8}  渲染 cy={w['render_cy']:>8}  Δ={w['d']:>+7}")

    # 叠加图：源为底，渲染的可见墨水涂青
    over = src.copy()
    ink = full[..., 3] > 128
    cyan = np.array([0, 225, 240, 255])
    over[ink] = (over[ink] * 0.25 + cyan * 0.75).astype(int)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(over.astype(np.uint8)).save(args.out)
    rep["overlay"] = str(args.out).replace("\\", "/")
    print(f"\n叠加图 -> {args.out}（青=渲染的墨水，露出的原色=源里渲染没盖住的地方）")

    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"报告   -> {args.report}")

    for p in (noglow, meas_png, full_png):
        try:
            p.unlink()
        except OSError:
            pass
    try:
        tmp.rmdir()
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
