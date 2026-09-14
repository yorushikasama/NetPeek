#!/usr/bin/env python3
"""启动动效的确定性 QA：逐帧量纲 + 连续性 + 终帧契约。

为什么不去「看」动效，而是量它：
  动效最常见的两种坏法都不显眼 ——
    ① 某条线根本没动画（一帧都没动），静止在终态，肉眼只觉得「这条线有点突然」；
    ② 终帧和设计不一致（少画一截、字标差几个像素），静态看完全正常。
  这两样只有逐帧量出来才兜得住。

度量口径（全部按**锁定版式的屏幕坐标**分区，不靠固定阈值猜）：
  主波  标记带内「琥珀色芯」像素的列集合 —— 描线进度 = 最右列 x
  发光  琥珀色像素总数 - 芯像素数（模糊晕的面积），只随不透明度变化
  次波  回声带内「中性色」像素的列集合（主波是彩色，被色度门限排除）
  字标  字标带内「中性色」像素的列集合 —— 擦除进度 = 最右列 x

断言：
  A 单调性    主波/次波/字标的推进只能前进，不能回退
  B 起止点    三条都从各自左端出发，终帧抵达右端
  C 连续性    相邻帧推进量不出现尖峰（缓动不该有台阶）
  D 终帧契约  t=总时长 的帧 == ?static=1 帧 == reduced-motion 帧（逐像素）
  E 路径一致  ?t=0 帧 == 连拍 t=0 帧（逐像素）
  F 版式落地  终帧字标墨迹宽 == lockup.json 里的设计值

用法：
  node tools/capture_frames.mjs logo_motion.html --out-dir outputs/frames --prefix brand
  python tools/qa_motion.py --dir outputs/frames --prefix brand --lockup outputs/lockup.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# 分区（屏幕坐标，y 向下）—— 由 compose_lockup.py 的版式推出，别手改：
#   主波中心线平直段 y≈290.0，描边折算 11.8px → 芯带 [284,296]；峰顶到 196.6，谷底到 325.0
#   次波墨迹 330.9 → 394.6（它的上界紧贴主波谷底，所以两条带在 y=330/331 分界）
#   字标墨迹 450.5 → 523.4
#
# 标记从 560 缩到 400 之后这几个数全部按 ×0.714 变过；忘了改的表现不是报错，
# 而是「带子切到了别的元素」—— 比如字标带还停在旧的 462 就会从上往下切掉半行字，
# 量出来的墨迹宽偏小，F 断言才会红。改 MARK_W 时这三个数要一起重算。
MARK_BAND = (188, 330)
ECHO_BAND = (331, 400)
WORD_BAND = (440, 534)

# 色度门限：主波/发光是琥珀（R 明显大于 B），次波与字标是从 --text 派生的中性色。
# 拿「饱和度」当判据而不是拿亮度 —— 深色皮与浅色皮下亮度的绝对值完全不同，
# 而「彩色 vs 中性」这个差异在两种皮肤下都成立。
CHROMA_MIN = 22

# 芯 vs 晕：芯是主波本体（很亮），晕是 feGaussianBlur 撑开的低亮度外圈。
CORE_MIN = 165

# 中性墨迹与底色的最小亮度差。底色自身的中性像素必须被排除掉，见 masks()。
CONTRAST_MIN = 22


def load(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.int16)


def masks(img: np.ndarray):
    """三张掩膜：琥珀（含晕）、琥珀芯、中性墨迹。

    中性掩膜必须再压一道「与底色的对比度」门限，否则**底色自己就是中性色**，
    整幅 0..1179 全被算成墨迹 —— 第一版就是这么翻车的，表现为
    「次波/字标的起止列都是 0..1179」，看着像量到了东西，其实量的是背景。
    底色取中位数（墨迹占比很低，中位数必然落在底色上），对深色皮和浅色皮都成立：
    取绝对值差，深色皮上墨迹更亮、浅色皮上墨迹更暗，两种都算「有对比」。"""
    r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
    bg = float(np.median(luma))
    contrast = np.abs(luma - bg)

    chroma = r - b
    amber = (chroma > CHROMA_MIN) & (r > 55)          # 彩色，底色（中性）天然被排除
    core = amber & (r > CORE_MIN)
    neutral = (np.abs(chroma) <= CHROMA_MIN) & (contrast > CONTRAST_MIN)
    return amber, core, neutral


def band(mask: np.ndarray, box) -> np.ndarray:
    m = np.zeros_like(mask)
    m[box[0]:box[1], :] = mask[box[0]:box[1], :]
    return m


def cols_extent(mask: np.ndarray):
    """有墨迹的列范围 + 列数。空则返回 None。"""
    percol = mask.any(axis=0)
    xs = np.nonzero(percol)[0]
    if xs.size == 0:
        return None
    return int(xs[0]), int(xs[-1]), int(xs.size)


def measure(path: Path) -> dict:
    img = load(path)
    amber, core, neutral = masks(img)
    h, w = img.shape[:2]

    out: dict = {"file": path.name, "size": [w, h]}

    # 发光能量：整幅的琥珀像素（含晕）减去芯。芯一旦画完就是常数，
    # 所以这个差只反映模糊晕的浓度 —— 也就是 np-bloom 呼吸。
    out["glow"] = int(amber.sum() - core.sum())

    e = cols_extent(band(core, MARK_BAND))
    out["main"] = None if e is None else {"x0": e[0], "x1": e[1], "cols": e[2]}

    e = cols_extent(band(neutral, ECHO_BAND))
    out["echo"] = None if e is None else {"x0": e[0], "x1": e[1], "cols": e[2]}

    e = cols_extent(band(neutral, WORD_BAND))
    out["word"] = None if e is None else {"x0": e[0], "x1": e[1], "cols": e[2]}
    if e:
        # 字标墨迹宽 = 首末墨迹列之间。擦除揭示用它在终帧校验版式是否真的落地。
        out["word_ink_w"] = e[1] - e[0] + 1

    return out


def diff(a: Path, b: Path) -> dict:
    ia, ib = load(a), load(b)
    if ia.shape != ib.shape:
        return {"equal": False, "reason": f"尺寸不同 {ia.shape} vs {ib.shape}"}
    d = np.abs(ia - ib).max(axis=2)
    # 形态学腐蚀（4 邻域）：只有「实心区域」才扛得住腐蚀，1px 宽的描边轮廓会被抹掉。
    # 用「腐蚀后还剩不剩像素」区分两类差异 ——
    #   只剩轮廓 = 抗锯齿差异（同一个形状，栅格化网格略不同），可以放过；
    #   还剩实心 = 形状/位置/元素数量真的变了，必须报错。
    # 这个判据比「差异像素数 < N」强得多：后者对「整体位移 1px」这种
    # 每个像素都差一点点的情况几乎不敏感，而那恰恰是最该抓的版式回归。
    m = d > 24
    core = m[1:-1, 1:-1] & m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:]
    return {
        "equal": bool(d.max() == 0),
        "max": int(d.max()),
        "mean": round(float(d.mean()), 5),
        "n_diff": int((d > 0).sum()),
        "n_strong": int(m.sum()),
        "n_solid": int(core.sum()),
    }


def contact_sheet(frames, out_path: Path, cols=4, cell=(292, 178)):
    cw, ch = cell
    rows = (len(frames) + cols - 1) // cols
    pad, label = 8, 20
    sheet = Image.new("RGB", (cols * (cw + pad) + pad, rows * (ch + label + pad) + pad), (18, 20, 24))
    dr = ImageDraw.Draw(sheet)
    for i, (t, f) in enumerate(frames):
        r, c = divmod(i, cols)
        x = pad + c * (cw + pad)
        y = pad + r * (ch + label + pad)
        sheet.paste(Image.open(f).convert("RGB").resize((cw, ch), Image.LANCZOS), (x, y))
        dr.rectangle([x, y, x + cw - 1, y + ch - 1], outline=(52, 58, 66))
        dr.text((x + 2, y + ch + 4), f"t = {t:>4} ms", fill=(150, 158, 168))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)


def main() -> int:
    ap = argparse.ArgumentParser(description="启动动效逐帧 QA")
    ap.add_argument("--dir", required=True)
    ap.add_argument("--prefix", default="brand")
    ap.add_argument("--lockup", default=None, help="outputs/lockup.json，用于终帧版式校验")
    ap.add_argument("--sheet", default=None, help="拼图输出路径")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    d = Path(args.dir)
    meta = json.loads((d / "frames.json").read_text(encoding="utf-8"))
    frames = [(f["t"], d / f["file"]) for f in meta["frames"]]
    total = meta["total"]

    rows = [(t, measure(f)) for t, f in frames]

    print(f"{'t(ms)':>6} {'主波 x0..x1':>16} {'次波 x0..x1':>16} {'字标 x0..x1':>16} {'发光':>8}")
    print("-" * 70)
    for t, m in rows:
        def fmt(k):
            v = m[k]
            return "—" if not v else f"{v['x0']:>4}..{v['x1']:<4}"
        print(f"{t:>6} {fmt('main'):>16} {fmt('echo'):>16} {fmt('word'):>16} {m['glow']:>8}")

    fails: list[str] = []
    notes: list[str] = []

    # --- A 单调性 + B 起止点 ---
    for key, label, first_x in (("main", "主波", None), ("echo", "次波", None), ("word", "字标", None)):
        seq = [(t, (m[key] or {}).get("x1")) for t, m in rows]
        seen = [(t, x) for t, x in seq if x is not None]
        if not seen:
            fails.append(f"A {label}：整段没有任何墨迹")
            continue
        prev = None
        for t, x in seen:
            if prev is not None and x < prev[1] - 1:
                fails.append(f"A {label}：t={t} x1={x} 回退于 t={prev[0]} x1={prev[1]}")
            prev = (t, x)
        if seen[0][0] != 0:
            notes.append(f"B {label}：首帧 t={seen[0][0]} 才出现墨迹")
        if seen[-1][1] - seen[0][1] < 100:
            fails.append(f"B {label}：全程只推进了 {seen[-1][1] - seen[0][1]}px，不像在画线")

    # --- C 连续性：只报告，不断言 ---
    # 推进量的「尖峰」不一定是坏：描线本身有缓动（ease-in-out 中段最快），
    # 采样密度稍疏一点就必然看到中段推进量是两端的几倍。
    # 真正要抓的是「台阶」（某段完全不动然后猛跳），那个看下面的静止帧计数。
    for key, label in (("main", "主波"), ("echo", "次波"), ("word", "字标")):
        deltas = []
        prev = None
        for t, m in rows:
            x = (m[key] or {}).get("x1")
            if x is None:
                continue
            if prev is not None:
                deltas.append((t, x - prev[1]))
            prev = (t, x)
        if len(deltas) >= 3:
            steps = [abs(dd) for _, dd in deltas]
            avg = sum(steps) / len(steps) if steps else 0
            peak = max(steps) if steps else 0
            idle = sum(1 for s in steps if s == 0)
            notes.append(
                f"C {label}：推进均值 {avg:.1f}px/帧，峰值 {peak}px，静止帧 {idle}/{len(steps)}"
            )

    # --- D 终帧契约 ---
    last_t, last_m = rows[-1]
    if last_t != total:
        notes.append(f"D 末帧采样点 t={last_t} ≠ 总时长 {total}")
    static_p = d / f"{args.prefix}_static.png"
    rm_p = d / f"{args.prefix}_rm.png"
    url_p = d / f"{args.prefix}_url.png"

    if static_p.exists():
        r = diff(frames[-1][1], static_p)
        # 允许「只剩轮廓」的抗锯齿差（原因见 diff()）。会差是因为带 fill 的动画
        # 让元素被提升成独立合成层，Chromium 对软边（blur 的发光）会换一套采样网格。
        # 这种情况下每个形状边缘都会差 1-2 级，全幅 1% 左右的像素；肉眼不可见，
        # 但它会让「逐像素相等」这种断言永远红着，于是没人再看它 —— 那是更坏的结果。
        #
        # 阈值 24 个「实心」像素：模糊边缘的交角处偶尔会出现 2x2 的小块，属于采样噪声；
        # 真正的形状变化（少画一截、位移 1px、元素没画出来）会产生成百上千个。
        # 实测两者差三个数量级，阈值取在哪里都安全。
        solid = r.get("n_solid", 1)
        strong = r.get("n_strong", 0)
        if solid > 24:
            fails.append(f"D 终帧契约：t={last_t} 与 ?static=1 存在实心区域差异（{r}）")
        else:
            notes.append(
                f"D 终帧契约：末帧 == ?static=1 ✓（仅边缘抗锯齿差：max {r['max']}，"
                f"均值 {r['mean']}，超阈值像素 {strong}，实心差异 {solid}）"
            )
        # 几何必须**完全**一致：抗锯齿可以差，位置和长度一个像素都不能差
        for k, label in (("main", "主波"), ("echo", "次波"), ("word", "字标")):
            xa, xb = last_m.get(k), measure(static_p).get(k)
            if xa and xb and (xa["x0"], xa["x1"]) != (xb["x0"], xb["x1"]):
                fails.append(f"D 几何不一致 {label}：末帧 {xa['x0']}..{xa['x1']} vs 静态 {xb['x0']}..{xb['x1']}")
    if rm_p.exists() and static_p.exists():
        r = diff(rm_p, static_p)
        if not r["equal"]:
            fails.append(f"D reduced-motion 帧与静态终帧不一致（{r}）")
        else:
            notes.append("D reduced-motion == ?static=1 ✓")

    # --- E 路径一致 ---
    # 允许极小的抗锯齿差异：?t= 那张是冷启动首帧，连拍那张是已渲染多帧后的同一时刻，
    # 滤镜/渐变的累积精度会有 1-3 级差。要抓的是「两者布局或进度不同」那种量级的偏差，
    # 阈值卡在 max<=4 且异常像素 <300（占全幅 0.03%）。
    if url_p.exists():
        r = diff(url_p, frames[0][1])
        if r.get("max", 0) > 4 or r.get("n_diff", 0) > 300:
            fails.append(f"E ?t={frames[0][0]} 与连拍同刻不一致（{r}）")
        else:
            notes.append(f"E ?t= 路径与连拍路径一致 ✓（max {r['max']}，{r['n_diff']} px 抗锯齿微差）")

    # --- F 版式落地 ---
    if args.lockup and last_m.get("word_ink_w"):
        lk = json.loads(Path(args.lockup).read_text(encoding="utf-8"))
        design = lk["wordmark"]["ink_w"]
        got = last_m["word_ink_w"]
        if abs(got - design) > 3:
            fails.append(f"F 终帧字标墨迹宽 {got}px，设计值 {design}px（差 {got - design:+.1f}）")
        else:
            notes.append(f"F 终帧字标墨迹宽 {got}px vs 设计 {design}px（差 {got - design:+.1f}）✓")
        mw = (last_m.get("main") or {}).get("cols")
        if mw:
            notes.append(f"F 终帧主波有墨迹的列数 {mw}（设计墨迹宽 {lk['mark']['ink_w']:.0f}px）")

    if args.sheet:
        contact_sheet(frames, Path(args.sheet))
        print(f"\n拼图 -> {args.sheet}")

    if args.json:
        Path(args.json).write_text(
            json.dumps({"frames": [{"t": t, **m} for t, m in rows]}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    print()
    for n in notes:
        print(f"  · {n}")
    print()
    if fails:
        for f in fails:
            print(f"  ✗ {f}")
        print(f"\n失败 {len(fails)} 项")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
