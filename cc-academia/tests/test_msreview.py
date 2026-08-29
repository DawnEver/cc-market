"""Manuscript review: the one deterministic step, and the boundary it keeps.

Unlike reviewer discovery, this workflow is *meant* to put the paper's text in
front of a model — that is the review. So there is no sanitisation boundary
here; what matters is that ingest is reproducible and that a half-finished
decomposition is never mistaken for a complete one.
"""

from __future__ import annotations

import pytest

from academia.core.errors import UsageError
from academia.msreview import ingest as ms_ingest


def test_slug_is_derived_from_the_pdf_name(tmp_path):
    pdf = tmp_path / "TTE-Reg-2026-08-2905_Proof_hi.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    assert ms_ingest.slug_for(pdf, None) == "tte-reg-2026-08-2905-proof-hi"


def test_an_explicit_slug_wins(tmp_path):
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    assert ms_ingest.slug_for(pdf, "my-review") == "my-review"


def test_a_missing_pdf_is_a_usage_error(tmp_path):
    with pytest.raises(UsageError, match="not found"):
        ms_ingest.prepare(tmp_path / "absent.pdf", slug="x", root=tmp_path)


def test_prepare_copies_the_pdf_and_lays_out_the_workspace(tmp_path):
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4")

    workspace = ms_ingest.prepare(pdf, slug="demo", root=tmp_path / "ongoing")

    assert workspace.raw_pdf.read_bytes() == b"%PDF-1.4"
    assert workspace.text_dir.name == "1-paper-text"
    assert workspace.root.name == "demo"


def test_prepare_is_idempotent(tmp_path):
    """Re-running after a failed decomposition must not need a manual cleanup."""
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4")

    first = ms_ingest.prepare(pdf, slug="demo", root=tmp_path / "ongoing")
    second = ms_ingest.prepare(pdf, slug="demo", root=tmp_path / "ongoing")

    assert first.root == second.root


def test_build_index_maps_figures_to_their_section(tmp_path):
    """The review steps cite figures by number; without the map they cannot."""
    text_dir = tmp_path / "1-paper-text"
    (text_dir / "img" / "sec01").mkdir(parents=True)
    (text_dir / "img" / "sec01" / "fig-1.png").write_bytes(b"x")
    (text_dir / "img" / "sec02").mkdir(parents=True)
    (text_dir / "img" / "sec02" / "fig-2.png").write_bytes(b"x")

    index = ms_ingest.build_index(text_dir)

    assert "sec01/fig-1.png" in index
    assert "sec02/fig-2.png" in index
    assert (text_dir / "INDEX.md").exists()


def test_ingest_refuses_rather_than_reporting_a_partial_decomposition(tmp_path, monkeypatch):
    """A later step treats the presence of paper.md as proof the work was done."""
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(b"%PDF-1.4")

    def half_done(_pdf, out_dir):
        out_dir.mkdir(parents=True, exist_ok=True)
        raise RuntimeError("decomposition blew up")

    monkeypatch.setattr(ms_ingest, "decompose", half_done)

    with pytest.raises(UsageError, match="decompos"):
        ms_ingest.run(pdf, slug="demo", root=tmp_path / "ongoing")

    assert not (tmp_path / "ongoing" / "demo" / "1-paper-text" / "paper.md").exists()
