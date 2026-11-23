# Data-figure template

Source: common. Slots in `{}` take dimension values from the owning source
(the author owns every one). Reference implementation: src/academia/figure.

1. Size: drawn at printed size, included as dimension figure.scaling says; all text {figure.font-size-pt} pt in
   {figure.font-family}.
2. Axes: {figure.axis-scale} (linear unless a log axis is unavoidable). Each y-axis ends just above its tallest
   data with {figure.y-headroom} headroom; no empty band (figure.y-headroom).
3. Stacked panels share the x-axis, with a small pad left of zero.
4. Per-panel labels in the {figure.panel-label-position} corner, wrapped onto two lines.
5. Legend {figure.legend-position}, not in a row above the figure; direct labels where space allows
   (figure.direct-labels).
6. Characteristic positions (e.g. f_c, 2f_c) as symbols on the top axis of the first panel, with light-grey dashed
   guide lines through all panels, behind the data (dimension figure.characteristic-marks).
7. Axis labels: quantity name, symbol and unit in {figure.axis-unit-brackets} (ieee.axis-labels).
8. Colours from {figure.palette}, each doubled by line style, marker or hatch (figure.colour-redundant); one
   colour and style per quantity across all figures (figure.one-style-per-quantity).
9. Panel letters: see multi-panel-row.md.
10. After drawing: `check_figure` reports overlaps, font sizes, letter baselines and the layout diff against the
    saved baseline (figure.no-overlap, figure.text-size, figure.panel-consistency, figure.layout-frozen).
