"""Smoke tests: the console scripts start, and the source layer is wired up.

Rewritten during the migration. The previous version asserted against
``BaseProvider.normalize_record`` and an ``acquire()`` stub, both of which are
gone on purpose: normalisation now happens once in ``litreview.candidates``, and
PDF acquisition is a transport concern rather than a method on a search source.
"""

from __future__ import annotations

import subprocess
import sys

import pytest


def _run(*argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "academia.cli.dispatch", *argv], capture_output=True, text=True
    )


def test_academia_version():
    result = _run("--version")
    assert result.returncode == 0
    assert "cc-academia" in result.stdout


def test_academia_help():
    assert _run("--help").returncode == 0


@pytest.mark.parametrize("script", ["lit-review", "rev-disc", "academia"])
def test_console_scripts_are_installed(script):
    result = subprocess.run([script, "--version"], capture_output=True, text=True)
    assert result.returncode == 0


def test_doctor_reports_the_active_configuration():
    result = subprocess.run(
        [sys.executable, "-c", "from academia.cli.dispatch import main; raise SystemExit(main(['doctor','--json']))"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0
    assert "plugin_root" in result.stdout


def test_ieee_is_a_paper_source():
    from academia.sources import get_source
    from academia.sources.base import PaperSource

    source = get_source("ieee")
    assert isinstance(source, PaperSource)
    assert source.name == "ieee"


def test_doi_normalisation_lives_in_core_text():
    """It moved out of the source base class: every workflow needs it, not just search."""
    from academia.core.text import normalize_doi

    assert normalize_doi("10.1109/TPEL.2024") == "10.1109/tpel.2024"
    assert normalize_doi("https://doi.org/10.1109/TPEL.2024") == "10.1109/tpel.2024"
    assert normalize_doi("") == ""
    assert normalize_doi(None) == ""


def test_ieee_record_becomes_a_workspace_candidate():
    """The former per-provider ``normalize_record``, now a single conversion."""
    from academia.litreview.candidates import candidate_from_paper
    from academia.sources.ieee import to_paper

    raw = {
        "articleNumber": "1234567",
        "articleTitle": "Test LLC",
        "doi": "10.1109/TPEL.2024.99",
        "publicationYear": "2024",
        "publicationTitle": "IEEE Trans.",
        "contentType": "Journals",
        "htmlLink": "/doc/123",
        "abstract": "test",
        "citationCount": "15",
    }
    candidate = candidate_from_paper(
        to_paper(raw), query_id="Q1", rank=1, page=1, search_expression='("LLC")'
    )
    assert candidate["candidate_id"] == "IEEE-1234567"
    assert candidate["title"] == "Test LLC"
    assert candidate["publication_year"] == 2024
    assert candidate["source_provider"] == "ieee"


def test_a_search_source_no_longer_pretends_to_download():
    """``acquire()`` used to be on the interface and raised NotImplementedError
    in every implementation. Downloading belongs to litreview.acquire."""
    from academia.sources.base import PaperSource

    assert not hasattr(PaperSource, "acquire")
