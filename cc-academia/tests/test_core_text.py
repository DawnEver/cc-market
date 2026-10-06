"""Text normalisation is the substrate every dedupe and match decision sits on."""

from __future__ import annotations

import pytest

from academia.core import text


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("https://doi.org/10.1109/TIE.2024.1234", "10.1109/tie.2024.1234"),
        ("http://dx.doi.org/10.1109/ABC", "10.1109/abc"),
        ("doi: 10.1109/XYZ.", "10.1109/xyz"),
        ("  10.1109/Q  ", "10.1109/q"),
        (None, ""),
    ],
)
def test_normalize_doi(raw, expected):
    assert text.normalize_doi(raw) == expected


def test_normalize_title_folds_accents_and_punctuation():
    assert text.normalize_title("Résumé of PM-Motors: A Review!") == "resume of pm motors a review"


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("0000-0002-1825-0097", "0000-0002-1825-0097"),
        ("https://orcid.org/0000-0002-1825-0097", "0000-0002-1825-0097"),
        ("0000000218250097", "0000-0002-1825-0097"),
        ("000X", ""),
    ],
)
def test_normalize_orcid(raw, expected):
    assert text.normalize_orcid(raw) == expected


def test_normalize_name_reorders_surname_first_form():
    assert text.normalize_name("Wang, Jian") == text.normalize_name("Jian Wang")


def test_tokenize_drops_scholarly_stop_words():
    tokens = text.tokenize("A Novel Approach to the Analysis of Torque Ripple")
    assert "torque" in tokens and "ripple" in tokens
    assert "novel" not in tokens and "the" not in tokens


def test_term_overlap_is_symmetric_and_bounded():
    a = ["Torque ripple", "Direct torque control"]
    b = ["direct torque control", "Field weakening"]
    assert text.term_overlap(a, b) == text.term_overlap(b, a)
    assert 0.0 < text.term_overlap(a, b) < 1.0
    assert text.term_overlap([], b) == 0.0


def test_recency_score_decays_and_clamps():
    assert text.recency_score(2026, 2026) == 1.0
    assert text.recency_score(2027, 2026) == 1.0
    assert text.recency_score(2016, 2026) == 0.0
    assert text.recency_score(None, 2026) == 0.0
    assert 0.4 < text.recency_score(2021, 2026) < 0.6


def test_invert_abstract_restores_word_order():
    index = {"torque": [0, 3], "ripple": [1], "in": [2], "motors": [4]}
    assert text.invert_abstract(index) == "torque ripple in torque motors"
    assert text.invert_abstract(None) == ""


def test_dedupe_merges_on_shared_doi_and_keeps_richest_record():
    records = [
        {"source": "ieee", "doi": "10.1109/A", "title": "Torque ripple", "abstract": "full text"},
        {"source": "openalex", "doi": "https://doi.org/10.1109/A", "title": "Torque ripple", "venue": "TIE"},
    ]
    merged = text.dedupe_records(records)
    assert len(merged) == 1
    assert merged[0]["abstract"] == "full text"
    assert merged[0]["venue"] == "TIE"
    assert merged[0]["merged_from"] == ["ieee", "openalex"]


def test_dedupe_bridges_a_doi_less_record_through_a_shared_title():
    records = [
        {"source": "ieee", "doi": "10.1109/A", "title": "Sensorless control", "year": 2024},
        {"source": "dblp", "title": "Sensorless Control", "year": 2024},
        {"source": "arxiv", "title": "Something else", "year": 2024},
    ]
    merged = text.dedupe_records(records)
    assert len(merged) == 2


def test_dedupe_keeps_distinct_papers_apart():
    records = [
        {"source": "a", "doi": "10.1/x", "title": "One"},
        {"source": "b", "doi": "10.1/y", "title": "Two"},
    ]
    assert len(text.dedupe_records(records)) == 2


# ----------------------------------------------------- vocabulary overlap


def test_word_overlap_matches_across_differing_phrasings():
    """Exact-phrase overlap cannot connect two vocabularies for the same field.

    OpenAlex labels a person with its own coarse taxonomy ("Electric Motor
    Design and Analysis") while a manuscript supplies author keywords ("axial
    flux permanent magnet machine"). Compared as whole strings the two never
    intersect, which left the topic and method components — 60% of the ranking
    weight — reading 0.00 for every candidate in a live run.
    """
    from academia.core.text import word_overlap

    profile = ["axial flux permanent magnet machine", "electromagnetic noise"]
    close = ["axial flux machine design", "acoustic noise of electromagnetic origin"]
    far = ["smart grid energy management", "induction heating"]

    assert word_overlap(close, profile) > word_overlap(far, profile)
    assert word_overlap(far, profile) == 0.0


