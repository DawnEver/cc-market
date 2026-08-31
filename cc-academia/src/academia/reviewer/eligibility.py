"""Who an editor is willing to invite, as opposed to who is qualified.

Expertise says a candidate *could* review the manuscript. Eligibility says the
invitation is worth sending: someone still working in the field, far enough into
their training to carry a report, and not a name that has quietly stopped taking
review work.

Four rules, each read from the policy file and each carrying its own mode:

* **recent activity** — published inside the window
* **doctoral year** — a doctoral candidate is past the journal's floor
* **invitation response** — answered a fair share of recent invitations
* **unresponsive veteran** — a long career *and* a record of unanswered
  invitations, which is the only combination that fires

Nothing here is inferred. A rule that has no evidence to work with passes: an
empty invitation history means nobody has asked this person yet, and a missing
enrolment year is a gap in ORCID rather than a fact about the person. Only a
stated fact can disqualify someone, because an editor has to be able to read the
reason and disagree with it.

``require`` excludes, ``prefer`` only scores and annotates, ``off`` skips the
rule entirely — so a journal that wants a third-year doctoral floor but no view
on activity says exactly that, and nothing else changes.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from typing import Any

from academia.core.models import Person
from academia.reviewer.policy import Constraint, Policy
from academia.reviewer.seniority import PHD_STUDENT
from academia.store import repository as repo


@dataclass(frozen=True)
class RuleOutcome:
    """One rule's verdict on one candidate, with the fact behind it."""

    rule: str
    passed: bool
    detail: str
    excluding: bool = False
    manual_review: bool = False

    @property
    def excluded(self) -> bool:
        return self.excluding and not self.passed


@dataclass
class Assessment:
    outcomes: list[RuleOutcome] = field(default_factory=list)
    #: 0..1, how well the candidate meets the rules that are switched on. 1.0
    #: when every rule is off, so turning the feature off leaves scores intact.
    score: float = 1.0

    @property
    def excluded(self) -> bool:
        return any(outcome.excluded for outcome in self.outcomes)

    @property
    def reason(self) -> str:
        failed = [o for o in self.outcomes if o.excluded]
        return "; ".join(o.detail for o in failed)

    def notes(self) -> list[str]:
        """Every rule that did not pass, whether or not it excluded anybody."""
        return [o.detail for o in self.outcomes if not o.passed]


@dataclass(frozen=True)
class Readiness:
    status: str
    reasons: tuple[str, ...] = ()


def invitation_readiness(candidate: Any, email: Any, *, domain_status: str) -> Readiness:
    """One invitation decision, shared by every report/export."""
    rejected: list[str] = []
    review: list[str] = []
    if candidate.blocked:
        rejected.append("blocked by conflict-of-interest policy")
    elif candidate.verdict and candidate.verdict.status == "BLOCK":
        rejected.append(candidate.verdict.summary())
    elif candidate.verdict and candidate.verdict.status == "REVIEW":
        review.append(candidate.verdict.summary())
    assessment = candidate.eligibility
    if assessment:
        rejected.extend(outcome.detail for outcome in assessment.outcomes if outcome.excluded)
        review.extend(outcome.detail for outcome in assessment.outcomes if outcome.manual_review)
    if not email.found:
        rejected.append("no verified public professional email")
    person = candidate.person
    if person.resolution_method == "name_only" or person.confidence < 0.8:
        review.append(
            f"identity requires confirmation ({person.resolution_method}, "
            f"confidence {person.confidence:.2f})"
        )
    affiliation = person.current_affiliation
    if affiliation is None:
        review.append("current affiliation unknown")
    elif affiliation.kind == "company":
        review.append("industry affiliation — competitive conflict not assessed")
    if email.found and domain_status != "match":
        review.append(f"email/current-affiliation domain {domain_status}")
    if rejected:
        return Readiness("rejected", tuple(dict.fromkeys(rejected + review)))
    if review:
        return Readiness("manual_review", tuple(dict.fromkeys(review)))
    return Readiness("eligible")


