"""Text normalisation, identifier hygiene and record de-duplication.

Shared by literature search and reviewer discovery — both need to decide whether
two records describe the same paper, and both need the same answer.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable
from typing import Any

_DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", re.IGNORECASE)
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
_WORD = re.compile(r"[a-z0-9][a-z0-9\-']*")

#: Stop words tuned for scholarly titles rather than prose.
STOP_WORDS = frozenset(
    ["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "into", "is", "it", "its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "which", "with", "using", "based", "via", "toward", "towards", "new", "novel", "study", "analysis", "approach", "method", "paper", "letter", "article", "research"]
)


def as_text(value: Any) -> str:
    return str(value or "").strip()


def optional_int(value: Any) -> int | None:
    text = as_text(value)
    if not text:
        return None
    try:
        return int(float(text))
    except ValueError:
        return None


def normalize_doi(value: Any) -> str:
    """Strip resolver prefixes and trailing punctuation; lowercase."""
    return _DOI_PREFIX.sub("", as_text(value).lower()).rstrip(" ./")


def normalize_title(value: Any) -> str:
    """Aggressive title key for de-duplication: fold accents, drop punctuation."""
    text = unicodedata.normalize("NFKD", as_text(value).lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return _NON_ALNUM.sub(" ", text).strip()


def normalize_orcid(value: Any) -> str:
    """Reduce any ORCID form (URL, dashed, bare) to the canonical dashed id."""
    digits = re.sub(r"[^0-9X]", "", as_text(value).upper())
    if len(digits) != 16:
        return ""
    return "-".join(digits[i : i + 4] for i in range(0, 16, 4))


def normalize_name(value: Any) -> str:
    """Case- and accent-insensitive personal-name key.

    Only ever a *tiebreaker*: name matching alone is not identity. A live probe
    for "Jianmin Du" returned a remote-sensing researcher in an unrelated field.
    """
    text = unicodedata.normalize("NFKD", as_text(value).lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = _NON_ALNUM.sub(" ", text).strip()
    if "," in as_text(value):  # "Wang, Jian" -> "jian wang"
        parts = [p.strip() for p in normalize_title(value).split(" ") if p.strip()]
        if len(parts) >= 2:
            text = " ".join(parts[1:] + parts[:1])
    return text


_TITLES = re.compile(r"\b(dr|prof|professor|mr|mrs|ms|miss)\b\.?", re.IGNORECASE)
_PARENTHETICAL = re.compile(r"\(.*?\)")


def _fold(value: Any) -> str:
    """Lowercase, accent-folded, punctuation-free words. Idempotent."""
    text = unicodedata.normalize("NFKD", as_text(value).lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return " ".join(_NON_ALNUM.sub(" ", text).split())


def split_person_name(value: Any) -> tuple[str, str]:
    """Split a personal name into ``(surname, given)``, both folded.

    Repositories and author lists write names every way there is — "Zhu,
    Zi-Qiang", "ZHU Z.Q.", "Gerada, C.", a title in front, a parenthetical
    former name in the middle — so neither a comma nor a word order may be
    assumed. Titles and parentheticals go first, and a full stop becomes a
    space, which is what lets "ZHU Z.Q." and "Zhu, Zi-Qiang" fold to the same
    surname and the same given-name initial.

    Without a comma the first word is taken as the surname, which fits
    "Surname Initials" — how repositories write supervisors — and misfits a
    western name in the other order. That ambiguity is not resolvable from the
    string, so callers that must not lose matches should compare over
    :func:`name_variants` instead of a single reading.
    """
    text = _PARENTHETICAL.sub(" ", as_text(value))
    text = _TITLES.sub(" ", text).replace(".", " ")
    surname, comma, given = text.partition(",")
    if not comma:
        parts = text.split()
        surname, given = (parts[0], " ".join(parts[1:])) if parts else ("", "")
    return _fold(surname), _fold(given)


def person_name_readings(value: Any) -> list[tuple[str, str]]:
    """Every ``(surname, given)`` reading a name could have, both folded.

    A comma settles the order and yields one reading; without one the string is
    genuinely undecidable and yields two. Callers that need the whole given name
    — to compare against a list of given-name prefixes, say — want this rather
    than :func:`name_keys`, which keeps only the initial.
    """
    surname, given = split_person_name(value)
    if not surname or not given or "," in as_text(value):
        return [(surname, given)]
    return [(surname, given), (given, surname)]


def name_keys(value: Any) -> set[tuple[str, str]]:
    """Every key a name could yield, as a set of possibilities.

    A comma settles the word order; without one it is genuinely undecidable,
    and "Geraint Jewell" and "Zhu Zi-Qiang" have the same shape and opposite
    orders. Both spellings occur in the thesis repositories, so a comparison
    that insisted on one reading would silently lose half the matches it
    exists to find. Two names match when their sets intersect::

        name_keys("Jewell, Geraint") & name_keys("Geraint Jewell")  # non-empty

    Returning a set rather than a single value is the honest shape — the
    string does not determine the answer, so neither does this function.
    """
    return {person_name_key(*reading) for reading in person_name_readings(value)}


def person_name_key(surname: Any, given: Any) -> tuple[str, str]:
    """Surname plus the initial of the given names.

    A filter for narrowing a candidate list, never an identity: it separates
    "Wang, Bo" from "Wang, Bei" and does nothing at all about the dozens of
    researchers who share both. A match is a question to answer with evidence.

    The surname is taken as given rather than re-split, because a source that
    separates it must not be second-guessed: Scopus reports
    ``surname="Donoso Merlet"``, and passing that through
    :func:`split_person_name` would take "Donoso" for the surname and lose the
    person entirely.
    """
    folded = _fold(given)
    return _fold(surname), folded[:1]


def tokenize(text: str) -> list[str]:
    """Lowercase content words, stop words removed."""
    return [w for w in _WORD.findall(as_text(text).lower()) if w not in STOP_WORDS and len(w) > 1]


def term_overlap(left: Iterable[str], right: Iterable[str]) -> float:
    """Jaccard overlap over normalised term sets. 0.0 when either side is empty."""
    a = {normalize_title(t) for t in left if as_text(t)}
    b = {normalize_title(t) for t in right if as_text(t)}
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def word_overlap(left: Iterable[str], right: Iterable[str]) -> float:
    """How much of ``right``'s vocabulary ``left`` covers, word by word.

    Whole-phrase comparison cannot connect two vocabularies describing the same
    field: OpenAlex labels people with its own coarse taxonomy while a
    manuscript arrives with author keywords, and the two never share a string.
    Coverage of ``right`` rather than Jaccard, because a prolific candidate's
    long term list should not be penalised for covering more than one field.
    """
    a = {word for term in left for word in tokenize(term)}
    b = {word for term in right for word in tokenize(term)}
    if not a or not b:
        return 0.0
    return len(a & b) / len(b)


def recency_score(year: int | None, now_year: int, window: int = 10) -> float:
    """Linear decay over ``window`` years; future dates clamp to 1.0."""
    if year is None:
        return 0.0
    age = now_year - year
    if age <= 0:
        return 1.0
    return max(0.0, 1.0 - age / window)


def invert_abstract(inverted_index: dict[str, list[int]] | None) -> str:
    """Rebuild plain text from an OpenAlex ``abstract_inverted_index``."""
    if not inverted_index:
        return ""
    positions: dict[int, str] = {}
    for word, spots in inverted_index.items():
        for spot in spots:
            positions[spot] = word
    if not positions:
        return ""
    return " ".join(positions[i] for i in sorted(positions))


def record_keys(record: dict[str, Any]) -> list[str]:
    """Identity keys for de-duplication, strongest first."""
    keys: list[str] = []
    doi = normalize_doi(record.get("doi"))
    if doi:
        keys.append(f"doi:{doi}")
    title = normalize_title(record.get("title"))
    year = record.get("year") or record.get("publication_year")
    if title:
        keys.append(f"title:{title}|{year or ''}")
    return keys


def _completeness(record: dict[str, Any]) -> tuple[int, ...]:
    """Rank records so the merge keeps the richest field values."""
    return (
        1 if as_text(record.get("abstract")) else 0,
        1 if normalize_doi(record.get("doi")) else 0,
        1 if record.get("authors") else 0,
        1 if as_text(record.get("venue")) else 0,
        len(record.get("terms") or []),
    )


def dedupe_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Merge records describing the same paper.

    Union-find over DOI and title keys: two records collapse when they share any
    key, which lets a DOI-bearing IEEE record absorb a DOI-less OpenAlex one that
    happens to share a title.
    """
    parent: dict[str, str] = {}

    def find(key: str) -> str:
        parent.setdefault(key, key)
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    slots: list[str] = []
    for index, record in enumerate(records):
        own = f"row:{index}"
        find(own)
        for key in record_keys(record):
            union(own, key)
        slots.append(own)

    groups: dict[str, list[dict[str, Any]]] = {}
    for slot, record in zip(slots, records, strict=True):
        groups.setdefault(find(slot), []).append(record)

    merged: list[dict[str, Any]] = []
    for group in groups.values():
        best = max(group, key=_completeness)
        combined = dict(best)
        for other in group:
            for field, value in other.items():
                if not as_text(combined.get(field)) and as_text(value):
                    combined[field] = value
        combined["merged_from"] = sorted({r.get("source", "") for r in group if r.get("source")})
        merged.append(combined)
    return merged
