"""Scopus: author position, and the evidence that lets a name propose an id.

Every case below encodes a failure that occurred against the live API. The
responses come from ``tests/fixtures/``; the search calls that the candidate
logic makes are monkeypatched, because the point of those tests is the decision
rule, not the transport.
"""

from __future__ import annotations

import pytest

from academia.sources import scopus

# --------------------------------------------------------------- response shape


def test_a_search_finding_nothing_is_not_read_as_one_result(scopus_documents):
    """Zero results arrive as one entry carrying ``error``, not as an empty list.

    This is the defect that cost a live matching pass its matches: code that
    tested the entry list for truthiness saw a result, took it for a profile,
    and reported "no corroboration" for people whose corroboration existed.
    """
    payload = {
        "search-results": {
            "opensearch:totalResults": "0",
            "entry": [{"error": "Result set was empty"}],
        }
    }
    total, entries = scopus._results(payload)
    assert (total, entries) == (0, [])


def test_a_single_result_arrives_as_an_object_and_is_normalised_to_a_list():
    payload = {"search-results": {"opensearch:totalResults": "1", "entry": {"dc:identifier": "X"}}}
    total, entries = scopus._results(payload)
    assert total == 1
    assert entries == [{"dc:identifier": "X"}]


def test_total_results_is_a_string_in_this_api():
    payload = {"search-results": {"opensearch:totalResults": "1929", "entry": []}}
    assert scopus._results(payload)[0] == 1929


def test_an_author_profile_arrives_wrapped_and_is_unwrapped(scopus_author):
    """The same endpoint answered with an object in one probe and a list in another."""
    assert scopus._one(scopus_author)["author-profile"]["preferred-name"]["surname"] == "Kolar"
    assert scopus._one({"author-retrieval-response": [{"a": 1}]}) == {"a": 1}
    assert scopus._one({}) == {}


# ------------------------------------------------------------ author position


def test_document_search_fixture_carries_the_ordered_author_list(scopus_documents):
    """The whole reason this source exists: position is read, not inferred.

    ``view=COMPLETE`` returns each author slot with an ``authid`` and a 1-based
    ``@seq``, so "first-author papers" is a count rather than an estimate.
    """
    entries = scopus_documents["search-results"]["entry"]
    paper = scopus.to_paper(entries[0])
    first, last = paper.authors[0], paper.authors[-1]

    assert first.position == "first" and last.position == "last"
    assert first.idx == 0 and last.idx == len(paper.authors) - 1
    assert first.scopus_id
    assert scopus.author_position(entries[0], first.scopus_id) == "first"
    assert scopus.author_position(entries[0], last.scopus_id) == "last"


def test_author_position_is_empty_for_someone_not_on_the_document(scopus_documents):
    """Empty, not "middle": a stranger is not a middle author."""
    record = scopus_documents["search-results"]["entry"][0]
    assert scopus.author_position(record, "99999999999") == ""


def test_a_document_listing_no_authors_yields_no_first_author():
    """An absent author list must not promote anybody to first."""
    assert scopus.author_position({"dc:identifier": "SCOPUS_ID:1"}, "1") == ""
    assert scopus.to_paper({"dc:identifier": "SCOPUS_ID:1"}).authors == []


def test_journal_typing_separates_an_article_from_a_conference_paper():
    article = {"subtypeDescription": "Article", "prism:aggregationType": "Journal"}
    review = {"subtypeDescription": "Review", "prism:aggregationType": "Journal"}
    conference = {"subtypeDescription": "Conference Paper", "prism:aggregationType": "Conference Proceeding"}
    assert scopus.is_journal_article(article) and scopus.is_journal_article(review)
    assert not scopus.is_journal_article(conference)


# ------------------------------------------------------------------- queries


def test_adapt_expression_scopes_a_bare_expression_and_leaves_a_scoped_one():
    """Scopus has no unqualified full-text search; sending one is a syntax error."""
    scoped = scopus.Scopus().adapt_expression('"torque ripple" AND "axial flux"')
    assert scoped == 'TITLE-ABS-KEY("torque ripple" AND "axial flux")'
    already = "AU-ID(123) AND SRCTYPE(j)"
    assert scopus.Scopus().adapt_expression(already) == already


