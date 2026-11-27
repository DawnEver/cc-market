# Make or change a figure

1. Agree the design with the author before drawing (sketch: panels, axes, legend, letters).
2. Templates: `knowledge/common/figure/templates/{data-figure,schematic,multi-panel-row}.md`; values from
   `academia-write resolve --task write --scope data-plot` (or `schematic`, `multi-panel`): rules and figure dimensions.
3. Script it in the project's analysis folder and list it in `.academia/figures.tsv` (label, panel, file, script,
   function, data); snapshot the input data (data.reproducible).
4. Figure library (`uv sync --extra plot` once; run the script with the plugin's environment):
   ```python
   from academia import figure

   dims = figure.apply_style(project=r"<latex project root>")  # rcParams from the knowledge sources
   colours = figure.palette(dims["figure.palette"])
   ...  # draw at printed size
   figure.label_after_letter(ax, figure.letter_bl(ax, "a"))  # letter on the x-label baseline
   figure.trim_bottom(fig)
   issues = figure.check_figure(
       fig, font_size=dims["figure.font-size-pt"], baseline="fig_x.layout.json"
   )
   ```
   Or from outside the script: `academia-write check-figure <script.py> <function> [--baseline fig_x.layout.json]`.
   Iterate until no issue remains (overlaps, font size, letter baselines, layout diff). After approval freeze the
   layout with `figure.save_baseline(fig, "fig_x.layout.json")`; a later text change must not move it
   (figure.layout-frozen).
5. A text or term change never reaches a figure on its own (hard constraint 3).
6. Include the figure unscaled when `figure.scaling = unscaled`; compile and read the rendered page. Iterate on
   the rendered page, not the script output, before showing the figure to the author.
