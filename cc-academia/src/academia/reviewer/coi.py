"""Conflict-of-interest rule engine.

Entirely deterministic. A language model never decides whether a conflict exists;
it cannot be cross-examined, and an editor asked to justify a reviewer choice
needs evidence with a source, not an opinion.

Three outcomes:

``BLOCK``
    Disqualifying. The candidate's score becomes ``-inf`` rather than being
    penalised — a conflict is not a scoring feature that a high topic match can
    outweigh.
``REVIEW``
    Worth the editor's judgement; stays in the shortlist, flagged.
``CLEAR``
    **No detected conflict.** Never "no conflict": a bibliographic database
    cannot prove the absence of a personal, financial or competitive tie.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from academia.core.models import Person
from academia.core.text import normalize_name, normalize_title
from academia.reviewer.policy import Policy, excluded_names
from academia.store import repository as repo

BLOCK = "BLOCK"
REVIEW = "REVIEW"
CLEAR = "CLEAR"

#: Ordered by severity so a verdict can be reduced with `max`.
_SEVERITY = {CLEAR: 0, REVIEW: 1, BLOCK: 2}

CLEAR_WORDING = "no detected conflict"


@dataclass(frozen=True)
class Finding:
    rule: str
    status: str
    evidence: dict[str, Any]

    def describe(self) -> str:
        return f"{self.rule}: {self.evidence}"


@dataclass
class Verdict:
    person_id: str
    status: str = CLEAR
    findings: list[Finding] = field(default_factory=list)
    policy_fingerprint: str = ""

    @property
    def blocked(self) -> bool:
        return self.status == BLOCK

    def add(self, finding: Finding) -> None:
        self.findings.append(finding)
        if _SEVERITY[finding.status] > _SEVERITY[self.status]:
            self.status = finding.status

    def summary(self) -> str:
        if self.status == CLEAR:
            return CLEAR_WORDING
        return "; ".join(f.rule for f in self.findings)


@dataclass(frozen=True)
class ManuscriptContext:
    """Everything the engine needs to know about the submission under review."""

    ms_id: str
    author_names: list[str]
    author_person_ids: list[str] = field(default_factory=list)
    #: Authors matched on a name alone. Kept apart from the identified ones
    #: because a name is not an identity: three researchers publish as "Wei
    #: Hua", and a co-authorship with one of them is not evidence about the
    #: others. Findings drawn from these go to the editor, never to a block.
    possible_author_person_ids: list[str] = field(default_factory=list)
    author_institutions: list[str] = field(default_factory=list)
    author_countries: list[str] = field(default_factory=list)
    referenced_paper_ids: list[str] = field(default_factory=list)
    year: int = 0

    @property
    def author_name_keys(self) -> set[str]:
        return {normalize_name(n) for n in self.author_names if n}

    @property
    def institution_keys(self) -> set[str]:
        """The institutions named in the affiliation lines, one key each.

        A manuscript gives one string per author — "the School of Electrical
        Engineering, Southeast University, Nanjing 210096, China" — and matching
        that whole line against a candidate's employer never succeeds. Splitting
        on the commas the string already carries does, and comparing segments
        for equality rather than by containment keeps Nanjing University
        distinct from Nanjing University of Aeronautics and Astronautics.
        """
        return {key for line in self.author_institutions for key in affiliation_keys(line)}


#: Segments naming a place rather than an employer. A candidate whose
#: institution is recorded as "China" must not collide with every Chinese
#: address.
_NOT_AN_INSTITUTION = {
    "china",
    "usa",
    "uk",
    "united kingdom",
    "united states",
    "japan",
    "korea",
    "india",
    "iran",
}


def affiliation_keys(line: str) -> set[str]:
    """Split one affiliation line into comparable institution keys."""
    keys = set()
    for segment in (line or "").split(","):
        key = normalize_title(segment).removeprefix("the ").strip()
        if not key or key in _NOT_AN_INSTITUTION:
            continue
        # A postcode segment — "nanjing 210096" — names a place, not an employer.
        if any(token.isdigit() for token in key.split()):
            continue
        keys.add(key)
    return keys


@dataclass(frozen=True)
class AuthorIdentity:
    """One submitting author, matched to a person in the store."""

    name: str
    person_id: str
    #: ``orcid`` when an identifier matched, ``name`` when only a name did.
    how: str

    @property
    def certain(self) -> bool:
        return self.how == "orcid"


def identify_authors(
    conn: sqlite3.Connection, authors: list[tuple[str, str]]
) -> list[AuthorIdentity]:
    """Resolve the submitting authors to people in the store.

    The co-authorship, shared-doctorate and advisor rules all work on person
    ids. Nothing ever filled those ids in, so all three ran against an empty
    list and passed everybody — the quietest kind of failure, because the report
    reads the same whether the rule cleared a candidate or never examined one.

    An ORCID is an identity and a match on it is treated as one. A name is not,
    so its matches come back separately.
    """
    identities: list[AuthorIdentity] = []
    for name, orcid in authors:
        if orcid:
            row = conn.execute(
                "SELECT person_id FROM persons WHERE orcid = ?", (orcid.strip(),)
            ).fetchone()
            if row is not None:
                identities.append(AuthorIdentity(name, row["person_id"], "orcid"))
                continue
        identities.extend(
            AuthorIdentity(name, row["person_id"], "name")
            for row in repo.find_person_by_name(conn, name)
        )

    # An identified author is not also a guess about the same person.
    certain = {i.person_id for i in identities if i.certain}
    return [i for i in identities if i.certain or i.person_id not in certain]


# ------------------------------------------------------------------- rules


def _is_manuscript_author(person: Person, context: ManuscriptContext) -> Finding | None:
    if person.person_id in context.author_person_ids:
        return Finding("manuscript_author", BLOCK, {"matched_by": "person_id"})
    keys = {normalize_name(n) for n in [person.display_name, *person.names] if n}
    overlap = keys & context.author_name_keys
    if overlap:
        return Finding("manuscript_author", BLOCK, {"matched_by": "name", "name": sorted(overlap)[0]})
    return None


def _is_excluded(person: Person, policy: Policy) -> Finding | None:
    banned = excluded_names(policy)
    if not banned:
        return None
    keys = {normalize_name(n) for n in [person.display_name, *person.names] if n}
    overlap = keys & banned
    return Finding("exclusion_list", BLOCK, {"name": sorted(overlap)[0]}) if overlap else None


def _coauthorship(
    conn: sqlite3.Connection, person: Person, context: ManuscriptContext, policy: Policy
) -> list[Finding]:
    """Recent co-authorship blocks; an older but dense record is flagged."""
    identified = set(context.author_person_ids)
    supposed = [pid for pid in context.possible_author_person_ids if pid not in identified]
    if not identified and not supposed:
        return []

    # Inclusive window: coauthor_years = 5 means the five years ending with the
    # submission year, not six.
    cutoff = (context.year or 0) - policy.coauthor_years + 1
    edges = {row["other"]: row for row in repo.coauthors_of(conn, person.person_id)}

    ordered = [(pid, "identity") for pid in context.author_person_ids]
    ordered += [(pid, "name") for pid in supposed]

    findings: list[Finding] = []
    for author_id, how in ordered:
        edge = edges.get(author_id)
        if edge is None:
            continue
        last_year = edge["last_year"] or 0
        evidence = {
            "coauthor_person_id": author_id,
            "paper_count": edge["paper_count"],
            "first_year": edge["first_year"],
            "last_year": edge["last_year"],
            "window_from": cutoff,
            "identified_by": how,
        }
        if last_year >= cutoff and how == "identity":
            findings.append(Finding("recent_coauthor", BLOCK, evidence))
        elif last_year >= cutoff:
            # Reported for judgement: the collaboration is real, the identity
            # behind the name is not established.
            findings.append(Finding("possible_recent_coauthor", REVIEW, evidence))
        elif edge["paper_count"] >= policy.historic_collaboration_papers:
            findings.append(Finding("dense_historic_collaboration", REVIEW, evidence))
    return findings


def _institutions(person: Person, context: ManuscriptContext) -> list[Finding]:
    """Institutional overlap, current and historic.

    Department-level overlap blocks; institution-level is flagged, because a
    large university is not a research group.
    """
    findings: list[Finding] = []
    manuscript_institutions = context.institution_keys
    if not manuscript_institutions:
        return findings

    current = person.current_affiliation
    if current and normalize_title(current.institution) in manuscript_institutions:
        # A department is a research group; a university is not. So the block
        # needs the department to be named on both sides, and an affiliation
        # line names it in a segment of its own.
        if current.department and normalize_title(current.department) in manuscript_institutions:
            findings.append(
                Finding(
                    "same_department",
                    BLOCK,
                    {"institution": current.institution, "department": current.department},
                )
            )
        else:
            findings.append(
                Finding("same_institution", REVIEW, {"institution": current.institution})
            )

    for affiliation in person.affiliations:
        if affiliation is current:
            continue
        if normalize_title(affiliation.institution) in manuscript_institutions:
            findings.append(
                Finding(
                    "previous_institution_overlap",
                    REVIEW,
                    {
                        "institution": affiliation.institution,
                        "years": [affiliation.year_from, affiliation.year_to],
                    },
                )
            )
    return findings


def _shared_doctorate(
    person: Person, manuscript_people: list[Person], policy: Policy
) -> list[Finding]:
    """Same doctoral institution with overlapping years.

    This is the signal a name can never provide and an institution list alone
    cannot either: two people who were in the same lab at the same time.
    """
    findings: list[Finding] = []
    window = policy.shared_institution_overlap_years

    for entry in person.education:
        if not entry.inst_id:
            continue
        for other in manuscript_people:
            for their in other.education:
                if their.inst_id != entry.inst_id:
                    continue
                mine = entry.year_to or entry.year_from
                theirs = their.year_to or their.year_from
                if mine is None or theirs is None:
                    continue
                if abs(mine - theirs) <= window:
                    findings.append(
                        Finding(
                            "same_phd_institution_overlap",
                            BLOCK,
                            {
                                "institution": entry.institution,
                                "candidate_year": mine,
                                "author_year": theirs,
                                "person_id": other.person_id,
                            },
                        )
                    )
    return findings


def _advisor_relationship(person: Person, manuscript_people: list[Person]) -> list[Finding]:
    """Only recorded when an advisor link was captured with direct evidence."""
    findings: list[Finding] = []
    author_ids = {p.person_id for p in manuscript_people}
    for entry in person.education:
        if entry.advisor_person_id and entry.advisor_person_id in author_ids:
            findings.append(
                Finding(
                    "advisor_advisee",
                    BLOCK,
                    {"advisor_person_id": entry.advisor_person_id, "source": entry.source_url},
                )
            )
    for other in manuscript_people:
        for entry in other.education:
            if entry.advisor_person_id == person.person_id:
                findings.append(
                    Finding(
                        "advisor_advisee",
                        BLOCK,
                        {"advisee_person_id": other.person_id, "source": entry.source_url},
                    )
                )
    return findings


def _citation_density(
    conn: sqlite3.Connection, person: Person, context: ManuscriptContext, policy: Policy
) -> list[Finding]:
    """A manuscript leaning heavily on one researcher's work is worth flagging.

    Not disqualifying — being the field's reference point is what makes someone a
    good reviewer — but the editor should see it.
    """
    if not context.referenced_paper_ids:
        return []
    own = {row["paper_id"] for row in repo.papers_of(conn, person.person_id, limit=500)}
    hits = own & set(context.referenced_paper_ids)
    if len(hits) >= policy.heavy_citation_threshold:
        return [
            Finding(
                "heavily_cited_by_manuscript",
                REVIEW,
                {"cited_paper_count": len(hits), "paper_ids": sorted(hits)[:10]},
            )
        ]
    return []


# ----------------------------------------------------------------- engine


def evaluate(
    conn: sqlite3.Connection,
    person: Person,
    context: ManuscriptContext,
    policy: Policy,
    *,
    manuscript_people: list[Person] | None = None,
) -> Verdict:
    """Run every rule and reduce to a single verdict.

    All rules run even after the first BLOCK: an editor reviewing a rejection
    wants the whole picture, not the first tripwire.
    """
    verdict = Verdict(person_id=person.person_id, policy_fingerprint=policy.fingerprint())
    people = manuscript_people or []

    candidates: list[Finding] = []
    if (finding := _is_manuscript_author(person, context)) is not None:
        candidates.append(finding)
    if (finding := _is_excluded(person, policy)) is not None:
        candidates.append(finding)
    candidates.extend(_coauthorship(conn, person, context, policy))
    candidates.extend(_institutions(person, context))
    candidates.extend(_shared_doctorate(person, people, policy))
    candidates.extend(_advisor_relationship(person, people))
    candidates.extend(_citation_density(conn, person, context, policy))

    for finding in candidates:
        # A rule that the journal has demoted out of both lists is not applied.
        status = policy.status_for(finding.rule)
        if status == CLEAR:
            continue
        verdict.add(Finding(finding.rule, status, finding.evidence))

    return verdict


def persist(conn: sqlite3.Connection, run_id: str, verdict: Verdict) -> None:
    """Record the audit trail, including a clean bill of health."""
    if not verdict.findings:
        repo.record_coi(
            conn,
            run_id,
            verdict.person_id,
            rule="all_rules",
            status=CLEAR,
            evidence={"wording": CLEAR_WORDING},
        )
        return
    for finding in verdict.findings:
        repo.record_coi(
            conn,
            run_id,
            verdict.person_id,
            rule=finding.rule,
            status=finding.status,
            evidence=finding.evidence,
        )
