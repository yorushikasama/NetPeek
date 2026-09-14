#!/usr/bin/env python3
"""把字标文本提取成 SVG 矢量描边（供启动动效使用）。

为什么不直接在 SVG 里写 <text>：
  1. 动效资产必须**确定性**——<text> 的最终字形取决于渲染机装了哪个字体，
     换机器/换语言包就可能变宽度甚至回退到别的字。描边是纯几何，永远一致。
  2. 逐字母动效（错峰入场、逐字揭示）需要每个字形是独立元素；
     <text> 做不到，除非再套一堆 <tspan> 且位置仍由字体引擎决定。
  3. 描边可以直接进 mask / clipPath 做「擦除式揭示」。

字体选用 Segoe UI —— 与 tokens.css 的 --font-ui 第一顺位一致，
所以启动动效里的字标与应用界面里的文字是同一套字形来源（品牌一致性）。

坐标系约定（关键，别改）：
  输出路径在 **font units**，y 向上（TrueType 原生）。
  外层容器负责 y 翻转与缩放：<g transform="translate(X,Y) scale(S,-S)">。
  这样每个字形的 path 数据保持干净，定位只靠 translate，便于人眼核对。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont


def load_kerning(font: TTFont) -> dict[tuple[str, str], int]:
    """读旧式 kern 表（若有）。GPOS 里的 kerning 更复杂，小字标不值得引入 shaping 引擎。"""
    pairs: dict[tuple[str, str], int] = {}
    kern = font.get("kern")
    if kern is None:
        return pairs
    for sub in kern.kernTables:
        if getattr(sub, "format", None) != 0:
            continue
        for (left, right), value in sub.kernTable.items():
            pairs[(left, right)] = pairs.get((left, right), 0) + value
    return pairs


def extract(font_path: Path, text: str) -> dict:
    font = TTFont(str(font_path), fontNumber=0, lazy=True)
    upem = font["head"].unitsPerEm
    cmap = font.getBestCmap()
    glyphset = font.getGlyphSet()
    hmtx = font["hmtx"]
    kern = load_kerning(font)

    os2 = font.get("OS/2")
    cap_height = getattr(os2, "sCapHeight", None) if os2 else None
    x_height = getattr(os2, "sxHeight", None) if os2 else None

    glyphs = []
    pen_x = 0
    prev: str | None = None
    for ch in text:
        code = ord(ch)
        if code not in cmap:
            raise SystemExit(f"字体缺少字形：{ch!r} (U+{code:04X})")
        gname = cmap[code]
        advance, _lsb = hmtx[gname]

        # 字偶距（kern）：只影响字距，不影响字形本身
        k = kern.get((prev, gname), 0) if prev else 0
        pen_x += k

        spen = SVGPathPen(glyphset)
        glyphset[gname].draw(spen)
        d = spen.getCommands()

        # 字形墨迹包围盒（精确到曲线极值，BoundsPen 会真算二次曲线的端点极值）。
        # 版式必须按墨迹对齐而不是基线：'t'/'k' 的上升部比 CapHeight 高，
        # 拿 CapHeight 当顶边会让字标整体偏下。
        bpen = BoundsPen(glyphset)
        glyphset[gname].draw(bpen)
        bb = bpen.bounds

        glyphs.append(
            {
                "char": ch,
                "glyph": gname,
                "x": pen_x,
                "advance": advance,
                "kern_before": k,
                "bounds": [round(v, 1) for v in bb] if bb else None,
                "d": d,
                "empty": d == "",
            }
        )
        pen_x += advance
        prev = gname

    total_advance = pen_x
    if cap_height is None or cap_height <= 0:
        raise SystemExit("字体未提供 sCapHeight，无法归一化基线高度")

    # 整体墨迹包围盒（含各字形的 x 偏移）
    boxes = [
        (g["x"] + g["bounds"][0], g["bounds"][1], g["x"] + g["bounds"][2], g["bounds"][3])
        for g in glyphs
        if g["bounds"]
    ]
    ink = None
    if boxes:
        ink = {
            "x_min": min(b[0] for b in boxes),
            "y_min": min(b[1] for b in boxes),
            "x_max": max(b[2] for b in boxes),
            "y_max": max(b[3] for b in boxes),
        }
        ink["w"] = ink["x_max"] - ink["x_min"]
        ink["h"] = ink["y_max"] - ink["y_min"]

    # 用 CapHeight = 100 归一化，让版式算术（字标高度 vs 波形高度）一眼可读
    scale = 100.0 / cap_height

    return {
        "font": font_path.name,
        "font_family": font["name"].getDebugName(1),
        "font_version": font["name"].getDebugName(5),
        "units_per_em": upem,
        "cap_height": cap_height,
        "x_height": x_height,
        "ascender": font["hhea"].ascender,
        "descender": font["hhea"].descender,
        "text": text,
        "total_advance": total_advance,
        "scale_for_cap100": scale,
        "width_cap100": round(total_advance * scale, 3),
        "x_advance_cap100": round((x_height or 0) * scale, 3),
        "glyphs": glyphs,
        "kerning_applied": {f"{a}/{b}": v for (a, b), v in kern.items()},
    }


def to_svg(group_id: str, data: dict, path_id_prefix: str, indent: str = "    ") -> str:
    """输出 <g id="..."> 片段。坐标仍为 font units + y 向上，由外层 scale(S,-S) 翻转。"""
    lines = [
        f'{indent}<g id="{group_id}">',
    ]
    for i, g in enumerate(data["glyphs"]):
        if g["empty"]:
            continue
        safe = f"{path_id_prefix}{i}-{g['glyph']}"
        lines.append(
            f'{indent}  <path id="{safe}" data-char="{g["char"]}" '
            f'transform="translate({g["x"]},0)" d="{g["d"]}"/>'
        )
    lines.append(f"{indent}</g>")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description="提取字标文本的 SVG 描边")
    ap.add_argument("--font", required=True, help="TTF/OTF 路径")
    ap.add_argument("--text", default="NetPeek", help="字标文本")
    ap.add_argument("--json", help="指标输出到 JSON")
    ap.add_argument("--svg", help="SVG 片段输出路径")
    ap.add_argument("--group-id", default="wordmark")
    ap.add_argument("--path-prefix", default="wm-")
    args = ap.parse_args()

    font_path = Path(args.font)
    if not font_path.is_file():
        raise SystemExit(f"字体不存在：{font_path}")

    data = extract(font_path, args.text)

    print(f"字体      : {data['font_family']} ({data['font']}, {data['font_version']})")
    print(f"units/em  : {data['units_per_em']}")
    print(f"CapHeight : {data['cap_height']} (x-height {data['x_height']})")
    print(f"文本      : {data['text']!r}")
    print(f"总宽度    : {data['total_advance']} units = {data['width_cap100']} (CapHeight=100 基准)")
    print(f"归一化系数: {data['scale_for_cap100']:.6f}")
    print()
    print("逐字形（CapHeight=100 基准下的 x / 宽度）：")
    s = data["scale_for_cap100"]
    for i, g in enumerate(data["glyphs"]):
        kern = f" kern={g['kern_before']:+d}" if g["kern_before"] else ""
        print(
            f"  {i} {g['char']!r:>4} glyph={g['glyph']:<8} "
            f"x={g['x']*s:8.2f}  adv={g['advance']*s:6.2f}  path={len(g['d']):>4} 字符{kern}"
        )
    print()
    print("命令数合计:", sum(g["d"].count("L") + g["d"].count("M") for g in data["glyphs"]))

    if args.json:
        out = Path(args.json)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n指标 -> {out}")

    if args.svg:
        out = Path(args.svg)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(to_svg(args.group_id, data, args.path_prefix), encoding="utf-8")
        print(f"片段 -> {out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