def test_word_overlap_ignores_connective_words():
    from academia.core.text import word_overlap

    assert word_overlap(["design and analysis of the grid"], ["axial flux machine"]) == 0.0


def test_word_overlap_is_zero_when_either_side_is_empty():
    from academia.core.text import word_overlap

    assert word_overlap([], ["axial flux"]) == 0.0
    assert word_overlap(["axial flux"], []) == 0.0


# ------------------------------------------------------- personal names
#
# These exist for matching a thesis record to an author profile, where a name
# is the only search key available. Every case below is one a live harvest hit.


def test_split_person_name_keeps_a_two_word_surname_together():
    """A compound surname is one word to its owner and two to a tokeniser.

    "Donoso Merlet, Felipe Octavio" taken by first token becomes "Donoso" and
    the person is never found again. The comma is what says the surname runs
    to it.
    """
    assert text.split_person_name("Donoso Merlet, Felipe Octavio") == (
        "donoso merlet",
        "felipe octavio",
    )


@pytest.mark.parametrize(
    "raw",
    ["Zhu, Zi-Qiang", "ZHU Z.Q.", "zhu  z.q.", "Prof. Zhu, Zi-Qiang", "Zhu, Zi Qiang (née Wu)"],
)
def test_every_spelling_of_a_name_folds_to_one_key(raw):
    """Repositories and author lists punctuate the same person differently.

    A key built from one spelling has to equal the key built from the others,
    or a supervisor match silently fails depending on which record was read.
    """
    surname, given = text.split_person_name(raw)
    assert text.person_name_key(surname, given) == ("zhu", "z")


def test_split_person_name_drops_a_title_and_a_parenthetical():
    assert text.split_person_name("Dr. Gerada, Chris") == ("gerada", "chris")
    assert text.split_person_name("Al-Lehaby (Mohammed), Ibrahim Khalaf") == (
        "al lehaby",
        "ibrahim khalaf",
    )


def test_person_name_key_separates_initials_and_nothing_finer():
    """The key is a filter, so its looseness is part of the contract.

    It separates "Wang, Bo" from "Wang, Ci" and deliberately does *not*
    separate "Bo" from "Bei": dozens of researchers share a surname and an
    initial, and a key that pretended otherwise would be making a claim it
    cannot support. Evidence decides between them, never the key.
    """
    assert text.person_name_key("Wang", "Bo") != text.person_name_key("Wang", "Ci")
    assert text.person_name_key("Wang", "Bo") == text.person_name_key("Wang", "Bei")
    assert text.person_name_key("Wang", "Bo") == text.person_name_key("Wang", "B.")


def test_person_name_key_does_not_re_split_a_surname_a_source_already_gave():
    """The trap that lost a live match: Scopus says ``surname="Donoso Merlet"``.

    Running that through ``split_person_name`` would find no comma and take
    "Donoso" for the surname, so the profile that was already identified by id
    stopped matching the roster.
    """
    assert text.person_name_key("Donoso Merlet", "Felipe") == ("donoso merlet", "f")


def test_name_keys_holds_both_readings_only_when_the_order_is_unknown():
    """"Geraint Jewell" and "Zhu Zi-Qiang" are one shape and two orders.

    Both spellings occur in the repositories, so the comparison has to hold
    both readings. A comma settles the order, and then there is only one.
    """
    assert text.name_keys("Jewell, Geraint") == {("jewell", "g")}
    assert text.name_keys("Geraint Jewell") == {("jewell", "g"), ("geraint", "j")}


def test_name_keys_connect_the_spellings_a_repository_actually_writes():
    """The comparison is set intersection, so either signature suffices.

    "Geraint Jewell" and "Jewell, Geraint" are the same person written by two
    repositories; "Zhu, Zi-Qiang" and "ZHU Z.Q." are that person written twice
    by one. Both pairs have to intersect or the match is lost on punctuation.
    """
    assert text.name_keys("Geraint Jewell") & text.name_keys("Jewell, Geraint")
    assert text.name_keys("Zhu, Zi-Qiang") & text.name_keys("ZHU Z.Q.")
    # and the intersections must not swallow unrelated people
    assert not text.name_keys("Wang, Bo") & text.name_keys("Wang, Ci")
