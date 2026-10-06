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


@pytest.fixture()
def scopus_documents() -> dict:
    """A journal-article search in COMPLETE view — the shape that carries authors."""
    return load_fixture("scopus_documents.json")


@pytest.fixture()
def scopus_authors() -> dict:
    return load_fixture("scopus_authors.json")


@pytest.fixture()
def scopus_author() -> dict:
    """An author-retrieval response, which arrives wrapped in a one-item list."""
    return load_fixture("scopus_author.json")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Fail loudly if a test tries to open a socket."""

    def blocked(*args, **kwargs):
        raise AssertionError("tests must not perform network I/O; use a recorded fixture")

    monkeypatch.setattr("academia.core.http._request", blocked)


@pytest.fixture(autouse=True)
def isolated_facts(tmp_path_factory, monkeypatch):
    """Keep the portable facts inside the test run.

    ``ACADEMIA_FACTS_SYNC`` is set in the shell of anyone who syncs their
    research data, and pytest inherits it. With export on and no data root above
    the test's working directory, ``facts_dir()`` falls back to the home
    directory — so the suite wrote its stub people into the operator's real
    facts folder and merged them back on the next run, which is both a leak and
    a source of order-dependent failures: a fact carrying an OpenAlex id
    overrides the name a stubbed corpus supplies.
    """
    monkeypatch.setenv("ACADEMIA_FACTS_DIR", str(tmp_path_factory.mktemp("facts")))
    monkeypatch.delenv("ACADEMIA_FACTS_SYNC", raising=False)
    monkeypatch.setenv("ACADEMIA_DEVICE", "test-device")


def neutral(policy):
    """The same policy with every eligibility rule switched off.

    Tests of scoring, ordering and column layout want to watch one mechanism at
    a time. The shipped policy states a real editorial stance — activity and the
    journal floor are ``require`` — so borrowing it as a neutral baseline made
    those tests assert the stance rather than the mechanism they are named for.
    Stating "nothing switched on" here keeps that decision in one place.
    """
    from academia.reviewer.policy import Policy

    data = policy.data
    activity = data["activity"]
    return Policy(
        data={
            **data,
            "activity": {
                **activity,
                "mode": "off",
                "relevant": {**activity["relevant"], "mode": "off"},
                "related_journals": {**activity["related_journals"], "mode": "off"},
            },
            "seniority": {
                **data["seniority"],
                "mode": "off",
                "doctoral": {**data["seniority"]["doctoral"], "mode": "off"},
            },
            "geo": {**data["geo"], "restricted": {"mode": "off", "countries": []}},
        },
        sources=policy.sources,
        journal=policy.journal,
    )


def assess(conn, person, policy, *, now_year, relevant_papers=None):
    """Run the eligibility rules against one person.

    The rules take a :class:`CandidateRecord` — one derivation of each quantity,
    shared by every rule — so a test that wants to exercise a rule builds the
    record the pipeline builds. This is that one line, not a compatibility
    shim: passing a connection and a person straight to ``assess`` is what let
    two rules each fetch their own idea of a career length.
    """
    from academia.reviewer.eligibility import assess as run_rules
    from academia.reviewer.record import CandidateRecord

    return run_rules(
        CandidateRecord.build(
            conn, person, relevant_papers=relevant_papers, now_year=now_year
        ),
        policy,
    )
