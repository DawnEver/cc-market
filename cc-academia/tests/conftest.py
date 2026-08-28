"""Shared fixtures.

Every source test runs against a captured response under ``tests/fixtures/``.
Re-record with ``python scripts/record_fixtures.py`` when a source changes shape;
the suite itself must never reach the network, so a broken API breaks the
recording step rather than the build.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURE_DIR = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


@pytest.fixture()
def ieee_search() -> dict:
    return load_fixture("ieee_search.json")


@pytest.fixture()
def openalex_works() -> dict:
    return load_fixture("openalex_works.json")


@pytest.fixture()
def openalex_author() -> dict:
    return load_fixture("openalex_author.json")


@pytest.fixture()
def orcid_educations() -> dict:
    return load_fixture("orcid_educations.json")


@pytest.fixture()
def orcid_employments() -> dict:
    return load_fixture("orcid_employments.json")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Fail loudly if a test tries to open a socket."""

    def blocked(*args, **kwargs):
        raise AssertionError("tests must not perform network I/O; use a recorded fixture")

    monkeypatch.setattr("academia.core.http._request", blocked)