def test_coauthorship_query_pairs_an_id_with_a_name_and_never_two_names():
    """Two bare ``AUTH()`` terms do not intersect — they return unrelated work.

    A live probe for ``AUTH(kumar) AND AUTH(clare)`` answered with *Genome
    Biology* and *Physical Review Letters*, documents containing neither name,
    which silently made every candidate look corroborated or none did. Only
    ``AU-ID`` anchors the conjunction to a real person.
    """
    query = scopus.coauthorship_query("123", ["Sumner, M.", "Clare, J."])
    assert query.startswith("AU-ID(123)")
    assert query.count("AUTH(") == 2
    assert "AUTH(sumner)" in query and "AUTH(clare)" in query
    assert "AUTHLAST" not in query


def test_coauthorship_query_without_names_is_the_author_alone():
    assert scopus.coauthorship_query("123", []) == "AU-ID(123)"


# ----------------------------------------------------------------- candidates


def _author_entry(scopus_id: str, surname: str, given: str, count: str = "4") -> dict:
    return {
        "dc:identifier": f"AUTHOR_ID:{scopus_id}",
        "document-count": count,
        "preferred-name": {"surname": surname, "given-name": given},
    }


@pytest.fixture()
def searches(monkeypatch):
    """Stub the two calls the candidate logic makes, and record their queries."""
    calls: dict[str, list[str]] = {"authors": [], "counted": []}
    answers: dict[str, object] = {"authors": [], "counts": {}}

    def fake_authors(query, **kwargs):
        calls["authors"].append(query)
        return len(answers["authors"]), answers["authors"]

    def fake_count(query, **kwargs):
        calls["counted"].append(query)
        author_id = query.split("AU-ID(", 1)[1].split(")", 1)[0]
        return answers["counts"].get(author_id, 0)

    monkeypatch.setattr(scopus, "search_authors", fake_authors)
    monkeypatch.setattr(scopus, "count_documents", fake_count)
    return calls, answers


def test_author_search_sends_one_given_name(searches):
    """``AUTHFIRST`` matches a single given name and finds nothing for two.

    Passing the whole given-name string is not a wider search, it is an empty
    one: ``AUTHLAST("agbedahunsi") AND AUTHFIRST("alex taiwo")`` returned no
    profiles at all while the person's profile existed.
    """
    calls, answers = searches
    answers["authors"] = []
    scopus.find_author_candidates("Agbedahunsi, Alex Taiwo")
    assert 'AUTHFIRST("alex")' in calls["authors"][0]
    assert "alex taiwo" not in calls["authors"][0]


def test_an_affiliation_narrowing_that_finds_nobody_widens_in_stages(searches):
    """A graduate who has since moved is still the person.

    The stages widen in one direction only — drop the affiliation, then the
    given name — because dropping the given name is by far the widest: on a
    common surname it returns a page of namesakes, and each one then costs a
    corroboration query.
    """
    calls, _answers = searches
    scopus.find_author_candidates("Wang, Peng", affiliation="Nottingham")
    assert "AFFIL(Nottingham)" in calls["authors"][0]
    assert calls["authors"][1] == 'AUTHLAST("wang") AND AUTHFIRST("peng")'
    assert calls["authors"][2] == 'AUTHLAST("wang")'


def test_only_profiles_sharing_a_document_with_a_corroborator_are_returned(searches):
    """The evidence is the admission test; an uncorroborated namesake is not a lead."""
    _calls, answers = searches
    answers["authors"] = [
        _author_entry("111", "Kumar", "Dinesh"),
        _author_entry("222", "Kumar", "Dinesh"),
    ]
    answers["counts"] = {"111": 0, "222": 5}

    found = scopus.find_author_candidates("Kumar, Dinesh", corroborators=["Clare, J."])
    assert [c.scopus_id for c in found] == ["222"]
    assert found[0].shared_documents == 5
    assert found[0].evidence == "corroborated"
    assert found[0].person.resolution_method == "scopus_id"


