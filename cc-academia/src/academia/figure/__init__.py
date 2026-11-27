"""Figure library: style from the knowledge sources, panel-letter layout helpers, figure checks.

    from academia import figure
    dims = figure.apply_style(project="<latex project root>")   # rcParams from the resolved dimensions
    ...
    figure.label_after_letter(ax, figure.letter_bl(ax, "a"))
    figure.trim_bottom(fig)
    issues = figure.check_figure(fig, font_size=dims["figure.font-size-pt"], baseline="fig.layout.json")

Needs matplotlib (extra ``plot``). CLI: ``academia-write check-figure``.
"""

from .check import check_figure, layout_of, save_baseline
from .layout import label_after_letter, letter_bl, letter_inside, trim_bottom
from .style import apply_style, load_dimensions, palette

__all__ = [
    "apply_style",
    "check_figure",
    "label_after_letter",
    "layout_of",
    "letter_bl",
    "letter_inside",
    "load_dimensions",
    "palette",
    "save_baseline",
    "trim_bottom",
]
