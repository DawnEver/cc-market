"""Figure library: style, letters, overlaps, font size, layout diff (needs matplotlib, extra ``plot``)."""

from __future__ import annotations

import json

import pytest

matplotlib = pytest.importorskip(
    "matplotlib", reason="figure tests need matplotlib: uv sync --extra plot"
)
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from academia import figure  # noqa: E402

DIMS = {
    "figure.font-size-pt": "8",
    "figure.font-family": "computer-modern",
    "figure.palette": "okabe-ito",
}


def two_panels():
    figure.apply_style(dims=DIMS)
    fig, (a0, a1) = plt.subplots(1, 2, figsize=(6.24, 2.2))
    for a in (a0, a1):
        a.plot([0, 1, 2], [0, 1, 4])
        a.set_ylabel("Noise (dB)")
    a0.set_xlabel("Rotor skew angle")
    a1.set_xlabel("Slot opening width")
    fig.tight_layout()
    for a, lab in zip((a0, a1), "ab", strict=True):
        figure.label_after_letter(a, figure.letter_bl(a, lab))
    figure.trim_bottom(fig)
    return fig, a0, a1


def test_figure_library_style_letters_overlaps_font_size_layout_diff(tmp_path):
    fig, a0, a1 = two_panels()
    assert figure.check_figure(fig, font_size=8) == [], "clean two-panel figure passes"
    assert figure.palette("okabe-ito")["vermillion"] == "#D55E00"
    assert plt.rcParams["font.size"] == 8 and plt.rcParams["font.serif"][0] == "cmr10"
    a0.text(0.02, 0.9, "overlap", transform=a0.transAxes)
    a0.text(0.03, 0.9, "overlap", transform=a0.transAxes)
    assert any(i["check"] == "figure-overlap" for i in figure.check_figure(fig, font_size=8))
    plt.close(fig)

    fig, a0, a1 = two_panels()
    a1.set_title("Big", fontsize=12)
    assert any(i["check"] == "figure-font-size" for i in figure.check_figure(fig, font_size=8))
    plt.close(fig)

    fig, a0, a1 = two_panels()
    x, y = fig.texts[1].get_position()
    fig.texts[1].set_position((x, y + 0.02))
    assert any(
        i["check"] == "figure-letter-baseline" for i in figure.check_figure(fig, font_size=8)
    )
    plt.close(fig)

    fig, a0, a1 = two_panels()
    base = tmp_path / "layout.json"
    figure.save_baseline(fig, base)
    assert len(json.loads(base.read_text(encoding="utf-8"))["axes"]) == 2
    assert figure.check_figure(fig, baseline=base) == []
    p = a1.get_position()
    a1.set_position([p.x0 + 0.05, p.y0, p.width - 0.05, p.height])
    diff = [
        i for i in figure.check_figure(fig, baseline=base) if i["check"] == "figure-layout-diff"
    ]
    assert any("axes 1 x0" in i["message"] for i in diff)
    plt.close(fig)

    dims = figure.load_dimensions()
    assert (
        dims["figure.font-size-pt"] == "8" and dims["figure.panel-letter-position"] == "bottom-left"
    )


def test_cli_names_missing_arguments_and_passes_arg_values(tmp_path, capsys, monkeypatch):
    from .helpers import run_cli

    (tmp_path / "figs.py").write_text(
        "import matplotlib.pyplot as plt\n"
        "def needs(csvdir, w=3.0):\n"
        "    fig, ax = plt.subplots(figsize=(float(w), 2))\n"
        "    ax.set_title(csvdir)\n"
        "    return fig\n",
        encoding="utf-8",
    )
    code, _, err = run_cli(["check-figure", "figs.py", "needs"], tmp_path, capsys, monkeypatch)
    assert code == 2 and "needs argument csvdir" in err and "--arg csvdir=" in err
    code, out, _ = run_cli(
        ["check-figure", "figs.py", "needs", "--arg", "csvdir=data", "--arg", "w=3.2"],
        tmp_path,
        capsys,
        monkeypatch,
    )
    assert "figure issues (figs.py:needs" in out
    code, _, err = run_cli(
        ["check-figure", "figs.py", "needs", "--arg", "csvdir"], tmp_path, capsys, monkeypatch
    )
    assert code == 2 and "name=value" in err
