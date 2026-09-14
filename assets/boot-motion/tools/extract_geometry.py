#!/usr/bin/env python3
"""Phase 1 几何提取：把 logo 的部件几何量成可直接写进 SVG 的数字。

输出三部分：
  1. 底片（圆角方）—— 由 alpha 通道定 bbox 与圆角半径
  2. 琥珀主波 —— 按列扫 min/max y，给出平段/峰/谷的关键 x 与控制点
  3. 次级暗波 —— 低对比度，用「非暖色且比底片亮」的判据分离

用法：
  python extract_geometry.py "D:/NetPeek/图标.png" --json outputs/geometry.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image


def runs_in_column(mask: np.ndarray, x: int) -> list[tuple[int, int]]:
    """返回某一列里连续的 True 段 [(y0,y1), ...]（闭区间）。"""
    col = np.where(mask[:, x])[0]
    if col.size == 0:
        return []
    out, start, prev = [], col[0], col[0]
    for y in col[1:]:
        if y != prev + 1:
            out.append((int(start), int(prev)))
            start = y
        prev = y
    out.append((int(start), int(prev)))
    return out


def col_profile(mask: np.ndarray, step: int) -> list[dict]:
    out = []
    for x in range(0, mask.shape[1], step):
        rs = runs_in_column(mask, x)
        if not rs:
            continue
        top, bot = rs[0][0], rs[-1][1]
        out.append({
            "x": int(x),
            "top": top,
            "bot": bot,
            "cy": round((top + bot) / 2, 1),
            "n_runs": len(rs),
            "runs": rs if len(rs) > 1 else None,
        })
    return out


def tile_from_alpha(a: np.ndarray) -> dict:
    solid = a[..., 3] > 128
    ys, xs = np.where(solid)
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    # 逐行读左沿，圆角处左沿会内缩；内缩收敛到 0 的行距顶部的距离 ≈ 半径
    insets = []
    for k in range(0, min(240, y1 - y0)):
        row = np.where(solid[y0 + k, x0:x1 + 1])[0]
        insets.append(int(row.min()) if row.size else -1)
    radius = None
    for k, ins in enumerate(insets):
        if ins <= 0:
            radius = k
            break
    return {
        "bbox": [x0, y0, x1, y1],
        "wh": [x1 - x0 + 1, y1 - y0 + 1],
        "corner_radius_px": radius,
        "top_left_insets": insets[:60],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("--json", type=Path, default=None)
    ap.add_argument("--step", type=int, default=4)
    args = ap.parse_args()

    a = np.asarray(Image.open(args.src).convert("RGBA")).astype(int)
    R, G, B, A = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    lum = 0.2126 * R + 0.7152 * G + 0.0722 * B

    rep: dict = {"file": str(args.src).replace("\\", "/"), "size": [a.shape[1], a.shape[0]]}
    rep["tile"] = tile_from_alpha(a)

    warm = (A > 100) & (R - B > 70) & (lum > 120)
    rep["warm_profile"] = col_profile(warm, args.step)

    # 次级暗波：比底片亮、且不暖（B 不低于 R 太多）
    t = rep["tile"]["bbox"]
    slate = (A > 200) & (lum > 34) & (lum < 95) & (B >= R - 3)
    band = np.zeros_like(slate)
    band[t[1] + int((t[3] - t[1]) * 0.5):t[3], t[0]:t[2]] = True
    rep["slate_profile"] = col_profile(slate & band, args.step)

    # 描边宽度：取两侧平段的「无多段命中」列的垂直厚度中位数
    def stroke_width(prof: list[dict], x_lo: int, x_hi: int) -> float:
        vals = [p["bot"] - p["top"] + 1 for p in prof if x_lo <= p["x"] <= x_hi and p["n_runs"] == 1]
        return round(float(np.median(vals)), 1) if vals else -1.0

    wp = rep["warm_profile"]
    if wp:
        xs = [p["x"] for p in wp]
        rep["warm_stroke_px"] = stroke_width(wp, min(xs) + 40, min(xs) + 200)
    sp = rep["slate_profile"]
    if sp:
        xs = [p["x"] for p in sp]
        rep["slate_stroke_px"] = stroke_width(sp, min(xs) + 20, min(xs) + 120)

    print(json.dumps({k: v for k, v in rep.items() if not k.endswith("_profile")}, ensure_ascii=False, indent=2))

    for name in ("warm_profile", "slate_profile"):
        prof = rep[name]
        print(f"\n=== {name} (每 {args.step}px 一列，共 {len(prof)}) ===")
        if not prof:
            print("  (空)")
            continue
        print(f"  x 范围 {prof[0]['x']}..{prof[-1]['x']}")
        for p in prof:
            flag = " <== 多段" if p["n_runs"] > 1 else ""
            print(f"  x={p['x']:>4} top={p['top']:>4} bot={p['bot']:>4} cy={p['cy']:>7.1f} runs={p['n_runs']}{flag}")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
