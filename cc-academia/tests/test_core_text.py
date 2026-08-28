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
