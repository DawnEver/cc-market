"""Academic rank — professor, lecturer, postdoc, or student.

The candidate pool is built from authorship, so it contains every student who
ever appeared on a paper alongside the people an editor would actually invite.
Without a rank the shortlist has to be checked by hand, which is most of the
work the tool exists to remove.

Rank is *found*, never inferred. It comes from a stated job title — an ORCID
employment record's ``role-title``, or one an editor supplies — and carries the
source that said so. A long publication record does not make someone a
professor, and an empty ORCID record does not make them a student: unknown
stays unknown, and never counts against anybody.

Reading the rank out of a fetched staff page was tried and removed. Anchoring on
the person's name and reading the text that follows gave "MSc student" for an
associate professor whose page mentions supervising graduate students, and
"unknown" for a full professor whose page states the title above the name. A
confidently wrong rank is worse than a blank one, because an editor acts on it
and skips a good reviewer without ever seeing why.
"""

from __future__ import annotations

import re

PROFESSOR = "professor"
ASSOCIATE_PROFESSOR = "associate_professor"
ASSISTANT_PROFESSOR = "assistant_professor"
SENIOR_LECTURER = "senior_lecturer"
LECTURER = "lecturer"
POSTDOC = "postdoc"
RESEARCHER = "researcher"
ENGINEER = "engineer"
PHD_STUDENT = "phd_student"
MSC_STUDENT = "msc_student"
UNKNOWN = "unknown"

#: Every rank this module recognises, for validating a supplied one.
KNOWN_RANKS = frozenset(
    {
        PROFESSOR,
        ASSOCIATE_PROFESSOR,
        ASSISTANT_PROFESSOR,
        SENIOR_LECTURER,
        LECTURER,
        POSTDOC,
        RESEARCHER,
        ENGINEER,
        PHD_STUDENT,
        MSC_STUDENT,
    }
)

#: Ordered by seniority for reporting and for picking the best of a career
#: history. Not a quality ranking: a senior engineer in industry may be the
#: better reviewer, which is why nothing here filters anyone out on its own.
_SENIORITY = {
    PROFESSOR: 100,
    ASSOCIATE_PROFESSOR: 80,
    ASSISTANT_PROFESSOR: 60,
    SENIOR_LECTURER: 70,
    LECTURER: 55,
    RESEARCHER: 45,
    ENGINEER: 40,
    POSTDOC: 30,
    PHD_STUDENT: 20,
    MSC_STUDENT: 10,
    UNKNOWN: 0,
}

#: Most specific first: "associate professor" has to be tested before
#: "professor", or every junior academic is promoted to a chair.
_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\b(assoc\w*)[\s.]+prof", ASSOCIATE_PROFESSOR),
    (r"\b(assist\w*|asst)[\s.]+prof", ASSISTANT_PROFESSOR),
    (r"\bsenior\s+lecturer\b", SENIOR_LECTURER),
    (r"\b(ph\.?\s?d\.?|doctoral)\s+(student|candidate|researcher)\b", PHD_STUDENT),
    (r"\bdoctoral\s+candidate\b", PHD_STUDENT),
    (r"\b(m\.?sc\.?|master'?s?|graduate)\s+student\b", MSC_STUDENT),
    (r"\bpost[\s-]?doc", POSTDOC),
    (r"\bprofessor\b|\bprof\.", PROFESSOR),
    (r"\blecturer\b", LECTURER),
    (r"\bresearch\s+(scientist|fellow|associate)\b|\bresearcher\b", RESEARCHER),
    (r"\bengineer\b", ENGINEER),
)


#: Values that mean "nothing stated" in a free-text ORCID field. One live record
#: holds the single character 无.
_PLACEHOLDERS = frozenset({"", "-", "--", "n/a", "na", "none", "nil", "无"})


def clean_title(text: str) -> str:
    """A stated job title, or empty when the field is a placeholder."""
    cleaned = (text or "").strip()
    return "" if cleaned.lower() in _PLACEHOLDERS else cleaned


def rank_from_title(text: str) -> str:
    """Normalise a stated job title to a rank, or ``unknown``."""
    lowered = (text or "").lower()
    if not lowered.strip():
        return UNKNOWN
    for pattern, rank in _PATTERNS:
        if re.search(pattern, lowered):
            return rank
    return UNKNOWN


def is_student(rank: str) -> bool:
    """Whether this rank is someone still in training.

    Students are surfaced rather than removed. An editor may still want a
    late-stage doctoral researcher on a narrow topic, but they must be told.
    """
    return rank in (PHD_STUDENT, MSC_STUDENT)


def seniority_of(rank: str) -> int:
    return _SENIORITY.get(rank, 0)


def best_rank(ranks: list[str]) -> str:
    """The most senior rank stated anywhere in a career history.

    A record holds every post someone ever held, and the doctorate is usually
    the oldest entry. Taking the most senior avoids reporting a professor as a
    PhD student because ORCID lists their studentship first.
    """
    ranked = [r for r in ranks if r and r != UNKNOWN]
    if not ranked:
        return UNKNOWN
    return max(ranked, key=seniority_of)


def label(rank: str) -> str:
    """Human-readable form for a report column."""
    return {
        PROFESSOR: "Professor",
        ASSOCIATE_PROFESSOR: "Associate Professor",
        ASSISTANT_PROFESSOR: "Assistant Professor",
        SENIOR_LECTURER: "Senior Lecturer",
        LECTURER: "Lecturer",
        RESEARCHER: "Researcher",
        ENGINEER: "Engineer",
        POSTDOC: "Postdoc",
        PHD_STUDENT: "PhD student",
        MSC_STUDENT: "MSc student",
        UNKNOWN: "unknown",
    }.get(rank, "unknown")