def _response_rate(
    rows: list[sqlite3.Row], since_year: int | None, now_year: int
) -> tuple[int, float]:
    """Resolved invitations in the window, and the share that got an answer.

    ``responded`` is nullable: an invitation whose outcome nobody has recorded
    yet is unresolved, not a silence. Counting it as a non-response would let a
    field an editor simply has not filled in exclude a reviewer.
    """

    def inside(row: sqlite3.Row) -> bool:
        year = _year_of(row["invited_at"])
        if year is not None and year > now_year:
            return False  # a date in the future is a data error, not evidence
        if since_year is None:
            return True
        # An undated invitation still happened; dropping it would let a missing
        # field erase a record of silence.
        return year is None or year >= since_year

    considered = [row for row in rows if inside(row) and row["responded"] is not None]
    if not considered:
        return 0, 0.0
    responded = sum(1 for row in considered if row["responded"])
    return len(considered), responded / len(considered)


def _year_of(invited_at: str | None) -> int | None:
    text = (invited_at or "").strip()[:4]
    return int(text) if text.isdigit() else None


def _activity(
    works_by_year: dict[int, int],
    person_years: list[int],
    constraint: Constraint,
    now_year: int,
) -> RuleOutcome:
    """Is this person still publishing at all?

    Read from their bibliographic profile's yearly output when it is known.
    Falling back to the papers in the store would ask a different question —
    "did *this manuscript's* queries harvest anything recent from them" — and a
    prolific author whose latest work is off-topic would come back dormant.
    """
    window = constraint.int_("recent_years", 3)
    needed = constraint.int_("min_recent_papers", 1)
    floor = now_year - window + 1

    if works_by_year:
        recent = sum(w for year, w in works_by_year.items() if floor <= year <= now_year)
        latest = max((year for year, w in works_by_year.items() if w and year <= now_year), default=None)
        source = "profile"
    else:
        years = [year for year in person_years if year <= now_year]
        if not years:
            return RuleOutcome(
                constraint.name, True, "no publication record available — activity not assessed"
            )
        recent = sum(1 for year in years if year >= floor)
        latest = max(years)
        # The store holds only what this run harvested, so an absence here is
        # weaker evidence than an absence in a full profile. Say which was used.
        source = "harvested papers only"

    passed = recent >= needed
    last = f"last published {latest}" if latest else "no dated work"
    detail = (
        f"{recent} paper(s) in the last {window} years ({source})"
        if passed
        else f"only {recent} paper(s) in the last {window} years "
        f"(needs {needed}); {last} [{source}]"
    )
    return RuleOutcome(constraint.name, passed, detail, excluding=constraint.excluding)


def _doctoral(person: Person, constraint: Constraint, now_year: int) -> RuleOutcome:
    if person.rank != PHD_STUDENT:
        return RuleOutcome(constraint.name, True, "not a doctoral candidate")
    floor = constraint.int_("min_year", 3)
    year = person.doctoral_year(now_year)
    if year is None:
        # Not configurable on purpose. ORCID states an enrolment year for a
        # minority of candidates, and a switch that turned that gap into an
        # exclusion would quietly remove the people whose records are thinnest
        # rather than the ones who are too junior.
        return RuleOutcome(
            constraint.name,
            True,
            "doctoral candidate, year of study not stated — confirm before inviting",
            manual_review=True,
        )
    passed = year >= floor
    detail = (
        f"doctoral candidate in year {year} — confirm before inviting"
        if passed
        else f"doctoral candidate in year {year}, below the journal floor of year {floor}"
    )
    return RuleOutcome(constraint.name, passed, detail, excluding=constraint.excluding)


def _career(
    person: Person, person_years: list[int], constraint: Constraint, now_year: int
) -> RuleOutcome:
    """Enforce doctorate age, falling back to the observable publication career."""
    maximum = constraint.int_("max_years", 10)
    if person.phd_year:
        years = max(0, now_year - person.phd_year)
        evidence = f"{years} years since doctorate ({person.phd_year})"
    else:
        dated = [year for year in person_years if year <= now_year]
        if not dated:
            return RuleOutcome(
                constraint.name,
                True,
                "career length unknown — confirm before inviting",
                manual_review=True,
            )
        years = now_year - min(dated) + 1
        evidence = f"{years}-year publication career (first paper {min(dated)})"
    passed = years <= maximum
    detail = evidence if passed else f"{evidence}, exceeds maximum of {maximum} years"
    return RuleOutcome(constraint.name, passed, detail, excluding=constraint.excluding)


