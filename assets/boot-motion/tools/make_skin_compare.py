#!/usr/bin/env python3
"""把深底 / 浅底的同刻帧拼成一张对照图（`outputs/skin_compare.png`）。

为什么要专门做一个工具，而不是当时用一次性命令拼一张：
  浅底那套配色不是"调出来的"，是**算出来的**（深底峰顶 #fbd77f 对浅底 #f2f3f5
  只有 1.25:1，会整条化掉）。既然是一份可复算的结论，它的证据图也应该可复算 ——
  一次性命令拼出来的图会随着版式和时间线的改动悄悄过期，
  而下一次改配色的人看到的是一张"看着没问题"的旧图，比没有图更坏。

输入来自 `verify_integration.mjs` 的产物，两边的采样时刻必须一致
（工具里深底走 `--times 0,900,2000`、浅底走 [900, 2000]），所以这里只做拼接。

用法：
  python tools/make_skin_compare.py --dir outputs/integration --out outputs/skin_compare.png
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# PIL 的默认位图字体只有 ASCII —— 直接 draw.text 中文会渲染成一串方框（tofu）。
# 本机的 微软雅黑 / 黑体 都是 .ttc（TrueType Collection），PIL 能直接吃，
# 但要在多个候选里挑第一个存在的，别写死一个可能不存在的路径。
FONT_CANDIDATES = (
    r"C:\Windows\Fonts\msyh.ttc",       # 微软雅黑
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\simhei.ttf",     # 黑体
    r"C:\Windows\Fonts\segoeui.ttf",    # 兜底：只有 ASCII 字形
)


def load_font(size: int):
    for p in FONT_CANDIDATES:
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()

# 深底 / 浅底要对照的时刻。必须两边都有对应的帧文件，缺一个就报错退出 ——
# 宁可红着，也不要拼一张缺了半边的图。
TIMES = (900, 2000)


def main() -> int:
    ap = argparse.ArgumentParser(description="深底 vs 浅底同刻帧对照")
    ap.add_argument("--dir", default="outputs/integration")
    ap.add_argument("--out", default="outputs/skin_compare.png")
    ap.add_argument("--cell", default="560x342", help="单格尺寸 WxH")
    args = ap.parse_args()

    d = Path(args.dir)
    cw, ch = (int(v) for v in args.cell.lower().split("x"))
    gap, label = 10, 24

    rows = len(TIMES)
    sheet = Image.new(
        "RGB", (2 * cw + gap * 3, rows * (ch + label + gap) + gap), (24, 26, 30)
    )
    dr = ImageDraw.Draw(sheet)
    font = load_font(15)

    for r, t in enumerate(TIMES):
        y = gap + r * (ch + label + gap)
        for c, (prefix, caption) in enumerate((("app", "深底 · 品牌琥珀"), ("app_light", "浅底 · 压明度琥珀"))):
            p = d / f"{prefix}_{t:04d}.png"
            if not p.is_file():
                raise SystemExit(f"缺帧：{p}（先跑 tools/verify_integration.mjs）")
            x = gap + c * (cw + gap)
            sheet.paste(Image.open(p).convert("RGB").resize((cw, ch), Image.LANCZOS), (x, y))
            dr.rectangle([x, y, x + cw - 1, y + ch - 1], outline=(70, 76, 86))
            dr.text((x + 4, y + ch + 6), f"{caption} · t = {t} ms", fill=(176, 184, 194), font=font)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out)
    print(f"对照图 -> {out}  ({sheet.width}×{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
