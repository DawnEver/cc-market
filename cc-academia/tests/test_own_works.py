"""A candidate with no evidence in this run gets their own works scored.

Missing evidence must not pass: someone proposed from outside the harvest — an
imported reviewer finder, say — is judged on their own record, scored by the
same relevance code as everybody else. Only when no record can be obtained do
the relevance rules abstain, and then the editor is asked to check.
"""

from __future__ import annotations

import pytest

from academia.core.models import Affiliation, Author, Paper, Person
from academia.referee import discover
from academia.referee.profile import Profile
from academia.store import db
from academia.store import repository as repo


@pytest.fixture()
def conn(tmp_path):
    with db.session(tmp_path / "store.db") as connection:
        yield connection


PROFILE = Profile(
    manuscript_id="ms-1",
    title_hash="h",
    journal="tec",
    year=2026,
    primary_topics=["stator core", "interlaminar fault"],
)


def _paper(doi, title, author, year=2025, venue_type="article"):
    paper = Paper.build(title=title, source="openalex", doi=doi, year=year, venue="J Ex")
    paper.venue_type = venue_type
    paper.abstract = title
    paper.authors = [author]
    return paper


class FakeOpenAlex:
    def __init__(self, works, *, by_orcid=None, by_name=()):
        self.works, self.by_orcid, self.by_name = works, by_orcid, list(by_name)
        self.searched = []

    def find_author_by_orcid(self, orcid):
        return self.by_orcid

    def search_authors(self, name, *, limit=10):
        self.searched.append(name)
        return self.by_name

    def get_author_papers(self, author_id, *, limit=50):
        return self.works


def _person(conn, name, **ids):
    return repo.load_person(conn, repo.upsert_person(conn, Author(name=name, idx=0, **ids)))


def test_works_found_by_orcid_become_evidence(conn):
    erin = _person(conn, "Erin Imaginary", orcid="0000-0000-0000-0001")
    me = Author(name="Erin Imaginary", idx=0, position="first", openalex_id="A-erin")
    works = [
        _paper("10.0/1", "Stator core interlaminar fault detection", me),
        _paper("10.0/2", "Interlaminar fault in a stator core under test", me),
        _paper("10.0/3", "Something unrelated about batteries", me),
    ]
    client = FakeOpenAlex(
        works, by_orcid=Person(person_id="x", display_name="", openalex_id="A-erin")
    )

    fetched = discover.fetch_own_works(conn, erin, client)
    assert len(fetched) == 3
    scores = discover.relevance(conn, PROFILE, now_year=2026, limit=300)
    found = discover.evidence_for(conn, scores, [erin.person_id])
    evidence, relevant = found[erin.person_id]
    assert {e.doi for e in relevant} == {"10.0/1", "10.0/2"}
    assert evidence and all(e.similarity > 0 for e in evidence)
    assert all(e.venue_type == "article" for e in relevant)


def test_a_name_search_needs_the_institution_to_agree(conn):
    frank = _person(conn, "Frank Madeup")
    repo.store_institution_for(conn, frank.person_id, name="University of Example", is_current=True)
    frank = repo.load_person(conn, frank.person_id)
    me = Author(name="Frank Madeup", idx=0, openalex_id="A-frank")
    elsewhere = Person(person_id="p2", display_name="Frank Madeup", openalex_id="A-other")
    elsewhere.affiliations = [
        Affiliation(inst_id="i2", institution="Other University", is_current=True)
    ]
    here = Person(person_id="p1", display_name="Frank Madeup", openalex_id="A-frank")
    here.affiliations = [
        Affiliation(inst_id="i1", institution="University of Example", is_current=True)
    ]
    works = [_paper("10.0/4", "Stator core interlaminar fault", me)]

    assert (
        len(discover.fetch_own_works(conn, frank, FakeOpenAlex(works, by_name=[elsewhere, here])))
        == 1
    )
    stored = repo.load_person(conn, frank.person_id)
    assert stored.openalex_id == "A-frank"
    # A name proposed the id; it did not make the identity certain.
    assert stored.resolution_method == "name_only"


def test_an_ambiguous_or_uncorroborated_name_fetches_nothing(conn):
    frank = _person(conn, "Frank Madeup")
    one = Person(person_id="p1", display_name="Frank Madeup", openalex_id="A-1")
    client = FakeOpenAlex([_paper("10.0/5", "x", Author(name="F", idx=0))], by_name=[one])
    # No stored institution to corroborate the match: refused.
    assert discover.fetch_own_works(conn, frank, client) == []
    assert repo.load_person(conn, frank.person_id).openalex_id == ""


def test_without_relevant_works_the_journal_rule_asks_for_a_check(conn):
    from academia.referee import eligibility
    from academia.referee.policy import load_policy
    from academia.referee.record import CandidateRecord

    policy = load_policy("tec")
    person = _person(conn, "No Record")
    record = CandidateRecord.build(conn, person, relevant_papers=[], now_year=2026)
    for name in ("related_journals", "relevant_activity"):
        rule = dict(eligibility.RULES)[name]
        outcome = rule(record, policy.constraint(name))
        assert outcome.manual_review, name
        assert eligibility.verdict_of(outcome) == eligibility.VERIFY
