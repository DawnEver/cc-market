"""Manuscript review: PDF in, per-section markdown out.

This is the only deterministic step the workflow has. Everything after it is a
model reading the paper and arguing about it, which is the point — unlike
reviewer discovery there is no sanitisation boundary here, because putting the
text in front of a model *is* the review.

What this module owes the steps downstream is that a workspace either holds a
complete decomposition or visibly holds nothing. A half-written directory is
worse than an empty one: `04-fanout.md` treats the presence of `paper.md` as
proof the work was done and would hand reviewers a truncated paper.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from academia.core import log, paths
from academia.core.errors import UsageError
from academia.ingest.pdf import decompose

WORKFLOW = "manuscript-review"

RAW_PDF = "0-raw.pdf"
TEXT_DIR = "1-paper-text"
INDEX_FILE = "INDEX.md"


def slug_for(pdf: Path, explicit: str | None) -> str:
    """Workspace name: the one given, else the PDF's own name."""
    source = explicit or pdf.stem
    slug = re.sub(r"[^a-z0-9]+", "-", source.lower()).strip("-")
    if not slug:
        raise UsageError(f"cannot derive a workspace name from {pdf.name!r}; pass --slug")
    return slug[:80]


@dataclass
class Workspace:
    root: Path
    slug: str

    @property
    def raw_pdf(self) -> Path:
        return self.root / RAW_PDF

    @property
    def text_dir(self) -> Path:
        return self.root / TEXT_DIR

    @property
    def entry(self) -> Path:
        return self.text_dir / "paper.md"


def prepare(pdf: Path, *, slug: str, root: Path | None = None) -> Workspace:
    """Create the workspace and copy the manuscript in.

    Idempotent, so a run that failed part-way through decomposition can simply
    be repeated rather than cleaned up by hand.
    """
    pdf = Path(pdf).expanduser()
    if not pdf.exists():
        raise UsageError(f"file not found: {pdf}")

    base = Path(root) if root is not None else paths.ongoing_root(WORKFLOW)
    workspace = Workspace(root=base / slug, slug=slug)
    workspace.root.mkdir(parents=True, exist_ok=True)
    if workspace.raw_pdf.resolve() != pdf.resolve():
        shutil.copy2(pdf, workspace.raw_pdf)
    return workspace


def build_index(text_dir: Path) -> dict[str, str]:
    """Map every extracted image to the section it came from.

    The review steps cite figures by number and need to point at a file; without
    the map they either guess or drop the figure from the critique entirely.
    """
    image_root = text_dir / "img"
    index: dict[str, str] = {}
    for image in sorted(image_root.rglob("*.png")) if image_root.exists() else []:
        relative = image.relative_to(image_root).as_posix()
        index[relative] = image.parent.name

    lines = ["# Figure index", "", "| Image | Section |", "|---|---|"]
    lines += [f"| `{key}` | {section} |" for key, section in index.items()]
    (text_dir / INDEX_FILE).write_text("\n".join(lines) + "\n", encoding="utf-8")
    return index


def run(pdf: Path, *, slug: str | None = None, root: Path | None = None) -> Workspace:
    """Full ingest: workspace, decomposition, figure index.

    A failure part-way through removes the text directory rather than leaving
    it, so the next step cannot mistake a partial result for a finished one.
    """
    pdf = Path(pdf).expanduser()
    workspace = prepare(pdf, slug=slug_for(pdf, slug), root=root)

    try:
        decompose(workspace.raw_pdf, workspace.text_dir)
    except Exception as error:
        shutil.rmtree(workspace.text_dir, ignore_errors=True)
        raise UsageError(
            f"could not decompose {pdf.name}: {error}\n"
            "The workspace is left with the PDF only, so re-running is safe."
        ) from error

    if not workspace.entry.exists():
        shutil.rmtree(workspace.text_dir, ignore_errors=True)
        raise UsageError(
            f"decomposition of {pdf.name} produced no paper.md. "
            "Install the 'pdf' extra, or check the PDF is not image-only."
        )

    index = build_index(workspace.text_dir)
    log.info(f"ingested {pdf.name} -> {workspace.text_dir}")
    log.detail(f"  {len(index)} figures indexed")
    return workspace
