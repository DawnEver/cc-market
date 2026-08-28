"""Source normalisation, tested against captured live responses.

These assertions encode what each API actually returns, which is not what the
documentation implies. Several of them exist because a live probe contradicted an
assumption: IEEE has no affiliations, OpenAlex has no reliable corresponding
author, ORCID education rows are often missing their degree and dates.
"""

from __future__ import annotations

import pytest

from academia.core.errors import SourceError
from academia.sources import ieee, openalex, orcid

# ------------------------------------------------------------------ IEEE ----


def test_ieee_normalises_a_record(ieee_search):
    papers = [ieee.to_paper(r) for r in ieee_search["records"]]
    assert papers
    first = papers[0]
    assert first.title
    assert first.source == "ieee"
    assert first.url.startswith("https://ieeexplore.ieee.org")


def test_ieee_gives_a_persistent_author_id_on_journal_records(ieee_search):
    """The trade that decides the source hierarchy.

    IEEE hands back a stable author id for free, which feeds disambiguation. It is
    not universal: the capture shows ids on journal and early-access records and
    none on an Artech book, so the id is an opportunistic bonus rather than a
    guaranteed field.
    """
    authors = [a for r in ieee_search["records"] for a in ieee.to_paper(r).authors]
    assert authors
    assert any(a.ieee_author_id for a in authors)


def test_ieee_never_supplies_affiliations(ieee_search):
    """Why OpenAlex, not IEEE, is the source of institutions and countries."""
    authors = [a for r in ieee_search["records"] for a in ieee.to_paper(r).authors]
    assert authors
    assert all(not a.raw_affiliation for a in authors)
    assert all(not a.country_code for a in authors)


def test_ieee_tolerates_a_record_with_no_authors(ieee_search):
    """Conference entries in the capture carry an empty author list."""
    papers = [ieee.to_paper(r) for r in ieee_search["records"]]
    assert any(not p.authors for p in papers)
    assert all(p.title for p in papers)


def test_ieee_search_response_carries_no_index_terms(ieee_search):
    """Controlled vocabulary has to come from OpenAlex keywords/topics."""
    record = ieee_search["records"][0]
    assert not any(key in record for key in ("indexTerms", "thesaurusTerms", "keywords"))


def test_ieee_positions_follow_list_order(ieee_search):
    authors = ieee.to_paper(ieee_search["records"][0]).authors
    assert authors[0].position == "first"
    if len(authors) > 1:
        assert authors[-1].position == "last"


def test_ieee_rejects_a_bot_check_dressed_as_success():
    body = '{"html": "<div>Please verify you are human</div>"}'
    with pytest.raises(SourceError) as excinfo:
        ieee.parse_search_response(body)
    assert excinfo.value.reason == "captcha_or_bot_check"


def test_ieee_parses_a_captured_page(ieee_search):
    import json

    page = ieee.parse_search_response(json.dumps(ieee_search))
    assert page.source == "ieee"
    assert len(page.papers) == len(ieee_search["records"])
    assert page.total_count >= len(page.papers)


# -------------------------------------------------------------- OpenAlex ----


def test_openalex_normalises_a_work(openalex_works):
    paper = openalex.to_paper(openalex_works["results"][0])
    assert paper.title
    assert paper.source == "openalex"
    assert paper.year
    assert paper.authors


def test_openalex_reconstructs_the_inverted_abstract(openalex_works):
    with_abstract = [
        r for r in openalex_works["results"] if r.get("abstract_inverted_index")
    ]
    if not with_abstract:
        pytest.skip("no abstract in this capture")
    paper = openalex.to_paper(with_abstract[0])
    assert len(paper.abstract.split()) > 10


def test_openalex_supplies_country_codes_that_ieee_does_not(openalex_works):
    countries = {
        a.country_code
        for record in openalex_works["results"]
        for a in openalex.to_paper(record).authors
        if a.country_code
    }
    assert countries, "OpenAlex is the primary source of author countries"
    assert all(len(c) == 2 for c in countries)


def test_openalex_scored_keywords_survive_and_noise_is_dropped(openalex_works):
    paper = openalex.to_paper(openalex_works["results"][0])
    kinds = {kind for _, kind, _ in paper.terms}
    assert kinds <= {"keyword", "topic"}
    assert all(
        score is None or score >= openalex.KEYWORD_SCORE_FLOOR
        for _, kind, score in paper.terms
        if kind == "keyword"
    )


def test_openalex_reference_list_is_captured(openalex_works):
    papers = [openalex.to_paper(r) for r in openalex_works["results"]]
    assert any(p.referenced_ids for p in papers)


def test_openalex_search_expression_is_stripped_of_boolean_syntax():
    source = openalex.OpenAlex()
    adapted = source.adapt_expression('"torque ripple" AND (PMSM OR IPMSM)')
    assert "AND" not in adapted and "OR" not in adapted
    assert '"' not in adapted and "(" not in adapted
    assert "torque ripple" in adapted


def test_openalex_author_profile_carries_a_career_timeline(openalex_author):
    person = openalex.to_person(openalex_author)
    assert person.display_name
    assert person.openalex_id
    assert person.affiliations, "affiliations drive both geography and COI"
    assert any(a.year_from for a in person.affiliations)


def test_openalex_marks_exactly_the_last_known_institution_as_current(openalex_author):
    person = openalex.to_person(openalex_author)
    current = [a for a in person.affiliations if a.is_current]
    assert len(current) <= len(openalex_author.get("last_known_institutions", []))
    if current:
        assert person.country_code == current[0].country_code


def test_openalex_person_confidence_reflects_orcid_presence(openalex_author):
    person = openalex.to_person(openalex_author)
    if person.orcid:
        assert person.resolution_method == "orcid"
        assert person.confidence == pytest.approx(0.99)
    else:
        assert person.resolution_method == "openalex_id"


# ----------------------------------------------------------------- ORCID ----


def test_orcid_education_is_parsed_when_present(orcid_educations):
    entries = orcid.parse_educations(orcid_educations, "0000-0000-0000-0000")
    assert entries
    assert all(e.institution for e in entries)
    assert all(e.source == "orcid" for e in entries)
    assert all(e.source_url.startswith("https://orcid.org/") for e in entries)


def test_orcid_education_tolerates_missing_degree_and_dates(orcid_educations):
    """Observed in the wild: an institution with no role title and no years.

    Still worth keeping — same-alma-mater is a real COI signal even without the
    degree — but it is why career history can never be a required field.
    """
    entries = orcid.parse_educations(orcid_educations, "0000-0000-0000-0000")
    assert any(not e.degree or e.year_from is None for e in entries)


def test_orcid_employment_without_an_end_date_counts_as_current(orcid_employments):
    entries = orcid.parse_employments(orcid_employments, "0000-0000-0000-0000")
    assert entries
    for entry in entries:
        assert entry.is_current == (entry.year_to is None)


def test_orcid_only_treats_ror_identifiers_as_ror(orcid_educations):
    """Records disambiguated against RINGGOLD must not masquerade as ROR ids."""
    institutions = orcid.institutions_from(orcid_educations, "education-summary")
    assert institutions
    assert all(not i.ror_id or i.ror_id.startswith("https://ror.org/") for i in institutions)


def test_orcid_empty_record_yields_no_entries():
    empty = {"affiliation-group": []}
    assert orcid.parse_educations(empty, "0000-0000-0000-0000") == []
    assert orcid.parse_employments(empty, "0000-0000-0000-0000") == []


def test_orcid_rejects_a_malformed_identifier():
    assert orcid.Orcid().get_author("not-an-orcid") is None
