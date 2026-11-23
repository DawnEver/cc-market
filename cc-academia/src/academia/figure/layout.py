"""Panel-letter layout helpers (generalised from a preset's figure values; see knowledge/presets/*/figure).

letter_bl: data-plot letter on the x-label baseline, outside the frame (figure.panel-letter-position = bottom-left).
letter_inside: drawing letter inside the frame corner.
label_after_letter: one-line x label after the letter, layout unchanged (figure.layout-frozen).
trim_bottom: remove the empty band below the lowest text, panel sizes unchanged.
"""


def letter_bl(ax, lab, label_ax=None, gap_left=False):
    """Panel letter "(a)" below the frame, on the baseline of the x-axis label of label_ax (default ax), left-aligned
    with the left end of ax's y tick labels (or with the frame when ax has none). gap_left: end the letter 2 pt right
    of the frame's left edge, in the gap to the panel on the left. Call after the layout is final."""
    fig = ax.figure
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    lbl = (label_ax or ax).xaxis.label
    _, _, d = r.get_text_width_height_descent(
        lbl.get_text(), lbl.get_fontproperties(), ismath="$" in lbl.get_text()
    )
    yb = lbl.get_window_extent(r).y0 + d
    tl = [
        t.get_window_extent(r).x0
        for t in ax.get_yticklabels()
        if t.get_visible() and t.get_text() and ax.yaxis.get_ticks_position() != "right"
    ]
    xl = min(tl) if tl else ax.get_window_extent(r).x0
    if gap_left:
        return fig.text(
            (ax.get_window_extent(r).x0 + 2 * fig.dpi / 72) / fig.bbox.width,
            yb / fig.bbox.height,
            f"({lab})",
            ha="right",
            va="baseline",
        )
    return fig.text(xl / fig.bbox.width, yb / fig.bbox.height, f"({lab})", ha="left", va="baseline")


def letter_inside(ax, lab, corner="bottom-left", pad_pt=4.0):
    """Panel letter "(a)" inside the axes at a corner (drawings), regular weight, small inset."""
    from matplotlib.transforms import offset_copy

    bottom = corner.startswith("bottom")
    tr = offset_copy(
        ax.transAxes, fig=ax.figure, x=pad_pt, y=pad_pt if bottom else -pad_pt, units="points"
    )
    return ax.text(
        0,
        0 if bottom else 1,
        f"({lab})",
        transform=tr,
        ha="left",
        va="baseline" if bottom else "top",
        zorder=20,
    )


def label_after_letter(ax, letter_text, gap_pt=3.0):
    """One-line x-axis label starting gap_pt right of the panel letter on the same baseline, so a long label can
    run past a narrow frame without moving the panels (layout unchanged). Call after letter_bl."""
    fig = ax.figure
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    x_px = letter_text.get_window_extent(r).x1 + gap_pt * fig.dpi / 72
    y_px = letter_text.get_transform().transform(letter_text.get_position())[1]
    x_ax, y_ax = ax.transAxes.inverted().transform((x_px, y_px))
    lbl = ax.xaxis.label
    lbl.set_horizontalalignment("left")
    lbl.set_verticalalignment("baseline")
    ax.xaxis.set_label_coords(x_ax, y_ax)


def trim_bottom(fig, pad_pt=1.0):
    """Remove the empty band below the lowest text or artist, keeping every axes and text at its absolute size and
    position relative to the top edge (panel sizes unchanged; only the figure gets shorter)."""
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    low = min(
        [a.get_tightbbox(r).y0 for a in fig.axes]
        + [t.get_window_extent(r).y0 for t in fig.texts if t.get_text()]
    )
    cut = low / fig.dpi - pad_pt / 72
    if cut <= 0:
        return
    h0 = fig.get_figheight()
    h1 = h0 - cut
    for a in fig.axes:
        p = a.get_position()
        a.set_position([p.x0, (p.y0 * h0 - cut) / h1, p.width, p.height * h0 / h1])
    for t in fig.texts:
        x, y = t.get_position()
        t.set_position((x, (y * h0 - cut) / h1))
    fig.set_figheight(h1)
