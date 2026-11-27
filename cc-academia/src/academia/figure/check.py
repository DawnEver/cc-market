"""check_figure: numeric figure checks (rules figure.no-overlap, figure.text-size, figure.panel-consistency,
figure.layout-frozen). Each issue is {"check", "rule", "message"}; an empty list means the figure passes."""

import json
import re
from itertools import pairwise

LETTER = re.compile(r"^\([a-z]\)$")


def _texts(fig):
    """Every visible, non-empty text artist of the figure."""
    out = list(fig.texts)
    for ax in fig.axes:
        out += [
            ax.title,
            ax._left_title,
            ax._right_title,
            ax.xaxis.label,
            ax.yaxis.label,
            *ax.texts,
        ]
        for axis in (ax.xaxis, ax.yaxis):  # only ticks inside the view are drawn
            lo, hi = sorted(axis.get_view_interval())
            eps = (hi - lo) * 1e-9
            out += [
                lab
                for loc, lab in zip(
                    axis.get_majorticklocs(), axis.get_majorticklabels(), strict=False
                )
                if lo - eps <= loc <= hi + eps
            ]
        leg = ax.get_legend()
        if leg:
            out += leg.get_texts()
    seen, res = set(), []
    for t in out:
        if id(t) in seen or not t.get_visible() or not t.get_text().strip():
            continue
        seen.add(id(t))
        res.append(t)
    return res


def _baseline(t, r):
    """Baseline y of a text in display pixels."""
    if t.get_va() == "baseline":
        return t.get_transform().transform(t.get_position())[1]
    _, _, d = r.get_text_width_height_descent(
        t.get_text(), t.get_fontproperties(), ismath="$" in t.get_text()
    )
    return t.get_window_extent(r).y0 + d


def layout_of(fig):
    """Layout in inches: figure size and each axes' [x0, y0, width, height]."""
    w, h = fig.get_size_inches()
    return {
        "figure": [round(w, 4), round(h, 4)],
        "axes": [
            [round(v, 4) for v in (p.x0 * w, p.y0 * h, p.width * w, p.height * h)]
            for p in (a.get_position() for a in fig.axes)
        ],
    }


def save_baseline(fig, path):
    """Freeze the approved layout: write layout_of(fig) as JSON."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(layout_of(fig), f, indent=1)


#: One-line remedy per figure check; every issue ends with it.
REMEDY = {
    "figure-overlap": "move or shorten one label",
    "figure-font-size": "set the text to dimension figure.font-size-pt",
    "figure-letter-baseline": "place the letter with academia.figure.letter_bl",
    "figure-layout-diff": "restore the frozen layout (figure.layout-frozen) or ask before changing it",
}


def check_figure(fig, font_size=None, baseline=None, tol_pt=0.5, tol_in=0.01):
    """Return a list of issues. font_size: expected size of every text [pt] (dimension figure.font-size-pt).
    baseline: path of a saved layout JSON (save_baseline) to diff axes sizes and gaps against."""
    issues = []

    def add(check, rule, msg):
        issues.append({"check": check, "rule": rule, "message": f"{msg}: {REMEDY[check]}"})

    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    px = fig.dpi / 72.0
    texts = _texts(fig)
    boxes = [(t, t.get_window_extent(r)) for t in texts]
    for i, (a, ba) in enumerate(boxes):
        for b, bb in boxes[i + 1 :]:
            w = min(ba.x1, bb.x1) - max(ba.x0, bb.x0)
            h = min(ba.y1, bb.y1) - max(ba.y0, bb.y0)
            if w > tol_pt * px and h > tol_pt * px:
                add(
                    "figure-overlap",
                    "figure.no-overlap",
                    f'"{a.get_text()}" overlaps "{b.get_text()}" by {w / px:.1f} x {h / px:.1f} pt',
                )
    if font_size is not None:
        for t in texts:
            if abs(t.get_fontsize() - float(font_size)) > 0.05:
                add(
                    "figure-font-size",
                    "figure.text-size",
                    f'"{t.get_text()}" is {t.get_fontsize():g} pt, not {float(font_size):g} pt',
                )
    letters = [t for t in texts if LETTER.match(t.get_text().strip())]
    for t in letters:
        tb = t.get_window_extent(r)
        cands = [
            a
            for a in fig.axes
            if a.get_window_extent(r).y0 > tb.y1 - 1
            and a.get_window_extent(r).x0 - 60 * px <= tb.x0 <= a.get_window_extent(r).x1
        ]
        if not cands:
            continue
        ax = min(cands, key=lambda a: a.get_window_extent(r).y0 - tb.y1)
        if ax.xaxis.label.get_text().strip():
            d = (_baseline(t, r) - _baseline(ax.xaxis.label, r)) / px
            if abs(d) > tol_pt:
                add(
                    "figure-letter-baseline",
                    "figure.panel-consistency",
                    f"{t.get_text()} sits {d:+.1f} pt off the x-label baseline of its panel",
                )
    ys = sorted((_baseline(t, r) / px, t.get_text()) for t in letters)
    for (y0, l0), (y1, l1) in pairwise(ys):
        if tol_pt < y1 - y0 < 20:
            add(
                "figure-letter-baseline",
                "figure.panel-consistency",
                f"{l0} and {l1} differ by {y1 - y0:.1f} pt; one baseline per row",
            )
    if baseline:
        with open(baseline, encoding="utf-8") as f:
            base = json.load(f)
        now = layout_of(fig)
        if any(abs(x - y) > tol_in for x, y in zip(now["figure"], base["figure"], strict=False)):
            add(
                "figure-layout-diff",
                "figure.layout-frozen",
                f"figure size {now['figure']} in differs from baseline {base['figure']} in",
            )
        if len(now["axes"]) != len(base["axes"]):
            add(
                "figure-layout-diff",
                "figure.layout-frozen",
                f"{len(now['axes'])} axes, baseline has {len(base['axes'])}",
            )
        names = ("x0", "y0", "width", "height")
        for k, (a, b) in enumerate(zip(now["axes"], base["axes"], strict=False)):
            for n, x, y in zip(names, a, b, strict=False):
                if abs(x - y) > tol_in:
                    add(
                        "figure-layout-diff",
                        "figure.layout-frozen",
                        f"axes {k} {n} {x:.3f} in, baseline {y:.3f} in",
                    )
    return issues
