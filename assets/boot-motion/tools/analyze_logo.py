#!/usr/bin/env python3
"""Phase 1 — 定量分析 logo 栅格源，为矢量化拟合与动效编排提供数字依据。

只依赖 Pillow + numpy（不碰浏览器）。输出结构化报告，供 motion_spec.md 引用。

用法：
  python analyze_logo.py "D:/NetPeek/图标.png"
  python analyze_logo.py <src.png> --json outputs/phase1_report.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def region_report(name: str, mask: np.ndarray) -> dict:
    """给一个布尔掩码，回报它的 bbox / 面积 / 占比。"""
    px = int(mask.sum())
    if px == 0:
        return {"name": name, "px": 0, "bbox": None}
    ys, xs = np.where(mask)
    return {
        "name": name,
        "px": px,
        "pct_of_frame": round(px / mask.size * 100, 3),
        "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
        "bbox_wh": [int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)],
    }


def centerline(mask: np.ndarray, y0: int, y1: int, step: int) -> list[dict]:
    """在 y0..y1 行带内，按列取掩码的垂直中心与粗细 —— 用来读描边中心线。

    返回每 step 列一个采样点：x、上下沿、中心 y、垂直厚度。
    """
    out: list[dict] = []
    for x in range(0, mask.shape[1], step):
        col = np.where(mask[y0:y1, x])[0]
        if col.size == 0:
            continue
        top, bot = int(col.min()) + y0, int(col.max()) + y0
        out.append({"x": int(x), "top": top, "bottom": bot, "cy": round((top + bot) / 2, 2), "thick": bot - top + 1})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Phase 1 raster logo analysis.")
    ap.add_argument("src", type=Path)
    ap.add_argument("--json", type=Path, default=None, help="把报告写成 JSON")
    ap.add_argument("--step", type=int, default=16, help="中心线采样步长（px）")
    args = ap.parse_args()

    img = Image.open(args.src)
    rgba = img.convert("RGBA")
    a = np.asarray(rgba).astype(int)
    H, W = a.shape[:2]
    alpha = a[..., 3]

    rep: dict = {"file": str(args.src).replace("\\", "/"), "size": [W, H], "mode": img.mode}

    # ---- 透明度 ----
    rep["alpha"] = {
        "min": int(alpha.min()),
        "max": int(alpha.max()),
        "opaque_pct": round(float((alpha >= 250).mean() * 100), 3),
        "transparent_pct": round(float((alpha <= 8).mean() * 100), 3),
    }
    vis = alpha > 8

    # ---- 亮度与色彩统计（只看可见像素）----
    lum = (0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2])
    vis_lum = lum[vis]
    rep["luminance"] = {
        "p50": round(float(np.percentile(vis_lum, 50)), 2),
        "p90": round(float(np.percentile(vis_lum, 90)), 2),
        "p99": round(float(np.percentile(vis_lum, 99)), 2),
        "max": round(float(vis_lum.max()), 2),
    }

    # ---- 按亮度分层，先看清「底 / 线 / 辉光」各占多少 ----
    bands = {
        "glow_dim(<40)": vis & (lum < 40),
        "tile(40-90)": vis & (lum >= 40) & (lum < 90),
        "glow_mid(90-170)": vis & (lum >= 90) & (lum < 170),
        "core(>=170)": vis & (lum >= 170),
    }
    rep["luminance_bands"] = {k: region_report(k, m) for k, m in bands.items()}

    # ---- 部件拆分：琥珀主波 / 冷色次级波 ----
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    amber = vis & (R > G) & (G > B) & (R - B > 60) & (lum > 90)          # 暖色高亮（主波 + 它的辉光）
    amber_core = vis & (R > G) & (G > B) & (R - B > 90) & (lum > 190)     # 主波线芯
    cool = vis & (B >= R) & (lum > 40) & (lum < 170)                     # 冷色次级波
    tile = vis & (R - B < 45) & (lum < 90)                               # 深色底片

    rep["parts"] = {
        "amber_bright": region_report("amber_bright", amber),
        "amber_core": region_report("amber_core", amber_core),
        "cool_secondary": region_report("cool_secondary", cool),
        "tile_dark": region_report("tile_dark", tile),
    }

    # ---- 取色 ----
    def mean_color(mask: np.ndarray, top_pct: float | None = None) -> list[int] | None:
        idx = np.where(mask)
        if idx[0].size == 0:
            return None
        vals = a[idx]
        if top_pct is not None:
            l = lum[idx]
            keep = l >= np.percentile(l, 100 - top_pct)
            vals = vals[keep]
        return [int(round(v)) for v in vals[:, :3].mean(axis=0)]

    rep["colors"] = {
        "amber_core_mean": mean_color(amber_core),
        "amber_core_brightest10pct": mean_color(amber_core, top_pct=10),
        "amber_all_mean": mean_color(amber),
        "cool_mean": mean_color(cool),
        "tile_mean": mean_color(tile),
        "tile_darkest10pct": mean_color(tile, top_pct=10),
    }

    # ---- 中心线采样（主波 / 次级波）----
    rep["amber_centerline"] = centerline(amber_core, 0, H, args.step)
    rep["cool_centerline"] = centerline(cool, 0, H, args.step)

    # ---- 圆角底片：按行/列读外沿，估算圆角半径 ----
    if tile.any():
        ys, xs = np.where(tile)
        x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
        inset_scan = []
        for k in (0, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64):
            row = tile[y0 + k, x0:x1 + 1]
            if row.any():
                inset_scan.append({"dy": k, "left_inset": int(np.argmax(row)), "right_inset": int(np.argmax(row[::-1]))})
        rep["tile_corner_scan"] = {
            "tile_bbox": [x0, y0, x1, y1],
            "tile_wh": [x1 - x0 + 1, y1 - y0 + 1],
            "insets_by_row": inset_scan,
        }

    print(json.dumps(rep, ensure_ascii=False, indent=2))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
