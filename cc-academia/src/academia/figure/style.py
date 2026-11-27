"""Figure style from the effective configuration (academia.knowledge.resolve): font size and family, palette.

The values live in the knowledge sources (author figure/values.tsv, venue values, common defaults);
this module only maps them onto matplotlib rcParams.
"""

import csv

from academia.knowledge.resolve import knowledge_root, resolve

# font-family option -> matplotlib settings (mechanism, not style data)
FONTS = {
    "computer-modern": {
        "font.family": "serif",
        "font.serif": ["cmr10"],
        "mathtext.fontset": "cm",
        "axes.formatter.use_mathtext": True,
    },
    "times": {
        "font.family": "serif",
        "font.serif": ["Times New Roman", "Times"],
        "mathtext.fontset": "stix",
    },
    "helvetica": {
        "font.family": "sans-serif",
        "font.sans-serif": ["Helvetica", "Arial"],
        "mathtext.fontset": "stixsans",
    },
}


def load_dimensions(project=None):
    """{dimension id: value} of the resolved knowledge for a LaTeX project root (or common only)."""
    cfg = resolve(project)
    if cfg.errors:
        raise RuntimeError("knowledge jurisdiction errors:\n" + "\n".join(cfg.errors))
    return {k: v["value"] for k, v in cfg.dimensions.items()}


def palette(name="okabe-ito"):
    """{colour name: hex} of a palette in knowledge/common/figure/palettes.tsv."""
    with open(
        knowledge_root() / "common" / "figure" / "palettes.tsv", newline="", encoding="utf-8"
    ) as f:
        rows = [r for r in csv.DictReader(f, delimiter="\t") if r["palette"] == name]
    if not rows:
        raise KeyError(f"no palette {name!r} in knowledge/common/figure/palettes.tsv")
    return {r["name"]: r["hex"] for r in rows}


def apply_style(project=None, dims=None):
    """Set matplotlib rcParams from the figure dimensions; returns the dimension dict used."""
    import matplotlib
    import matplotlib.pyplot as plt

    dims = dict(dims) if dims is not None else load_dimensions(project)
    size = float(dims.get("figure.font-size-pt", 8))
    family = dims.get("figure.font-family", "computer-modern")
    if family not in FONTS:
        raise KeyError(
            f"figure.font-family {family!r} has no font mapping in academia/figure/style.py"
        )
    plt.rcParams.update(
        {
            "font.size": size,
            "axes.labelsize": size,
            "axes.titlesize": size,
            "xtick.labelsize": size,
            "ytick.labelsize": size,
            "legend.fontsize": size,
            "figure.titlesize": size,
            "legend.frameon": False,
            "axes.unicode_minus": False,
            "pdf.fonttype": 42,
            "lines.linewidth": 1.0,
            "lines.markersize": 3,
            "axes.linewidth": 0.6,
            "xtick.major.width": 0.6,
            "ytick.major.width": 0.6,
            **FONTS[family],
        }
    )
    pal = palette(dims.get("figure.palette", "okabe-ito"))
    plt.rcParams["axes.prop_cycle"] = matplotlib.cycler(color=list(pal.values()))
    dims["figure.font-size-pt"] = size
    return dims
