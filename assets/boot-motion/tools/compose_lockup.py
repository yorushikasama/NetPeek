#!/usr/bin/env python3
"""合成启动动效的锁定版式（lockup）：两条波形线 + "NetPeek" 字标。

为什么要用脚本算版式，而不是手填 translate/scale：
  1. 波形的 d 是 fit_centerline.py 拟合出来的，随时可能因为重拟合而变；
     手算的 scale 会立刻失效，而且失效方式是「看起来还行但差几像素」——最难发现的那种。
     从 d 真算包围盒，重拟合后重跑一次就自动对齐。
  2. 字标的定位必须按**墨迹**（ink）而不是基线/CapHeight：
     't' 的上升部到 92.5、'k' 到 105.7（CapHeight=100 基准），拿 CapHeight 当顶边
     会让整行字标往下掉约 6% 的字高。BoundsPen 给的是真墨迹盒，直接用它算。
  3. 版式里每个数字（间距、缩放、擦除矩形的起止）最后都要写进动效，
     集中算一次并落盘成 lockup.json，读代码时不用反推。

坐标约定：
  输出全部在**屏幕坐标**（SVG viewBox 空间，y 向下、原点左上）。
  字标仍以 font units 存放（y 向上），由 `scale(S,-S)` 容器翻转——
  翻转只发生一次，且只在这一层，便于核对。

产物：
  outputs/lockup.json   全部版式数字（供 QA / 文档引用）
  outputs/lockup.frag   <style>变量 + <defs> + 标记组 + 字标组（屏幕坐标，可直接放进 SVG）
  并把 frag 注入 logo_motion.html 的 <!-- @lockup:start --> … <!-- @lockup:end --> 之间
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# ---------------------------------------------------------------- 版式常量
# 画布 = 应用主窗口尺寸（src-tauri/tauri.conf.json: width/height）。
VIEW_W = 1180.0
VIEW_H = 720.0

# 版式只由 MARK_W 一个数决定，其余按比例派生 —— 改大小只动这一行。
#
# 为什么从 560 收到 400：560 时波形占窗口宽 47%，加上字标后整块的横向跨度是
# 1142/1180 = 97%，左右各只剩 19px。那不是「居中放着一个标记」，是「把整行铺满」，
# 读起来像页眉而不像启动页的 logo。400 → 34% 宽，整块跨度 816/1180 = 69%，
# 左右各留 182px，标记才立得住、四周才有呼吸。
MARK_W = 400.0
# 字标略窄于标记是横向 lockup 的常规平衡（原稿 504/560 = 0.90）。
WORD_RATIO = 0.90
# 间距 / 标记宽。原稿 78/560 = 0.139 —— 间距必须跟着标记一起缩，
# 否则标记变小、间距不变，两者会读成「离得很远的两个东西」而不是一个 lockup。
GAP_RATIO = 0.14

WORD_INK_W = MARK_W * WORD_RATIO
GAP = MARK_W * GAP_RATIO

# 擦除揭示用的裁剪矩形在字标四周留的余量（只用于覆盖完整，不参与视觉）
CLIP_PAD_Y = 14.0

# ---------------------------------------------------------------- 路径几何


TOKEN = re.compile(r"([MLQCZmlqcz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)")


def _parse(d: str):
    """把 path 数据拆成 (cmd, [nums...]) 序列。只实现 M/L/Q/C/Z（拟合器只会产出这些）。"""
    out = []
    cmd = None
    nums: list[float] = []
    for m in TOKEN.finditer(d):
        if m.group(1):
            if cmd:
                out.append((cmd, nums))
            cmd, nums = m.group(1), []
        else:
            nums.append(float(m.group(2)))
    if cmd:
        out.append((cmd, nums))
    return out


def _quad_at(p0, p1, p2, t):
    u = 1.0 - t
    return tuple(u * u * a + 2 * u * t * b + t * t * c for a, b, c in zip(p0, p1, p2))


def _quad_extrema(a, b, c):
    """二次 Bézier 在某轴上的内点极值参数 t（0<t<1）。"""
    den = a - 2 * b + c
    if abs(den) < 1e-12:
        return []
    t = (a - b) / den
    return [t] if 0.0 < t < 1.0 else []


def path_bbox(d: str) -> tuple[float, float, float, float]:
    """中心线包围盒。二次段按真极值算，不用控制点近似——
    圆角处的控制点一定在弧外侧，用控制点算会让包围盒虚胖十几个单位。"""
    xs: list[float] = []
    ys: list[float] = []
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    for cmd, n in _parse(d):
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            for i in range(0, len(n), 2):
                p = (n[i], n[i + 1])
                if rel:
                    p = (p[0] + cur[0], p[1] + cur[1])
                cur = p
                start = p
                xs.append(p[0])
                ys.append(p[1])
        elif c == "L":
            for i in range(0, len(n), 2):
                p = (n[i], n[i + 1])
                if rel:
                    p = (p[0] + cur[0], p[1] + cur[1])
                cur = p
                xs.append(p[0])
                ys.append(p[1])
        elif c == "Q":
            for i in range(0, len(n), 4):
                p1 = (n[i], n[i + 1])
                p2 = (n[i + 2], n[i + 3])
                if rel:
                    p1 = (p1[0] + cur[0], p1[1] + cur[1])
                    p2 = (p2[0] + cur[0], p2[1] + cur[1])
                p0 = cur
                xs += [p0[0], p2[0]]
                ys += [p0[1], p2[1]]
                for t in _quad_extrema(p0[0], p1[0], p2[0]):
                    xs.append(_quad_at(p0, p1, p2, t)[0])
                for t in _quad_extrema(p0[1], p1[1], p2[1]):
                    ys.append(_quad_at(p0, p1, p2, t)[1])
                cur = p2
        elif c == "C":
            # 拟合器不产三次段；真遇上就退化用控制点包络（偏保守，不会算小）
            for i in range(0, len(n), 6):
                pts = [(n[i + j], n[i + j + 1]) for j in range(0, 6, 2)]
                if rel:
                    pts = [(p[0] + cur[0], p[1] + cur[1]) for p in pts]
                xs += [p[0] for p in pts]
                ys += [p[1] for p in pts]
                cur = pts[-1]
        elif c == "Z":
            cur = start
    if not xs:
        raise ValueError("空路径")
    return min(xs), min(ys), max(xs), max(ys)


def expand(box, half_stroke):
    """中心线盒 → 墨迹盒（round cap/join 就是各方向外扩半个描边宽）。"""
    x0, y0, x1, y1 = box
    return x0 - half_stroke, y0 - half_stroke, x1 + half_stroke, y1 + half_stroke


def union(a, b):
    return min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])


# ---------------------------------------------------------------- 读源资产


ATTR_RE = re.compile(r'([\w:-]+)\s*=\s*"([^"]*)"')


def read_logo(svg_path: Path) -> dict:
    """从 logo.svg 里取出三条路径的 d 与描边宽。

    直接抠字符串是有意为之：logo.svg 是**唯一真源**（人也能手改、也能单独预览），
    再引入一层 SVG 解析依赖只为读三个属性不划算。
    """
    raw = svg_path.read_text(encoding="utf-8")
    out: dict[str, dict] = {}
    # 把每个 path 标签整段切出来，再逐个抠属性。
    # 千万别用 re.search(r'd="([^"]+)"') 直接在整段标签里找 —— `id="pulse-line"` 里
    # 的 `d="pulse-line"` 会先被匹配上（踩过，d 变成 "pulse-line"）。
    for tag in re.findall(r"<path\b[^>]*>", raw, flags=re.S):
        attrs = dict(ATTR_RE.findall(tag))
        pid = attrs.get("id")
        d = attrs.get("d")
        if not pid or not d:
            continue
        out[pid] = {
            "d": re.sub(r"\s+", " ", d).strip(),
            "stroke_width": float(attrs.get("stroke-width", 1.0)),
        }
    missing = {"pulse-line", "pulse-echo", "pulse-glow"} - out.keys()
    if missing:
        raise SystemExit(f"logo.svg 缺少路径：{sorted(missing)}")
    return out


def read_wordmark(json_path: Path) -> dict:
    return json.loads(json_path.read_text(encoding="utf-8"))


def wordmark_ink(data: dict) -> tuple[float, float, float, float]:
    """字标墨迹盒（font units，y 向上）。用逐字形真包围盒 + 各自 x 偏移。"""
    boxes = []
    for g in data["glyphs"]:
        b = g.get("bounds")
        if not b:
            continue
        boxes.append((g["x"] + b[0], b[1], g["x"] + b[2], b[3]))
    if not boxes:
        raise SystemExit("字标没有任何带墨迹的字形")
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


# ---------------------------------------------------------------- 合成


def compose(logo: dict, wm: dict) -> tuple[dict, str]:
    cx = VIEW_W / 2.0

    # --- 波形：先算三条路径合起来的墨迹盒，再一次性缩放平移 ---
    marks = {}
    box = None
    for pid, p in logo.items():
        b = expand(path_bbox(p["d"]), p["stroke_width"] / 2.0)
        marks[pid] = {"bbox": [round(v, 3) for v in b]}
        box = b if box is None else union(box, b)

    # 辉光只用于外发光，不该参与版式——按它算会让标记整体缩小并偏上
    layout_box = union(
        expand(path_bbox(logo["pulse-line"]["d"]), logo["pulse-line"]["stroke_width"] / 2.0),
        expand(path_bbox(logo["pulse-echo"]["d"]), logo["pulse-echo"]["stroke_width"] / 2.0),
    )
    bx0, by0, bx1, by1 = layout_box
    bw, bh = bx1 - bx0, by1 - by0

    m_scale = MARK_W / bw
    mark_h = bh * m_scale

    # --- 字标：按墨迹对齐 ---
    ix0, iy0, ix1, iy1 = wordmark_ink(wm)
    iw, ih = ix1 - ix0, iy1 - iy0
    w_scale = WORD_INK_W / iw
    word_h = ih * w_scale

    # --- 整块垂直居中：先求出整块高度，再反推顶边 ---
    # 原来是硬编码 MARK_TOP = 117，整块 117→574.2 落在 720 里是「上 117、下 145.8」，
    # 比真居中高了 14.4px。这点偏差肉眼看不出来，但真正的问题是「居中」这件事
    # 在代码里**根本没有表达** —— 尺度一动（比如这次从 560 收到 400）就必然更偏，
    # 而且偏了没有任何东西会报错。改成从画布高度反推之后，改 MARK_W 居中自动保持。
    block_h = mark_h + GAP + word_h
    mark_top = (VIEW_H - block_h) / 2.0

    m_tx = cx - MARK_W / 2.0 - bx0 * m_scale
    m_ty = mark_top - by0 * m_scale
    mark_bottom = mark_top + mark_h

    word_top = mark_bottom + GAP
    word_bottom = word_top + word_h
    w_tx = cx - WORD_INK_W / 2.0 - ix0 * w_scale
    # scale(S,-S)：font 点 y 映到 ty - y*S，所以墨迹顶边 iy1 落在 word_top
    w_ty = word_top + iy1 * w_scale

    block_top = mark_top
    block_bottom = word_bottom

    nums = {
        "view": [VIEW_W, VIEW_H],
        "centerX": cx,
        "mark": {
            "layout_bbox_src": [round(v, 3) for v in layout_box],
            "all_bbox_src_with_glow": [round(v, 3) for v in box],
            "path_bboxes_src": {k: v["bbox"] for k, v in marks.items()},
            "scale": round(m_scale, 6),
            "draw_scale": round(m_scale, 6),
            "translate": [round(m_tx, 3), round(m_ty, 3)],
            "ink_w": round(MARK_W, 3),
            "ink_h": round(mark_h, 3),
            "top": round(mark_top, 3),
            "bottom": round(mark_bottom, 3),
            "aspect": round(MARK_W / mark_h, 4),
        },
        "wordmark": {
            "ink_src": [round(v, 1) for v in (ix0, iy0, ix1, iy1)],
            "ink_w_src": round(iw, 1),
            "ink_h_src": round(ih, 1),
            "scale": round(w_scale, 8),
            "translate": [round(w_tx, 4), round(w_ty, 4)],
            "ink_w": round(WORD_INK_W, 3),
            "ink_h": round(ih * w_scale, 3),
            "cap_height": round(wm["cap_height"] * w_scale, 3),
            "cap100_of_ink_w": round(100.0 * w_scale * wm["units_per_em"] / iw, 3),
            "top": round(word_top, 3),
            "baseline": round(w_ty, 3),
            "bottom": round(word_bottom, 3),
            "advance_w": round(wm["total_advance"] * w_scale, 3),
            "glyphs": [
                {
                    "char": g["char"],
                    "x": g["x"],
                    "advance": g["advance"],
                }
                for g in wm["glyphs"]
            ],
        },
        "gap": GAP,
        "block": {
            "top": round(block_top, 3),
            "bottom": round(block_bottom, 3),
            "h": round(block_h, 3),
            "margin_top": round(block_top, 3),
            "margin_bottom": round(VIEW_H - block_bottom, 3),
            # 左右边距。lockup 是**上下堆叠**（波形在上、字标在下），所以整块宽度
            # 就是 MARK_W —— 字标 360 比它窄，左右那 20px 是字标自己的边距。
            "margin_x": round(cx - MARK_W / 2.0, 3),
        },
        "wipe": {
            "x": round(cx - WORD_INK_W / 2.0 - 1.0, 3),
            "y": round(word_top - CLIP_PAD_Y, 3),
            "w": round(WORD_INK_W + 2.0, 3),
            "h": round(ih * w_scale + CLIP_PAD_Y * 2.0, 3),
            "distance": round(WORD_INK_W + 2.0, 3),
        },
        "source": {
            "logo": "assets/boot-motion/logo.svg",
            "wordmark_font": wm["font"],
            "wordmark_family": wm["font_family"],
            "wordmark_version": wm["font_version"],
            "wordmark_units_per_em": wm["units_per_em"],
        },
    }

    frag = render_frag(logo, nums, wm)
    return nums, frag


# ---------------------------------------------------------------- 输出


def render_frag(logo: dict, n: dict, wm: dict) -> str:
    """产出可整段塞进 SVG 的片段：变量 + defs + 标记 + 字标。坐标已是屏幕空间。"""
    m = n["mark"]
    w = n["wordmark"]
    wipe = n["wipe"]
    mt = m["translate"]
    wt = w["translate"]

    def path_tag(pid: str, indent: str = "  ", extra: str = "") -> str:
        p = logo[pid]
        sw = p["stroke_width"]
        sw_s = f"{sw:g}"
        # d 单独成行：它有一两百字符，跟属性挤一行会让 diff 变成一整块
        head = f'{indent}<path id="{pid}" pathLength="1"'
        mid = f'{indent}      fill="none" stroke-width="{sw_s}"'
        tail = f' stroke-linecap="round" stroke-linejoin="round"'
        if extra:
            tail += f'\n{indent}      {extra}'
        return f'{head}\n{indent}      d="{p["d"]}"\n{mid}{tail}/>'

    glyph_tags = [
        f'<path class="np-wm-glyph" data-char="{g["char"]}"'
        f' transform="translate({g["x"]},0)" d="{g["d"]}"/>'
        for g in wm["glyphs"]
        if g["d"]
    ]

    L: list[str] = []

    L.append('<style id="np-lockup-vars">')
    L.append('  /* 由 tools/compose_lockup.py 生成，勿手改——改版式常量后重跑脚本 */')
    L.append('  #np-lockup {')
    L.append(f'    --np-word-x: {wipe["x"]}px;        /* 字标裁剪矩形左边界（屏幕坐标） */')
    L.append(f'    --np-word-w: {wipe["w"]}px;        /* 裁剪矩形宽 */')
    L.append(f'    --np-word-wipe: {wipe["distance"]}px;    /* 擦除推移距离 = 裁剪矩形宽 */')
    L.append(f'    --np-mark-h: {m["ink_h"]}px;')
    L.append(f'    --np-block-h: {n["block"]["h"]}px;')
    L.append('  }')
    L.append('</style>')

    L.append('')
    L.append('<defs>')
    L.append('  <!-- 主波沿路径渐变：两端偏橘、峰顶最亮（源图线芯实测 #F49D49 → #FBD77F → #F0A14A）。')
    L.append('       stop-color 走 CSS 变量，换配色只改外层变量，几何不受影响。')
    L.append('       x1/x2 是**源图坐标**（237..1013）——渐变挂在标记组内，跟着同一个 scale 走。 -->')
    L.append('  <linearGradient id="np-g-main" gradientUnits="userSpaceOnUse"')
    L.append('                  x1="237" y1="0" x2="1013" y2="0">')
    L.append('    <stop offset="0"   style="stop-color: var(--np-main-a)"/>')
    L.append('    <stop offset="0.5" style="stop-color: var(--np-main-b)"/>')
    L.append('    <stop offset="1"   style="stop-color: var(--np-main-c)"/>')
    L.append('  </linearGradient>')
    L.append('')
    L.append('  <!-- 外发光：主波的加宽模糊复制。它是伴生部件，动效上滞后主波 140ms。')
    L.append('       模糊半径 11 是**源图坐标**，随标记语系一起缩放（标记 400 宽时屏幕上约 5.5px）。 -->')
    L.append('  <filter id="np-bloom" x="-30%" y="-30%" width="160%" height="160%"')
    L.append('          color-interpolation-filters="sRGB">')
    L.append('    <feGaussianBlur stdDeviation="11"/>')
    L.append('  </filter>')
    L.append('')
    L.append('  <!-- 字标擦除揭示：让裁剪矩形自己左移一段，而不是动它的 width。')
    L.append('       动 SVG 几何属性（x/y/width/height）各引擎支持度不一，动 transform 处处都稳。 -->')
    L.append('  <clipPath id="np-word-clip" clipPathUnits="userSpaceOnUse">')
    L.append(f'    <rect id="np-word-clip-rect" x="{wipe["x"]}" y="{wipe["y"]}"')
    L.append(f'          width="{wipe["w"]}" height="{wipe["h"]}"/>')
    L.append('  </clipPath>')
    L.append('</defs>')

    L.append('')
    L.append('<!-- ================= 标记：两条波形线 =================')
    L.append('     版式由 compose_lockup.py 从路径 d 真算，不是手凑的：')
    L.append(f'     源墨迹盒 {m["layout_bbox_src"]} → ×{m["scale"]} → 屏幕 {m["ink_w"]}×{m["ink_h"]}')
    L.append(f'     定位 translate({mt[0]}, {mt[1]})，墨迹顶边 y={m["top"]}')
    L.append('     注意：外发光路径**不参与**上面这个盒——拿发光算会让标记整体缩小并偏上。 -->')
    L.append(f'<g id="np-mark" transform="translate({mt[0]},{mt[1]}) scale({m["scale"]})">')
    # 只留 class，不留同名 id：时间线（boot.css 的 .np-glow-wrap）按 class 挂动画，
    # 一个元素两个寻址方式只会让「谁在引用它」说不清。
    L.append('  <g class="np-glow-wrap">')
    L.append(path_tag("pulse-glow", "    ", 'filter="url(#np-bloom)"'))
    L.append('  </g>')
    L.append(path_tag("pulse-line"))
    L.append(path_tag("pulse-echo"))
    L.append('</g>')

    L.append('')
    L.append(f'<!-- ================= 字标：NetPeek =================')
    L.append(f'     字形取 {wm["font_family"]} {wm["font_version"]}（seguisb.ttf）矢量描边。')
    L.append('     为什么不直接写 <text>：动效资产必须确定性，<text> 的最终宽度取决于渲染机装了什么字体；')
    L.append('     而且逐字形元素才能做揭示动效。')
    L.append('')
    L.append('     坐标系仍是 font units 且 **y 向上**；翻转与缩放只发生在下面这一层，')
    L.append('     再往里就都是 TrueType 原生方向了。')
    L.append(f'     墨迹盒 {w["ink_src"]} → ×{w["scale"]} → 屏幕 {w["ink_w"]}×{w["ink_h"]}')
    L.append(f'     （CapHeight 折算 {w["cap_height"]}px；注意它 < 墨迹高 {w["ink_h"]}px，')
    L.append('      因为 k 的上升部比 CapHeight 还高 5.7%，e 的弧底还往下溢 1.7%）')
    L.append(f'     墨迹顶边 y={w["top"]}，基线 y={w["baseline"]}，墨迹底边 y={w["bottom"]} -->')
    L.append('<g clip-path="url(#np-word-clip)">')
    L.append(f'  <g id="np-wordmark" transform="translate({wt[0]},{wt[1]}) scale({w["scale"]},{-w["scale"]})">')
    L.extend('    ' + t for t in glyph_tags)
    L.append('  </g>')
    L.append('</g>')
    L.append('')

    return "\n".join(L)


START = "<!-- @lockup:start -->"
END = "<!-- @lockup:end -->"


def inject(html_path: Path, frag: str) -> bool:
    """把片段写进 <!-- @lockup:start --> 与 <!-- @lockup:end --> 之间。

    为什么是「注入两个文件」而不是「注入一份、另一份引用它」：
      应用侧是纯静态前端（frontendDist 指到 ui/），没有模板/构建步骤，
      外面的 assets/ 也不会被打进安装包 —— 想共用就必须各自带一份真的 SVG。
      所以让生成器同时写两处，而不是让人手工同步：
      波形一旦重拟合，两处一起更新，不存在「审阅页是对的、应用里是旧的」。

    幂等：标记之间的内容整段替换，重复跑不会累积。"""
    if not html_path.is_file():
        return False
    raw = html_path.read_text(encoding="utf-8")
    i, j = raw.find(START), raw.find(END)
    if i < 0 or j < 0:
        return False
    new = raw[: i + len(START)] + "\n" + frag + raw[j:]
    if new == raw:
        return True
    html_path.write_text(new, encoding="utf-8")
    return True


def main() -> int:
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description="合成波形 + 字标的锁定版式")
    ap.add_argument("--logo", default=str(here / "logo.svg"))
    ap.add_argument("--wordmark", default=str(here / "outputs" / "wordmark_seguisb.json"))
    ap.add_argument("--json", default=str(here / "outputs" / "lockup.json"))
    ap.add_argument("--frag", default=str(here / "outputs" / "lockup.frag"))
    ap.add_argument("--html", action="append", default=None,
                    help="注入目标（可重复）。默认：审阅页 logo_motion.html + 应用 ui/index.html")
    args = ap.parse_args()

    targets = args.html or [
        str(here / "logo_motion.html"),
        str(here.parent.parent / "src" / "NetPeek.App" / "ui" / "index.html"),
    ]

    logo = read_logo(Path(args.logo))
    wm = read_wordmark(Path(args.wordmark))
    nums, frag = compose(logo, wm)

    jp = Path(args.json)
    jp.parent.mkdir(parents=True, exist_ok=True)
    jp.write_text(json.dumps(nums, ensure_ascii=False, indent=2), encoding="utf-8")

    fp = Path(args.frag)
    fp.write_text(frag, encoding="utf-8")

    m, w, b = nums["mark"], nums["wordmark"], nums["block"]
    print(f"画布        : {nums['view'][0]:.0f} × {nums['view'][1]:.0f}")
    print(f"波形        : src {m['layout_bbox_src']}  ×{m['scale']:.6f}")
    print(f"              屏幕 {m['ink_w']:.1f} × {m['ink_h']:.1f}  (宽高比 {m['aspect']:.3f})")
    print(f"              顶边 y={m['top']:.1f}  底边 y={m['bottom']:.1f}")
    print(f"字标        : 墨迹 {w['ink_w']:.1f} × {w['ink_h']:.1f}  (CapHeight {w['cap_height']:.2f}px)")
    print(f"              顶边 y={w['top']:.1f}  基线 y={w['baseline']:.1f}  底边 y={w['bottom']:.1f}")
    print(f"间距        : {nums['gap']:.1f}")
    print(f"整块        : {b['top']:.1f} → {b['bottom']:.1f}  高 {b['h']:.1f}")
    print(f"边距        : 上 {b['margin_top']:.1f}  下 {b['margin_bottom']:.1f}  左右 {b['margin_x']:.1f}")
    print(f"字标/波形宽比: {w['ink_w'] / m['ink_w']:.4f}")
    print()
    print(f"版式数字 -> {jp}")
    print(f"片段     -> {fp}")

    for t in targets:
        p = Path(t)
        if inject(p, frag):
            print(f"已注入   -> {p}")
        else:
            print(f"跳过（无 @lockup 标记）-> {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