def assess_relevant_activity(
    years: list[int], constraint: Constraint, *, now_year: int
) -> RuleOutcome:
    """Require manuscript-relevant evidence inside the configured window."""
    if constraint.off:
        return RuleOutcome(constraint.name, True, "not assessed")
    window = constraint.int_("recent_years", 3)
    minimum = constraint.int_("min_recent_papers", 1)
    floor = now_year - window + 1
    recent = sum(year >= floor for year in years if year <= now_year)
    passed = recent >= minimum
    latest = max((year for year in years if year <= now_year), default=None)
    detail = (
        f"{recent} relevant paper(s) in the last {window} years"
        if passed
        else f"only {recent} relevant paper(s) in the last {window} years "
        f"(needs {minimum}); latest relevant paper {latest or 'unknown'}"
    )
    return RuleOutcome(constraint.name, passed, detail, excluding=constraint.excluding)


def _invitation_response(
    rows: list[sqlite3.Row], constraint: Constraint, now_year: int
) -> RuleOutcome:
    window = constraint.int_("recent_years", 3)
    minimum = constraint.int_("min_invitations", 1)
    invited, rate = _response_rate(rows, now_year - window + 1, now_year)
    if invited < minimum:
        return RuleOutcome(
            constraint.name,
            True,
            f"{invited} invitation(s) in the last {window} years — too few to judge",
        )
    passed = rate >= constraint.float_("min_response_rate", 0.5)
    detail = (
        f"responded to {rate:.0%} of {invited} invitation(s) in the last {window} years"
        if passed
        else f"responded to only {rate:.0%} of {invited} invitation(s) "
        f"in the last {window} years"
    )
    return RuleOutcome(constraint.name, passed, detail, excluding=constraint.excluding)


def _veteran(
    works_by_year: dict[int, int],
    person_years: list[int],
    rows: list[sqlite3.Row],
    constraint: Constraint,
    now_year: int,
) -> RuleOutcome:
    """A long career alone is never a reason. Silence on top of one is."""
    span = constraint.int_("career_years", 10)
    known = [year for year, works in works_by_year.items() if works] or person_years
    dated = [year for year in known if year <= now_year]
    career = (now_year - min(dated) + 1) if dated else None
    if career is None or career < span:
        return RuleOutcome(constraint.name, True, "not a long-career candidate")
    invited, rate = _response_rate(rows, None, now_year)
    if invited < constraint.int_("min_invitations", 2):
        return RuleOutcome(
            constraint.name,
            True,
            f"{career}-year career, {invited} invitation(s) on record — no basis to judge",
        )
    if rate > constraint.float_("max_response_rate", 0.0):
        return RuleOutcome(
            constraint.name, True, f"{career}-year career, responds to {rate:.0%} of invitations"
        )
    return RuleOutcome(
        constraint.name,
        False,
        f"{career}-year career and no response to {invited} invitation(s) — "
        "appears to have stopped accepting review work",
        excluding=constraint.excluding,
    )


def assess(
    conn: sqlite3.Connection, person: Person, policy: Policy, *, now_year: int
) -> Assessment:
    """Run every switched-on rule against one candidate."""
    constraints = (
        policy.activity,
        policy.doctoral,
        policy.career,
        policy.invitation_activity,
        policy.veteran,
    )
    if all(constraint.off for constraint in constraints):
        return Assessment()

    years = repo.publication_years(conn, person.person_id)
    works_by_year = person.works_by_year or repo.output_by_year(conn, person.person_id)
    history = repo.invitation_history(conn, person.person_id)

    activity, doctoral, career, invitations, veteran = constraints
    outcomes = []
    if not activity.off:
        outcomes.append(_activity(works_by_year, years, activity, now_year))
    if not doctoral.off:
        outcomes.append(_doctoral(person, doctoral, now_year))
    if not career.off:
        outcomes.append(_career(person, years, career, now_year))
    if not invitations.off:
        outcomes.append(_invitation_response(history, invitations, now_year))
    if not veteran.off:
        outcomes.append(_veteran(works_by_year, years, history, veteran, now_year))

    # Only ``prefer`` rules feed the score. A ``require`` rule has already had
    # its say by excluding or not excluding; letting it also pay a bonus would
    # dilute a genuine preference failure with gates that everybody passes.
    preferred = [o for o in outcomes if not o.excluding]
    passed = sum(1 for outcome in preferred if outcome.passed)
    return Assessment(outcomes=outcomes, score=passed / len(preferred) if preferred else 1.0)
