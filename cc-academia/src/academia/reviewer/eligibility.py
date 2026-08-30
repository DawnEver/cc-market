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


def _activity(person_years: list[int], constraint: Constraint, now_year: int) -> RuleOutcome:
    window = constraint.int_("recent_years", 3)
    needed = constraint.int_("min_recent_papers", 1)
    person_years = [year for year in person_years if year <= now_year]
    recent = [year for year in person_years if year >= now_year - window + 1]
    if not person_years:
        return RuleOutcome(
            constraint.name, True, "no publication years on record — activity not assessed"
        )
    passed = len(recent) >= needed
    detail = (
        f"{len(recent)} paper(s) in the last {window} years"
        if passed
        else f"only {len(recent)} paper(s) in the last {window} years "
        f"(needs {needed}); last published {max(person_years)}"
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
        )
    passed = year >= floor
    detail = (
        f"doctoral candidate in year {year} — confirm before inviting"
        if passed
        else f"doctoral candidate in year {year}, below the journal floor of year {floor}"
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
    person_years: list[int], rows: list[sqlite3.Row], constraint: Constraint, now_year: int
) -> RuleOutcome:
    """A long career alone is never a reason. Silence on top of one is."""
    span = constraint.int_("career_years", 10)
    dated = [year for year in person_years if year <= now_year]
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
    constraints = (policy.activity, policy.doctoral, policy.invitation_activity, policy.veteran)
    if all(constraint.off for constraint in constraints):
        return Assessment()

    years = repo.publication_years(conn, person.person_id)
    history = repo.invitation_history(conn, person.person_id)

    activity, doctoral, invitations, veteran = constraints
    outcomes = []
    if not activity.off:
        outcomes.append(_activity(years, activity, now_year))
    if not doctoral.off:
        outcomes.append(_doctoral(person, doctoral, now_year))
    if not invitations.off:
        outcomes.append(_invitation_response(history, invitations, now_year))
    if not veteran.off:
        outcomes.append(_veteran(years, history, veteran, now_year))

    # Only ``prefer`` rules feed the score. A ``require`` rule has already had
    # its say by excluding or not excluding; letting it also pay a bonus would
    # dilute a genuine preference failure with gates that everybody passes.
    preferred = [o for o in outcomes if not o.excluding]
    passed = sum(1 for outcome in preferred if outcome.passed)
    return Assessment(outcomes=outcomes, score=passed / len(preferred) if preferred else 1.0)
