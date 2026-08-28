"""Visualization — year and venue distribution plots.

Absorbed from AeroWdg plot.py.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import matplotlib.pyplot as plt

from academia.litreview.models import Candidate


def _apply_style() -> None:
    """Apply a clean global style for figures."""
    plt.rcParams.update({
        "font.family": "sans-serif",
        "font.size": 10,
        "axes.titlesize": 12,
        "axes.labelsize": 10,
    })


def plot_year_distribution(candidates: list[Candidate], path: Path) -> None:
    """Plot a bar chart of publication years and save to *path*.

    Candidates with a missing or zero publication_year are grouped under 'Unknown'.
    """
    _apply_style()

    years: list[str] = []
    for c in candidates:
        y = c.publication_year
        years.append(str(y) if y else "Unknown")

    counts = Counter(years)
    # Sort numerically where possible, with 'Unknown' last
    def _sort_key(item: tuple[str, int]) -> tuple[int, str]:
        label = item[0]
        if label == "Unknown":
            return (9999, label)
        try:
            return (int(label), label)
        except ValueError:
            return (9998, label)

    ordered = sorted(counts.items(), key=_sort_key)
    labels = [k for k, _ in ordered]
    values = [v for _, v in ordered]

    fig, ax = plt.subplots(figsize=(10, 5))
    bars = ax.bar(labels, values, color="tab:blue", alpha=0.75, edgecolor="white")
    ax.set_title("Publication Year Distribution")
    ax.set_xlabel("Year")
    ax.set_ylabel("Number of Papers")
    ax.tick_params(axis="x", rotation=45)

    # Annotate bar tops
    for bar, val in zip(bars, values, strict=False):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.3,
                str(val), ha="center", va="bottom", fontsize=8)

    path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_venue_distribution(candidates: list[Candidate], path: Path) -> None:
    """Plot a horizontal bar chart of venue/journal distribution and save to *path*.

    Limits to the top 15 venues for readability.
    """
    _apply_style()

    venues = Counter(c.venue for c in candidates if c.venue)
    top = venues.most_common(15)

    labels = [k for k, _ in top]
    values = [v for _, v in top]

    fig, ax = plt.subplots(figsize=(10, 6))
    ax.barh(labels, values, color="tab:green", alpha=0.75, edgecolor="white")
    ax.set_title("Top Venues by Paper Count")
    ax.set_xlabel("Number of Papers")
    ax.invert_yaxis()  # highest count at top

    for i, val in enumerate(values):
        ax.text(val + 0.3, i, str(val), va="center", fontsize=8)

    path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)
