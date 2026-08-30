"""Candidate scoring.

Two mechanisms, deliberately not one:

* a **hard filter** — a COI ``BLOCK``, or exclusion under a hard geographic
  policy — removes the candidate. Its score becomes ``-inf``.
* an **explainable score** — a weighted sum over components that each survive
  into the report, so ``0.87`` is never the whole answer.

A conflict is not a scoring feature. Blending "expertise 95, COI −20" into 75 is
exactly how a disqualified reviewer ends up on a shortlist.
"""

from __future__ import annotations

import math
import sqlite3
from dataclasses import dataclass, field
from typing import Any

from academia.core.errors import UsageError
from academia.core.models import Person
from academia.core.text import recency_score, word_overlap
from academia.reviewer import coi as coi_module
from academia.reviewer import eligibility as eligibility_module
from academia.reviewer.geo import GeoAssessment
from academia.reviewer.policy import Policy
from academia.store import repository as repo

BLOCKED_SCORE = -math.inf


@dataclass
class Evidence:
    """One publication supporting a candidate's fit."""

    paper_id: str
    title: str
    year: int | None
    position: str
    position_weight: float
    similarity: float
    #: Where the paper can actually be read. A title and a score are not enough
    #: to open one with, and the evidence is what an editor judges a candidate
    #: on. Empty when no source gave a resolvable location — never invented.
    url: str = ""
    doi: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "paper_id": self.paper_id,
            "title": self.title,
            "year": self.year,
            "position": self.position,
            "position_weight": self.position_weight,
            "similarity": round(self.similarity, 3),
            "url": self.url,
            "doi": self.doi,
        }


@dataclass
class Candidate:
    person: Person
    evidence: list[Evidence] = field(default_factory=list)
    verdict: coi_module.Verdict | None = None
    geo: GeoAssessment | None = None
    eligibility: eligibility_module.Assessment | None = None
    components: dict[str, float] = field(default_factory=dict)
    score: float = 0.0
    notes: list[str] = field(default_factory=list)

    @property
    def blocked(self) -> bool:
        return self.score == BLOCKED_SCORE

    @property
    def coi_status(self) -> str:
        return self.verdict.status if self.verdict else coi_module.CLEAR


#: How many of a candidate's strongest papers contribute keywords to their
#: vocabulary. Bounded because the topic score asks how much of the manuscript's
#: vocabulary someone works on, and pooling every paper would let a prolific
#: generalist cover it by accumulation rather than by working on it.
VOCABULARY_EVIDENCE_DEPTH = 5


def _candidate_vocabulary(conn: sqlite3.Connection, candidate: Candidate) -> list[str]:
    """Every term that describes what this candidate works on.

    OpenAlex assigns people a handful of labels from its own coarse taxonomy —
    "Electric Motor Design and Analysis" covers most of this field at once. The
    fine-grained signal lives on their papers, so the keywords of the very
    papers that qualified them are folded in alongside — the strongest few,
    which ``candidate.evidence`` already has sorted by similarity.
    """
    terms = list(candidate.person.topics)
    for evidence in candidate.evidence[:VOCABULARY_EVIDENCE_DEPTH]:
        terms.extend(
            row["term"]
            for row in conn.execute(
                "SELECT term FROM paper_terms WHERE paper_id = ?", (evidence.paper_id,)
            )
        )
    return terms


def _topic_match(candidate_terms: list[str], profile_terms: list[str]) -> float:
    return word_overlap(candidate_terms, profile_terms)


def _weighted_evidence(evidence: list[Evidence]) -> float:
    """Reward relevant papers where the candidate carried real responsibility.

    Position weights matter more than raw count: five middle-author papers say
    less about someone's command of a topic than two first-author ones.
    """
    if not evidence:
        return 0.0
    total = sum(e.similarity * e.position_weight for e in evidence)
    # Saturating rather than linear: the tenth relevant paper adds little.
    return min(1.0, total / 3.0)


def _recent_expertise(evidence: list[Evidence], now_year: int) -> float:
    if not evidence:
        return 0.0
    return max(recency_score(e.year, now_year) for e in evidence)


def _reviewer_history(conn: sqlite3.Connection, person: Person) -> tuple[float, list[str]]:
    """Prior invitations shape the score once the database has any history.

    This is what makes the second manuscript cheaper than the first: someone who
    never responded should not top the list again.
    """
    rows = repo.invitation_history(conn, person.person_id)
    if not rows:
        return 0.5, []  # neutral: unknown is not a mark against anyone

    invited = len(rows)
    responded = sum(1 for r in rows if r["responded"])
    accepted = sum(1 for r in rows if r["accepted"])
    notes = [f"invited {invited}x, responded {responded}, accepted {accepted}"]
    if responded == 0:
        notes.append("never responded to a previous invitation")
        return 0.0, notes
    return min(1.0, (responded + accepted) / (2 * invited)), notes


