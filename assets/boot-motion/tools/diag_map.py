#!/usr/bin/env python3
"""Phase 1 诊断：ASCII 部件图 + 定向采样 + 宽松掩码中心线。

用途是"看清"而不是"定量结论"——先用粗网格把部件分布画出来，
再对关键行/列做定向采样，避免在阈值上瞎猜。

用法：
  python diag_map.py "D:/NetPeek/图标.png" --block 20
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
from PIL import Image


def classify(a: np.ndarray) -> np.ndarray:
    """给每个像素打一个粗分类标签（0=透明 1=底 2=暖线 3=冷线 4=其它）。"""
    alpha = a[..., 3]
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.2126 * R + 0.7152 * G + 0.0722 * B
    lab = np.zeros(R.shape, dtype=np.uint8)
    vis = alpha > 40
    lab[vis] = 1                                    # 可见但非线：底片/辉光
    lab[vis & (R - B > 50) & (lum > 110)] = 2       # 暖色线（主波，含亮辉光）
    lab[vis & (B - R > 10) & (lum > 55) & (lum < 200)] = 3   # 冷色线（次级波）
    return lab


GLYPH = {0: ".", 1: "-", 2: "W", 3: "c", 4: "?"}


def ascii_map(lab: np.ndarray, block: int) -> list[str]:
    H, W = lab.shape
    rows = []
    for y in range(0, H, block):
        line = []
        for x in range(0, W, block):
            blk = lab[y:y + block, x:x + block]
            # 取「最有信息量」的类别：W > c > - > .
            for want in (2, 3, 1, 0):
                if (blk == want).any():
                    line.append(GLYPH[want])
                    break
        rows.append(f"{y:>4} |" + "".join(line))
    return rows


def centerline_of(lab: np.ndarray, want: int, step: int, y0: int = 0, y1: int | None = None) -> list[tuple]:
    y1 = lab.shape[0] if y1 is None else y1
    out = []
    for x in range(0, lab.shape[1], step):
        col = np.where(lab[y0:y1, x] == want)[0]
        if col.size == 0:
            continue
        out.append((int(x), int(col.min()) + y0, int(col.max()) + y0, int(col.size)))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src", type=Path)
    ap.add_argument("--block", type=int, default=20)
    ap.add_argument("--step", type=int, default=8)
    args = ap.parse_args()

    a = np.asarray(Image.open(args.src).convert("RGBA")).astype(int)
    lab = classify(a)

    print(f"图幅 {a.shape[1]}x{a.shape[0]}  块={args.block}px  图例: W=暖线  c=冷线  -=底片  .=透明")
    print("     +" + "-" * (a.shape[1] // args.block))
    for r in ascii_map(lab, args.block):
        print(r)

    print("\n=== 定向采样（像素原值）===")
    probes = [(626, 160), (626, 460), (626, 530), (626, 620),
              (250, 530), (1000, 530), (626, 802), (400, 802), (870, 802),
              (150, 630), (1104, 630), (626, 1110)]
    for x, y in probes:
        px = a[y, x]
        print(f"  ({x:>4},{y:>4}) RGBA=({px[0]:>3},{px[1]:>3},{px[2]:>3},{px[3]:>3})")

    print("\n=== 暖线（主波）中心线，step=%d ===" % args.step)
    cl = centerline_of(lab, 2, args.step)
    print(f"  命中列数={len(cl)}  x 范围={cl[0][0] if cl else '-'}..{cl[-1][0] if cl else '-'}")
    for i in range(0, len(cl), 6):
        x, top, bot, n = cl[i]
        print(f"   x={x:>4}  top={top:>4} bot={bot:>4} cy={(top+bot)/2:>7.1f} thick={bot-top+1:>3} n={n}")

    print("\n=== 冷线（次级波）中心线，step=%d ===" % args.step)
    cc = centerline_of(lab, 3, args.step)
    print(f"  命中列数={len(cc)}  x 范围={cc[0][0] if cc else '-'}..{cc[-1][0] if cc else '-'}")
    for i in range(0, len(cc), 6):
        x, top, bot, n = cc[i]
        print(f"   x={x:>4}  top={top:>4} bot={bot:>4} cy={(top+bot)/2:>7.1f} thick={bot-top+1:>3} n={n}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
