# Multi-panel row layout

Source: common (figure.panel-consistency, figure.use-page-width, figure.layout-frozen).

1. Related panels share a row; never a single half-width panel alone when a partner exists. Paired panels take
   {figure.pair-width} of the text width each, equal font size and matching height.
2. Panels of one row share height and the baseline of their letters.
3. Panel letters (a), (b), (c) at {figure.panel-letter-position}, {figure.panel-letter-weight} weight: for data
   plots on the x-label baseline outside the frame, left-aligned with the y tick labels (`letter_bl`); for drawings
   inside the bottom-left corner. One baseline per row.
4. A long x label runs on one line starting just right of the letter on the same baseline
   (`label_after_letter`), so the panels keep their size.
5. Remove the empty band below the lowest text without moving the panels (`trim_bottom`).
6. Freeze the layout once approved: save a baseline with `check_figure(..., save_baseline=...)` and compare
   every later version against it.