def _seniority_note(person: Person, policy: Policy, now_year: int) -> str:
    age = person.academic_age(now_year)
    if age is None:
        return ""
    if age < policy.min_academic_age:
        return f"academic age {age} is below the journal minimum of {policy.min_academic_age}"
    if policy.max_academic_age and age > policy.max_academic_age:
        return f"academic age {age} exceeds the journal maximum of {policy.max_academic_age}"
    return ""


def _student_note(person: Person, now_year: int) -> str:
    """Flag a candidate who is still in training.

    The pool is harvested from authorship, so students are in it by
    construction. They are surfaced rather than dropped: a late-stage doctoral
    researcher may be exactly right on a narrow topic, but the editor has to be
    told before an invitation goes out under a journal's name.
    """
    from academia.reviewer.seniority import is_student, label

    if not is_student(person.rank):
        return ""
    year = person.doctoral_year(now_year)
    where = f" in year {year}" if year else ""
    return f"{label(person.rank)}{where} — confirm before inviting"


def score_candidate(
    conn: sqlite3.Connection,
    candidate: Candidate,
    *,
    profile_topics: list[str],
    profile_methods: list[str],
    policy: Policy,
    now_year: int,
) -> Candidate:
    """Populate ``components`` and ``score`` for one candidate."""
    if candidate.verdict is not None and candidate.verdict.blocked:
        candidate.score = BLOCKED_SCORE
        candidate.components = {}
        candidate.notes.append(f"blocked: {candidate.verdict.summary()}")
        return candidate

    if candidate.geo is not None and candidate.geo.excluded:
        candidate.score = BLOCKED_SCORE
        candidate.components = {}
        candidate.notes.append(f"excluded: {candidate.geo.reason}")
        return candidate

    # Eligibility is a policy gate, not a scoring feature. Under ``require`` a
    # failure removes the candidate the same way a conflict does, so nobody
    # climbs back onto the shortlist on expertise alone; under ``prefer`` it
    # only feeds a component and leaves its reason in the notes.
    assessment = eligibility_module.assess(conn, candidate.person, policy, now_year=now_year)
    candidate.eligibility = assessment
    if assessment.excluded:
        candidate.score = BLOCKED_SCORE
        candidate.components = {}
        candidate.notes.append(f"excluded: {assessment.reason}")
        return candidate

    history, history_notes = _reviewer_history(conn, candidate.person)
    candidate.notes.extend(history_notes)

    vocabulary = _candidate_vocabulary(conn, candidate)
    components = {
        "topic": _topic_match(vocabulary, profile_topics),
        "method": _topic_match(vocabulary, profile_methods),
        "recent_expertise": _recent_expertise(candidate.evidence, now_year),
        "publication_evidence": _weighted_evidence(candidate.evidence),
        "geographic": 1.0 if (candidate.geo and candidate.geo.cross_region) else 0.0,
        "reviewer_history": history,
        "activity": assessment.score,
    }
    weights = policy.weights
    candidate.components = components
    candidate.score = sum(components[k] * weights.get(k, 0.0) for k in components)

    candidate.notes.extend(assessment.notes())
    if (note := _seniority_note(candidate.person, policy, now_year)):
        candidate.notes.append(note)
    if (note := _student_note(candidate.person, now_year)):
        candidate.notes.append(note)
    if candidate.person.confidence < 0.6:
        candidate.notes.append(
            f"identity confidence {candidate.person.confidence:.2f} "
            f"({candidate.person.resolution_method}) — confirm before inviting"
        )
    return candidate


def rank(candidates: list[Candidate]) -> list[Candidate]:
    """Order by the fixed priority: COI safety, then expertise, then geography.

    Blocked candidates sort last but are *kept*, because an editor needs to see
    that someone obvious was considered and why they were dropped.
    """
    severity = {coi_module.CLEAR: 0, coi_module.REVIEW: 1, coi_module.BLOCK: 2}

    def key(candidate: Candidate) -> tuple[int, int, float, float]:
        return (
            # Removed for any reason — a conflict or a policy floor — sorts
            # below everyone still invitable, including REVIEW-flagged names.
            int(candidate.blocked),
            severity.get(candidate.coi_status, 0),
            -(candidate.score if candidate.score != BLOCKED_SCORE else -1e9),
            -(candidate.components.get("geographic", 0.0)),
        )

    return sorted(candidates, key=key)


def take(ordered: list[Candidate], top: int) -> list[Candidate]:
    """Slice a ranked list to ``top``, keeping every blocked candidate.

    Blocked candidates sort last, so a plain slice deletes exactly the names the
    shortlist promises to show: the ones an editor would otherwise wonder why
    they never saw. ``top`` bounds the invitable list, not the audit trail.
    """
    if top < 0:
        raise UsageError(f"--top must not be negative (got {top})")
    if not top:
        return ordered
    invitable = [c for c in ordered if not c.blocked]
    return [*invitable[:top], *[c for c in ordered if c.blocked]]
