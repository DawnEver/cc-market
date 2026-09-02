"""Who an editor is willing to invite, as opposed to who is qualified.

Expertise says a candidate *could* review the manuscript. Eligibility says the
invitation is worth sending: someone still working in the field, far enough into
their training to carry a report, and not a name that has quietly stopped taking
review work.

Each rule is read from the policy file and carries its own mode:

* **recent activity** — published inside the window
* **doctoral year** — a doctoral candidate is past the journal's floor
* **invitation response** — answered a fair share of recent invitations
* **unresponsive veteran** — a long career *and* a record of unanswered
  invitations, which is the only combination that fires
* **restricted country** — currently affiliated somewhere the journal will not
  invite from, read from the affiliation and never from a name
* **related journals** — enough of the relevant record is journal work
  (evaluated in ``rank`` alongside relevant activity, where the evidence lives)

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
    #: True when the rule had no evidence to work with and declined to judge.
    #: It passes, because an empty invitation history is not a mark against
    #: anybody — but an audit that printed that as a pass would claim the rule
    #: examined somebody it never could. Distinct from ``manual_review``, which
    #: asks the editor to go and find the answer before inviting.
    abstained: bool = False
    #: The numbers this rule actually compared, and the thresholds it compared
    #: them against, keyed by name. The prose in ``detail`` is for reading; this
    #: is for auditing — an export can lay a column beside each verdict, and a
    #: reader can see how far from a threshold somebody fell without trusting
    #: the sentence. Rules that have nothing to count leave it empty.
    facts: dict[str, Any] = field(default_factory=dict)

    @property
    def excluded(self) -> bool:
        return self.excluding and not self.passed


#: How one outcome reads in an audit column. A rule that abstains for want of
#: evidence is not a pass and not a failure, and a preference that was not met
#: excludes nobody — collapsing either into PASS/FAIL would misreport the run.
PASS = "PASS"
FILTERED = "FILTERED"
VERIFY = "VERIFY"
PREFERENCE_MISSED = "PREFERENCE_MISSED"


def verdict_of(outcome: RuleOutcome) -> str:
    if outcome.manual_review or outcome.abstained:
        return VERIFY
    if outcome.passed:
        return PASS
    return FILTERED if outcome.excluding else PREFERENCE_MISSED


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
                constraint.name,
                True,
                "no publication record available — activity not assessed",
                facts={
                    "activity_known": 0,
                    "activity_paper_minimum": needed,
                    "activity_window_years": window,
                },
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
    return RuleOutcome(
        constraint.name,
        passed,
        detail,
        excluding=constraint.excluding,
        facts={
            "activity_known": 1,
            "activity_paper_count": recent,
            "activity_paper_gap": recent - needed,
            "activity_latest_year": latest,
            "activity_source": source,
            "activity_paper_minimum": needed,
            "activity_window_years": window,
        },
    )


def _doctoral(person: Person, constraint: Constraint, now_year: int) -> RuleOutcome:
    floor = constraint.int_("min_year", 3)
    if person.rank != PHD_STUDENT:
        return RuleOutcome(
            constraint.name,
            True,
            "not a doctoral candidate",
            facts={"is_doctoral": 0, "doctoral_year_minimum": floor},
        )
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
            facts={
                "is_doctoral": 1,
                "doctoral_year_known": 0,
                "doctoral_year_minimum": floor,
            },
        )
    passed = year >= floor
    detail = (
        f"doctoral candidate in year {year} — confirm before inviting"
        if passed
        else f"doctoral candidate in year {year}, below the journal floor of year {floor}"
    )
    return RuleOutcome(
        constraint.name,
        passed,
        detail,
        excluding=constraint.excluding,
        facts={
            "is_doctoral": 1,
            "doctoral_year_known": 1,
            "doctoral_year_value": year,
            "doctoral_year_gap": year - floor,
            "doctoral_year_minimum": floor,
        },
    )


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
                facts={"career_known": 0, "career_years_maximum": maximum},
            )
        years = now_year - min(dated) + 1
        evidence = f"{years}-year publication career (first paper {min(dated)})"
    passed = years <= maximum
    detail = evidence if passed else f"{evidence}, exceeds maximum of {maximum} years"
    return RuleOutcome(
        constraint.name,
        passed,
        detail,
        excluding=constraint.excluding,
        facts={
            "career_known": 1,
            "career_years": years,
            "career_years_gap": maximum - years,
            "career_years_maximum": maximum,
        },
    )


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
    return RuleOutcome(
        constraint.name,
        passed,
        detail,
        excluding=constraint.excluding,
        facts={
            "recent_activity_known": int(bool(years)),
            "recent_paper_count": recent,
            "recent_paper_gap": recent - minimum,
            "latest_year": latest,
            "recent_paper_minimum": minimum,
            "recent_window_years": window,
        },
    )


#: Two vocabularies share this column, because two sources fill it. OpenAlex
#: states the *work* type — ``article``, ``review``, ``conference-paper``,
#: ``preprint`` — and puts the journal's name in the venue instead. IEEE states
#: the *venue* type — ``IEEE Journals``, ``IEEE Conferences``, ``IEEE
#: Standards``, ``Artech Books``. Matching only on the word "journal" reads the
#: second and silently scores every OpenAlex journal paper as a non-journal,
#: which is how a floor of three journal papers came to exclude 149 of 160
#: candidates whose records were full of them.
_JOURNAL_WORDS = ("journal",)
_JOURNAL_TYPES = {"article", "review", "journal-article", "journalarticle"}
_NOT_JOURNAL_WORDS = (
    "conference",
    "proceeding",
    "book",
    "standard",
    "preprint",
    "dissertation",
    "thesis",
    "dataset",
    "patent",
    "report",
    "paratext",
)


def is_journal(venue_type: str) -> bool:
    """Did this paper appear in a journal, as far as the record states?

    Conservative in both directions: a type nobody recognises counts as
    neither, and the caller reports it as unresolved rather than holding it
    against the candidate.
    """
    value = (venue_type or "").strip().lower()
    if not value:
        return False
    if any(word in value for word in _NOT_JOURNAL_WORDS):
        return False
    return value in _JOURNAL_TYPES or any(word in value for word in _JOURNAL_WORDS)


def venue_type_stated(venue_type: str) -> bool:
    """Whether the record says anything usable about where this appeared."""
    value = (venue_type or "").strip().lower()
    if not value:
        return False
    return (
        value in _JOURNAL_TYPES
        or any(word in value for word in _JOURNAL_WORDS)
        or any(word in value for word in _NOT_JOURNAL_WORDS)
    )


def related_journal_facts(evidence: list[Any], minimum: int, target: int) -> dict[str, Any]:
    """The relevant record, counted the way the rule reads it.

    Author position is part of the audit rather than the rule: a first or last
    author carried the work, a middle author may not have, and an editor reading
    a borderline candidate wants to see which. The rule itself only counts
    journal papers — position never decides eligibility, because a supervisor
    slot is not a qualification.
    """
    positions = [(getattr(item, "position", "") or "").lower() for item in evidence]
    weights = [float(getattr(item, "position_weight", 0.0) or 0.0) for item in evidence]
    types = [getattr(item, "venue_type", "") or "" for item in evidence]
    journals = sum(1 for venue_type in types if is_journal(venue_type))
    leading = sum(1 for position in positions if position in {"first", "last"})
    return {
        "related_journal_count": journals,
        "related_journal_gap": journals - minimum,
        "related_journal_target_ratio": round(journals / target, 2) if target else None,
        "related_nonjournal_count": sum(
            1 for venue_type in types if venue_type_stated(venue_type) and not is_journal(venue_type)
        ),
        "related_unknown_type_count": sum(
            1 for venue_type in types if not venue_type_stated(venue_type)
        ),
        "related_first_author_count": positions.count("first"),
        "related_second_author_count": positions.count("second"),
        "related_last_author_count": positions.count("last"),
        "related_middle_author_count": positions.count("middle"),
        "related_leadership_count": leading,
        "related_position_weight_sum": round(sum(weights), 2),
        "related_position_weight_mean": round(sum(weights) / len(weights), 2) if weights else None,
        "related_journal_minimum": minimum,
        "related_journal_target": target,
    }


def assess_related_journals(evidence: list[Any], constraint: Constraint) -> RuleOutcome:
    """Require journal-published work on the manuscript's own topic.

    Counted over the evidence that qualified the candidate, so it asks "has this
    person written journal papers about *this*", not "how much do they publish".
    A paper whose venue type no source stated is not counted and not held
    against anybody, but it is reported, because a candidate who misses the
    floor only on unresolved venues is a data gap rather than a weak reviewer.
    """
    if constraint.off:
        return RuleOutcome(constraint.name, True, "not assessed")
    minimum = constraint.int_("min_publications", 3)
    facts = related_journal_facts(
        evidence, minimum, constraint.int_("target_publications", minimum)
    )
    journals = facts["related_journal_count"]
    unknown = facts["related_unknown_type_count"]
    if journals >= minimum:
        return RuleOutcome(
            constraint.name,
            True,
            f"{journals} relevant journal publication(s)",
            excluding=constraint.excluding,
            facts=facts,
        )
    shortfall = (
        f"only {journals} relevant journal publication(s) of {len(evidence)} "
        f"relevant paper(s) (needs {minimum})"
    )
    if unknown and journals + unknown >= minimum:
        # Enough papers to clear the floor, if only their venues were resolved.
        return RuleOutcome(
            constraint.name,
            True,
            f"{shortfall}; {unknown} paper(s) of unstated venue type — "
            "resolve the venues before relying on this",
            excluding=constraint.excluding,
            manual_review=True,
            facts=facts,
        )
    return RuleOutcome(
        constraint.name, False, shortfall, excluding=constraint.excluding, facts=facts
    )


def _restricted_country(person: Person, constraint: Constraint) -> RuleOutcome:
    """Refuse an invitation to a country the journal will not invite from.

    Reads the current affiliation country, never nationality. An unknown country
    is a gap in the affiliation record and cannot exclude anybody, but it is the
    one case here that an editor has to settle by hand: the whole point of the
    rule is that the answer must not be guessed.
    """
    countries = constraint.upper_set("countries")
    country = (person.country_code or "").strip().upper()[:2]
    named = ", ".join(sorted(countries))
    if not country:
        return RuleOutcome(
            constraint.name,
            True,
            f"current country unknown — confirm it is not {named} before inviting",
            manual_review=True,
            facts={"restricted_country_known": 0, "restricted_countries": named},
        )
    if country in countries:
        return RuleOutcome(
            constraint.name,
            False,
            f"currently affiliated in {country}, which the journal does not invite from",
            excluding=constraint.excluding,
            facts={
                "restricted_country_known": 1,
                "restricted_country_current": country,
                "restricted_country_is_restricted": 1,
                "restricted_countries": named,
            },
        )
    return RuleOutcome(
        constraint.name,
        True,
        f"{country} is not a restricted country",
        facts={
            "restricted_country_known": 1,
            "restricted_country_current": country,
            "restricted_country_is_restricted": 0,
            "restricted_countries": named,
        },
    )


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
            abstained=True,
            facts={
                "invitation_response_known": 0,
                "recent_invitation_count": invited,
                "recent_invitation_minimum": minimum,
                "invitation_window_years": window,
                "invitation_response_rate_minimum": constraint.float_("min_response_rate", 0.5),
            },
        )
    required = constraint.float_("min_response_rate", 0.5)
    passed = rate >= required
    detail = (
        f"responded to {rate:.0%} of {invited} invitation(s) in the last {window} years"
        if passed
        else f"responded to only {rate:.0%} of {invited} invitation(s) "
        f"in the last {window} years"
    )
    return RuleOutcome(
        constraint.name,
        passed,
        detail,
        excluding=constraint.excluding,
        facts={
            "invitation_response_known": 1,
            "recent_invitation_count": invited,
            "invitation_response_rate": round(rate, 2),
            "invitation_response_rate_gap": round(rate - required, 2),
            "recent_invitation_minimum": minimum,
            "invitation_window_years": window,
            "invitation_response_rate_minimum": required,
        },
    )


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
    minimum = constraint.int_("min_invitations", 2)
    ceiling = constraint.float_("max_response_rate", 0.0)
    thresholds = {
        "veteran_career_minimum": span,
        "veteran_invitation_minimum": minimum,
        "veteran_response_rate_maximum": ceiling,
    }
    if career is None or career < span:
        return RuleOutcome(
            constraint.name,
            True,
            "not a long-career candidate",
            facts={
                "veteran_career_known": int(career is not None),
                "veteran_career_years": career,
                **thresholds,
            },
        )
    invited, rate = _response_rate(rows, None, now_year)
    if invited < minimum:
        return RuleOutcome(
            constraint.name,
            True,
            f"{career}-year career, {invited} invitation(s) on record — no basis to judge",
            abstained=True,
            facts={
                "veteran_career_known": 1,
                "veteran_career_years": career,
                "veteran_invitation_count": invited,
                **thresholds,
            },
        )
    if rate > ceiling:
        return RuleOutcome(
            constraint.name,
            True,
            f"{career}-year career, responds to {rate:.0%} of invitations",
            facts={
                "veteran_career_known": 1,
                "veteran_career_years": career,
                "veteran_invitation_count": invited,
                "veteran_response_rate": round(rate, 2),
                **thresholds,
            },
        )
    return RuleOutcome(
        constraint.name,
        False,
        f"{career}-year career and no response to {invited} invitation(s) — "
        "appears to have stopped accepting review work",
        excluding=constraint.excluding,
        facts={
            "veteran_career_known": 1,
            "veteran_career_years": career,
            "veteran_invitation_count": invited,
            "veteran_response_rate": round(rate, 2),
            **thresholds,
        },
    )


def assess_academic_age(person: Person, policy: Policy, now_year: int) -> RuleOutcome:
    """Years since the doctorate, against the journal's window.

    Advisory rather than excluding, and it was advisory in a way nothing could
    check: it only ever produced a note, and only when the note said something,
    so a reader could not tell a candidate the rule cleared from one it never
    examined. As an outcome it reports either way, and the doctorate year that
    ORCID states for a minority of people shows up as an abstention rather than
    as a silent pass.
    """
    minimum = policy.min_academic_age
    maximum = policy.max_academic_age
    thresholds = {"academic_age_minimum": minimum, "academic_age_maximum": maximum}
    age = person.academic_age(now_year)
    if age is None:
        return RuleOutcome(
            "academic_age",
            True,
            "no doctorate year on record — academic age not assessed",
            abstained=True,
            facts={"academic_age_known": 0, **thresholds},
        )
    facts = {
        "academic_age_known": 1,
        "academic_age_value": age,
        "academic_age_gap": age - minimum,
        **thresholds,
    }
    if age < minimum:
        return RuleOutcome(
            "academic_age",
            False,
            f"academic age {age} is below the journal minimum of {minimum}",
            facts=facts,
        )
    if maximum and age > maximum:
        return RuleOutcome(
            "academic_age",
            False,
            f"academic age {age} exceeds the journal maximum of {maximum}",
            facts=facts,
        )
    return RuleOutcome("academic_age", True, f"academic age {age}", facts=facts)


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
        policy.restricted_country,
    )
    if all(constraint.off for constraint in constraints):
        return Assessment()

    years = repo.publication_years(conn, person.person_id)
    works_by_year = person.works_by_year or repo.output_by_year(conn, person.person_id)
    history = repo.invitation_history(conn, person.person_id)

    activity, doctoral, career, invitations, veteran, restricted = constraints
    outcomes = []
    if not restricted.off:
        outcomes.append(_restricted_country(person, restricted))
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
