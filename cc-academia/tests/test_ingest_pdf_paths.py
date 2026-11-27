"""Decomposition must survive a workspace path containing spaces.

pymupdf4llm rewrites spaces in ``image_path`` to underscores when it names the
extracted images, then cannot open them; a synced data root such as
"OneDrive - <org>" made every manuscript ingest fail.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

from academia.ingest import pdf as pdf_mod


def test_decompose_converts_in_a_space_free_dir(tmp_path, monkeypatch):
    out_dir = tmp_path / "Sync dir - with spaces" / "1-paper-text"
    pdf = tmp_path / "in.pdf"
    pdf.write_bytes(b"%PDF-1.4")
    seen: dict[str, Path] = {}

    def convert(source, work_dir):
        seen["work"] = Path(work_dir)
        img = Path(work_dir) / "img" / "flat"
        img.mkdir(parents=True)
        (img / "a.png").write_bytes(b"x")
        return "# A\ntext", "pymupdf4llm"

    def write_paper_output(sections, work_dir, markdown, pdf_path=None):
        (Path(work_dir) / "paper.md").write_text("# paper", encoding="utf-8")

    fake = types.SimpleNamespace(
        convert=convert, split_sections=lambda m: [m], write_paper_output=write_paper_output
    )
    monkeypatch.setitem(sys.modules, "paper_pdf_ingest", fake)
    monkeypatch.setattr(pdf_mod, "_has_ingest", lambda: True)
    monkeypatch.setattr(pdf_mod, "_without_cover_pages", lambda p, o: p)

    result = pdf_mod.decompose(pdf, out_dir)

    assert " " not in str(seen["work"])
    assert (out_dir / "paper.md").exists()
    assert (out_dir / "img" / "flat" / "a.png").exists()
    assert result.entry == out_dir / "paper.md"
