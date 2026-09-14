#!/usr/bin/env python3
"""从源图逐列/逐行精测中心线，再拟合成「直线段 + 圆角」的 SVG 路径。

为什么不用手凑控制点：两条波形各有 5 段直线 + 4 个圆角（主波与暗波同构），
共 8 个特征点。手工凑的数字互相耦合，改一处坏一处，而且没法复核。
本工具把每一段用最小二乘拟合出直线、相邻直线求交点得角点、
再由实测「矢高」反解圆角的切点长度 —— 路径因此是可复现的计算结果。

测量方式（关键）：垂直切只适合平段（陡段的垂切长度 = 线宽×√(1+m²)，会失准），
所以平段用**逐列垂直切**、陡段用**逐行水平切取所有段**。
两者都用 50% 覆盖定几何边缘。

用法：
  python fit_centerline.py "D:/NetPeek/图标.png" --json outputs/centerline_fit.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# 每段：(名字, 取点轴, 参数范围, 可选 x 侧向过滤)
#   "x" 轴 = 逐列垂直切（平段）；"y" 轴 = 逐行水平切（陡段）
#
# 参数范围**必须延伸进圆角区**（每侧多取 ~30px）：圆角拟合要的是「同时偏离两条直线」的点，
# 范围卡死在直线段内就一个都取不到。多出来的圆角点由 fit_seg 的 MAD 抗差剔掉，不会污染直线。
MODEL = {
    "main": dict(
        label="主波(琥珀)",
        stroke=22,
        endpoints=(237, 1013),
        flat_y=632.5,
        # 行窗上界 716 必须低于暗波墨迹顶(714)才不串扰，下界 555 装得下谷底墨迹(704)
        col_win=(552, 716),
        row_win=(540, 790),
        # 逐行切在尖顶/谷底不可信，改用墨迹包络定中心线极值：
        #   峰顶墨迹最高 y=446，round join 半径=半线宽 11 ⇒ 中心线极值 y=457
        #   谷底由逐列垂直切直接读到 y=691（该处 |斜率|≈0.86，垂切可信）
        extreme={1: (627.5, 457.0), 2: (720.0, 691.0)},
        segs=[
            ("flatL", "x", (250, 552), None),
            ("rise", "y", (474, 622), (556, 626)),
            ("fall", "y", (462, 694), (622, 728)),
            ("return", "x", (726, 752), None),
            ("flatR", "x", (752, 1005), None),
        ],
    ),
    "echo": dict(
        label="暗波(次级)",
        stroke=17,
        endpoints=(248, 1003),
        flat_y=802.0,
        # 行窗上界 750：主波辉光最多探到谷底墨迹(704)+40=744，750 之外才干净
        col_win=(750, 895),
        row_win=(540, 790),
        # 暗波的平台与谷底都能被逐列垂直切直接读到（该处 |斜率| ≤ 1.55，垂切可信）
        extreme={1: (626.0, 723.0), 2: (712.0, 831.5)},
        segs=[
            ("flatL", "x", (270, 556), None),
            ("rise", "y", (735, 803), (552, 624)),
            ("fall", "y", (726, 832), (620, 712)),
            ("return", "x", (714, 744), None),
            ("flatR", "x", (740, 992), None),
        ],
    ),
}


def luminance(a: np.ndarray) -> np.ndarray:
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def segments_1d(sig: np.ndarray, min_prom: float) -> list[tuple[int, int]]:
    """在一段一维信号里找出所有「峰 → 50% 高度」的连续段。

    必须按**峰高降序**处理，并跳过已被更强段覆盖的次级峰。
    否则辉光的峰会先取到，它往线芯方向的 50% 行走会一路穿进线芯，
    把「辉光 + 线芯」并成一条远超线宽上限的段，线芯反而一个都没留下。
    """
    if sig.size < 3:
        return []
    floor = float(np.percentile(sig, 10))
    peaks = [
        i
        for i in range(1, sig.size - 1)
        if sig[i] >= sig[i - 1] and sig[i] > sig[i + 1] and sig[i] - floor >= min_prom
    ]
    peaks.sort(key=lambda i: -sig[i])
    claimed = np.zeros(sig.size, dtype=bool)
    out: list[tuple[int, int]] = []
    for i in peaks:
        if claimed[i]:
            continue
        half = (sig[i] + floor) / 2
        a = i
        while a > 0 and sig[a - 1] > half:
            a -= 1
        b = i
        while b < sig.size - 1 and sig[b + 1] > half:
            b += 1
        if claimed[a : b + 1].any():
            continue          # 与更强的段重叠 → 同一结构的次级峰
        claimed[a : b + 1] = True
        out.append((a, b))
    return sorted(out)


def col_cut(L: np.ndarray, x: int, y0: int, y1: int, max_extent: int):
    segs = segments_1d(L[y0:y1, x], min_prom=10)
    best = None
    for a, b in segs:
        if b - a + 1 <= max_extent and (best is None or (b - a) > (best[1] - best[0])):
            best = (a, b)
    if best is None:
        return None
    return (y0 + (best[0] + best[1]) / 2, best[1] - best[0] + 1)


def row_cut(L: np.ndarray, y: int, x0: int, x1: int, max_extent: int):
    out = []
    for a, b in segments_1d(L[y, x0:x1], min_prom=10):
        if b - a + 1 <= max_extent:
            out.append((x0 + (a + b) / 2, b - a + 1))
    return out


def collect_points(L: np.ndarray, model: dict, verbose=False) -> dict[str, list[tuple[float, float]]]:
    """按段落收集中心线点。返回 {段名: [(x, y), ...]}"""
    w = model["stroke"]
    y0, y1 = model["col_win"]
    rx0, rx1 = model["row_win"]
    pts: dict[str, list[tuple[float, float]]] = {name: [] for name, *_ in model["segs"]}

    for name, axis, (lo, hi), side in model["segs"]:
        if axis == "x":
            # 平段：垂切长度上限 = w·√(1+1.6²)，只接受近水平的列
            cap = int(w * np.sqrt(1 + 1.6**2)) + 4
            for x in range(int(lo), int(hi) + 1):
                r = col_cut(L, x, y0, y1, cap)
                if r:
                    pts[name].append((float(x), r[0]))
        else:
            # 陡段：水平切长度上限 = w·√(1+4²)，取落在侧向范围内的所有段
            cap = int(w * np.sqrt(1 + 4.0**2)) + 6
            for y in range(int(lo), int(hi) + 1):
                for cx, ext in row_cut(L, y, rx0, rx1, cap):
                    if side and not (side[0] <= cx <= side[1]):
                        continue
                    pts[name].append((cx, float(y)))
    if verbose:
        for name in pts:
            print(f"    {name:<8} 点数 {len(pts[name])}")
    return pts


def fit_seg(pts: list[tuple[float, float]], axis: str) -> dict | None:
    """直线最小二乘（带 MAD 抗差重拟合）。返回一般式 A·x + B·y + C = 0 与残差。

    抗差是必需的：少数列会被邻近笔画/辉光串扰（例如主波辉光尾巴探进暗波的行窗），
    它们离群很远。先拟合一次，剔掉 |残差| > max(1.5, 3·MAD) 的点再拟合一次。
    """
    if len(pts) < 8:
        return None
    P = np.array(pts, dtype=float)

    def once(Q):
        if axis == "x":            # y = a + b·x
            b, a = np.polyfit(Q[:, 0], Q[:, 1], 1)
            return (b, -1.0, a), Q[:, 1] - (a + b * Q[:, 0])
        d, c = np.polyfit(Q[:, 1], Q[:, 0], 1)      # x = c + d·y
        return (1.0, -d, -c), Q[:, 0] - (c + d * Q[:, 1])

    # 迭代收紧容差：取样区间刻意含圆角区，首轮会有~1/3的点是圆角点（偏离大），
    # 一次 MAD 剔不干净；多轮收紧后圆角点会被剔掉，直线残差回到亚像素。
    Q = P.copy()
    for _ in range(6):
        (A, B, C), res = once(Q)
        mad = float(np.median(np.abs(res - np.median(res))))
        tol = min(max(0.6, 3.0 * mad), 2.5)   # 上限 2.5px：本项目实测噪声只有 0.1~0.3px
        keep = np.abs(res) <= tol
        if keep.all() or keep.sum() < max(8, int(0.40 * len(P))):
            break
        Q = Q[keep]
    (A, B, C), res = once(Q)
    return {
        "A": float(A), "B": float(B), "C": float(C),
        "n": int(len(Q)),
        "dropped": int(len(P) - len(Q)),
        "rms": round(float(np.sqrt((res**2).mean())), 3),
        "max": round(float(np.abs(res).max()), 3),
    }


def intersect(l1: dict, l2: dict) -> tuple[float, float]:
    A = np.array([[l1["A"], l1["B"]], [l2["A"], l2["B"]]], dtype=float)
    b = np.array([-l1["C"], -l2["C"]], dtype=float)
    return tuple(float(v) for v in np.linalg.solve(A, b))


def dist_to_line(P: np.ndarray, l: dict) -> np.ndarray:
    n = np.hypot(l["A"], l["B"])
    return np.abs(P[:, 0] * l["A"] + P[:, 1] * l["B"] + l["C"]) / n


def fwd(l: dict) -> np.ndarray:
    """直线朝 x 正方向的单位切向量。"""
    d = unit(np.array([-l["B"], l["A"]]))
    return -d if d[0] < 0 else d


def y_on_line(x: float, l: dict) -> float:
    """直线在给定 x 处的 y。"""
    return float((-l["C"] - l["A"] * x) / l["B"])


def model_y_at(x: float, C, u1, u2, t: float):
    """二次贝塞尔 P0=C+t·u1, P1=C, P2=C+t·u2 在给定 x 处的 y（解 x(s)=x）。"""
    A, B = C + u1 * t, C + u2 * t
    a = A[0] - 2 * C[0] + B[0]
    b = 2 * (C[0] - A[0])
    c = A[0] - x
    if abs(a) < 1e-12:
        if abs(b) < 1e-12:
            return None
        s = -c / b
    else:
        disc = b * b - 4 * a * c
        if disc < 0:
            return None
        r = np.sqrt(disc)
        cands = [(-b + r) / (2 * a), (-b - r) / (2 * a)]
        inr = [v for v in cands if -0.005 <= v <= 1.005]
        if not inr:
            return None
        s = min(inr, key=abs)
    return float((1 - s) ** 2 * A[1] + 2 * s * (1 - s) * C[1] + s ** 2 * B[1])


def solve_fillet_t(C, l1: dict, l2: dict, P: np.ndarray, extreme=None, span=55.0) -> dict:
    """选一个 t，使模型曲线在圆角邻域内**最大偏离实测中心线**最小。

    为什么不用矢高匹配：尖顶/谷底处的逐行切中心点是两条支的墨迹中点，而 y(x) 在那里
    是多值的 —— 那个中点根本不在曲线上。拿它当"曲线点"量矢高，会随两线分开而无界增长
    （实测把 t 顶到上界 60）。这里只用**逐列垂直切**的点（那里 y(x) 单值、可信），
    再对尖顶/谷底额外加一条"墨迹包络"约束（墨迹最外缘 ∓ 半个线宽 = 中心线极值）。
    """
    C = np.array(C, dtype=float)
    u1, u2 = -fwd(l1), fwd(l2)

    # 只保留「确实已离开两条直线」的实测点 —— 那才是圆角的信息。
    # 贴着直线的点必须剔除：它们数量占优，模型只要把 t 缩到 0 就能全部对上，
    # 目标函数因此单调偏向小 t（实测把 t 压到搜索下界 0.5）。
    obs = []
    if P is not None and len(P):
        Q = np.array([p for p in P if abs(p[0] - C[0]) <= span], dtype=float)
        if len(Q):
            dev = np.minimum(dist_to_line(Q, l1), dist_to_line(Q, l2))
            for (x, y), ok in zip(Q, dev > 0.9):
                if ok:
                    obs.append((float(x), float(y)))
    if extreme is not None:
        obs.append((float(extreme[0]), float(extreme[1])))
    if not obs:
        return {"t": 0.0, "obs": len(obs), "maxdev": None, "extreme": extreme}

    best = None
    for t in np.arange(0.5, 40.0, 0.1):
        worst = 0.0
        for x, y in obs:
            my = model_y_at(x, C, u1, u2, t)
            if my is None:
                # x 落在圆角切线区之外 ⇒ 模型退化为对应那条直线，直接用直线取值
                my = y_on_line(x, l1 if x < C[0] else l2)
            worst = max(worst, abs(y - my))
        if best is None or worst < best[0]:
            best = (worst, float(t))
    return {"t": round(best[1], 2), "obs": len(obs), "maxdev": round(best[0], 3), "extreme": extreme}


def unit(v) -> np.ndarray:
    v = np.array(v, dtype=float)
    n = np.linalg.norm(v)
    return v / n if n else v


def build(model: dict, lines: dict, corners: list) -> dict:
    """把「直线段 + 圆角」组装成 SVG 路径。

    圆角用二次贝塞尔、以角点为控制点：这样在两端与直线段**严格相切**（不产生折角），
    与圆角圆弧的最大偏差约为矢高的 20%，在本项目尺度上 <2px。
    """
    x_start, x_end = model["endpoints"]
    names = [s[0] for s in model["segs"]]

    def y_at(x, seg):
        l = lines[seg]
        return (-l["C"] - l["A"] * x) / l["B"]

    def dir_of(seg):
        l = lines[seg]
        d = unit((-l["B"], l["A"]))
        return -d if d[0] < 0 else d   # 统一朝 x 正方向

    d = [f"M{x_start:.4g} {y_at(x_start, names[0]):.4g}"]
    for i, (C, t) in enumerate(corners):
        if t < 0.6:                       # 近乎共线：不值得放圆角
            d.append(f"L{C[0]:.4g} {C[1]:.4g}")
            continue
        prev = C - dir_of(names[i]) * t
        nxt = C + dir_of(names[i + 1]) * t
        d.append(f"L{prev[0]:.3f} {prev[1]:.3f}")
        d.append(f"Q{C[0]:.4g} {C[1]:.4g} {nxt[0]:.3f} {nxt[1]:.3f}")
    d.append(f"L{x_end:.4g} {y_at(x_end, names[-1]):.4g}")

    return {"path": " ".join(d)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("--json", type=Path, default=None)
    ap.add_argument("--only", default=None, help="只拟合某一条：main / echo")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    img = np.asarray(Image.open(args.source).convert("RGBA")).astype(float)
    L = luminance(img)
    report = {}

    for key, model in MODEL.items():
        if args.only and args.only != key:
            continue
        print(f"\n################ {model['label']}（线宽 {model['stroke']}）################")
        pts = collect_points(L, model, args.verbose)
        lines, ok = {}, True
        for name, axis, rng, side in model["segs"]:
            fit = fit_seg(pts[name], axis)
            if fit is None:
                print(f"  !! {name}: 点数不足（{len(pts[name])}），检查模型范围")
                ok = False
                continue
            lines[name] = fit
            print(f"  {name:<8} n={fit['n']:<4} 拟合残差 RMS={fit['rms']:<6} max={fit['max']}")
        if not ok:
            continue

        names = [s[0] for s in model["segs"]]
        axis_of = {s[0]: s[1] for s in model["segs"]}
        extremes = model.get("extreme", {})
        corners, fillet_info = [], []
        for i in range(len(names) - 1):
            l1, l2 = lines[names[i]], lines[names[i + 1]]
            C = intersect(l1, l2)
            # 只用「逐列垂直切」的点：那里 y(x) 单值，是可信的中心线
            valid = np.array(
                [p for n in (names[i], names[i + 1]) if axis_of[n] == "x" for p in pts[n]],
                dtype=float,
            )
            ex = extremes.get(i)
            info = solve_fillet_t(C, l1, l2, valid, extreme=ex)
            corners.append((np.array(C), float(info["t"])))
            fillet_info.append({"拐角": f"{names[i]}→{names[i+1]}",
                                "C": [round(C[0], 2), round(C[1], 2)],
                                "t": info["t"], "约束点数": info["obs"],
                                "最大偏差": info["maxdev"], "包络约束": ex})
            print(f"  拐角 {names[i]:>7}→{names[i+1]:<8} C=({C[0]:8.2f},{C[1]:8.2f})  "
                  f"t={info['t']:6.2f}  最大偏差={info['maxdev']}  约束点={info['obs']}"
                  f"{'  含包络' if ex else ''}")

        built = build(model, lines, corners)
        report[key] = {"label": model["label"], "stroke": model["stroke"],
                       "lines": lines, "fillet": fillet_info, "path": built["path"]}
        print(f"\n  路径:\n    {built['path']}")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n报告 -> {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