def test_candidates_are_ranked_by_the_evidence_behind_them(searches):
    _calls, answers = searches
    answers["authors"] = [
        _author_entry("111", "Smith", "John"),
        _author_entry("222", "Smith", "John"),
    ]
    answers["counts"] = {"111": 2, "222": 7}
    found = scopus.find_author_candidates("Smith, John", corroborators=["Jones, A."])
    assert [c.scopus_id for c in found] == ["222", "111"]


def test_a_profile_whose_own_spelling_disagrees_with_the_record_is_not_a_candidate(searches):
    _calls, answers = searches
    answers["authors"] = [_author_entry("111", "Kumar", "Dinesh"), _author_entry("222", "Kumar", "Ravi")]
    answers["counts"] = {"111": 3, "222": 3}
    found = scopus.find_author_candidates("Kumar, Dinesh", corroborators=["Clare, J."])
    assert [c.scopus_id for c in found] == ["111"]


def test_a_two_word_surname_is_not_trimmed_to_its_first_word(searches):
    """The trap that lost a live match, at the point where it did the damage.

    Scopus separates the surname itself, so ``surname="Donoso Merlet"`` must be
    taken whole; re-splitting it finds no comma, takes "Donoso", and the profile
    that had already been identified stops matching its roster entry.
    """
    _calls, answers = searches
    answers["authors"] = [_author_entry("111", "Donoso Merlet", "Felipe")]
    answers["counts"] = {"111": 1}
    found = scopus.find_author_candidates("Donoso Merlet, Felipe Octavio", corroborators=["Watson, A."])
    assert [c.scopus_id for c in found] == ["111"]


# -------------------------------------------------------------------- admission


def _candidate(scopus_id: str, shared: int) -> scopus.AuthorCandidate:
    from academia.core.models import Person

    return scopus.AuthorCandidate(
        Person(person_id=f"person-{scopus_id}", display_name="X", scopus_id=scopus_id),
        shared,
        "corroborated",
    )


def test_admit_takes_the_single_supported_candidate():
    only = _candidate("111", 4)
    assert scopus.admit_candidate([only]) is only


def test_admit_refuses_two_candidates_supported_equally():
    """A tie is an answer: it is "not this one", and saying so is the point.

    Guessing between two equally supported profiles attaches one person's
    publication record to another, and a missing count is recoverable in a way
    a wrong one is not.
    """
    assert scopus.admit_candidate([_candidate("111", 3), _candidate("222", 3)]) is None


def test_admit_breaks_a_tie_only_on_strictly_more_evidence():
    chosen = scopus.admit_candidate([_candidate("111", 5), _candidate("222", 2)])
    assert chosen is not None and chosen.scopus_id == "111"


def test_admit_returns_none_when_nothing_was_proposed():
    assert scopus.admit_candidate([]) is None
    assert scopus.admit_candidate([_candidate("111", 0)]) is None


# ------------------------------------------------------------------- identity


def test_an_uncorroborated_profile_is_a_candidate_not_an_identity(scopus_authors):
    """A name search must not be able to mint identity.

    The id is real and recorded, but the rung it earns is ``name_only`` — the
    same low-confidence rung the store already uses — until evidence raises it.
    """
    person = scopus.to_person(scopus_authors["search-results"]["entry"][0])
    assert person.scopus_id
    assert person.resolution_method == "name_only"
    assert person.confidence < 0.5


def test_a_corroborated_profile_records_the_scopus_id_rung(scopus_authors):
    person = scopus.to_person(scopus_authors["search-results"]["entry"][0], corroborated=True)
    assert person.resolution_method == "scopus_id"
    assert person.confidence == 0.85


def test_an_author_profile_fixture_parses(scopus_author):
    person = scopus.to_person(scopus._one(scopus_author), corroborated=True)
    assert person.scopus_id
    assert person.display_name
    # A career total is not a per-year series, so it is left empty rather than
    # put in a field every later sum would read as one year's output.
    assert person.works_by_year == {}
