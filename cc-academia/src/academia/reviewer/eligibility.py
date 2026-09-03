"""Who an editor is willing to invite, as opposed to who is qualified.

Expertise says a candidate *could* review the manuscript. Eligibility says the
invitation is worth sending: someone still working in the field, far enough into
their training to carry a report, and not a name that has quietly stopped taking
review work.

Seven rules, and the list is closed — every one is in :data:`RULES`, every one
reads a quantity from :mod:`academia.reviewer.record`, and nothing outside this
module may add a ninth. Three of them used to be appended by ``rank`` after the
assessment was already built, which is how a ``prefer`` rule came to contribute
nothing to the score it exists to feed.

* **restricted country** — currently affiliated somewhere the journal will not
  invite from, read from the affiliation and never from a name
* **related journals** — enough of the relevant record is journal work
* **relevant activity** — publishing on *this* topic, from the run's evidence
* **recent activity** — publishing at all, from their own profile
* **seniority** — far enough past the doctorate, or the first paper
* **doctoral year** — a doctoral candidate is past the journal's floor
* **unresponsive veteran** — a long career *and* a record of unanswered
  invitations, which is the only combination that fires

There was an eighth: a windowed "answered at least half of recent invitations"
rule. It is gone rather than switched off. It asked the veteran rule's question
on a shorter window, so the two fired together or not at all, and on any store
without a long invitation history — every store, so far — both abstained. A
rule that cannot distinguish itself from another is not a rule an editor needs
to read a verdict from.

Every rule carries its own mode: ``require`` excludes, ``prefer`` only scores
and annotates, ``off`` skips it entirely. ``require`` excludes rather than
penalises, because blending an eligibility failure into a score is how somebody
who does not meet the policy climbs back onto a shortlist on expertise alone.

Nothing here is inferred, and a rule with no evidence **abstains**: it passes,
and records that it never judged. An empty invitation history means nobody has
asked this person yet; a missing enrolment year is a gap in ORCID rather than a
fact about a person. Only a stated fact can disqualify somebody, because an
editor has to be able to read the reason and disagree with it.

Each rule's facts are keyed with its own name — ``seniority_years``,
``related_journals_count``. Not tidiness: it is what lets an audit group columns
by the rule that produced them, instead of by a hand-maintained prefix table
that goes stale the moment a rule changes.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from academia.reviewer.policy import Constraint, Policy
from academia.reviewer.record import PROFILE, CandidateRecord
from academia.reviewer.seniority import PHD_STUDENT


@dataclass(frozen=True)
class RuleOutcome:
    """One rule's verdict on one candidate, with the facts behind it."""

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
    #: The numbers this rule compared and the thresholds it compared them
    #: against, each key prefixed with the rule's own name. The prose in
    #: ``detail`` is for reading; this is for auditing — an export lays a column
    #: beside each verdict, and a reader sees how far from a threshold somebody
    #: fell without having to trust the sentence.
    facts: dict[str, Any] = field(default_factory=dict)

    @property
    def excluded(self) -> bool:
        return self.excluding and not self.passed

    @property
    def scored(self) -> bool:
        """Whether this outcome may move the eligibility component.

        A ``require`` rule has already had its say by excluding or not; letting
        it also pay a bonus would dilute a genuine preference failure with gates
        that everybody left standing has passed. An abstention is not a met
        preference either — it is the absence of a measurement.
        """
        return not self.excluding and not self.abstained


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

    @property
    def score(self) -> float:
        """0..1, the share of judged preferences this candidate meets.

        Derived, not stored. It used to be a field set while the assessment was
        being built, with three rules appended to ``outcomes`` afterwards — so
        the number the report published had been computed before a third of the
        rules existed.

        1.0 when nothing was judged, so switching the feature off leaves every
        score exactly where it was.
        """
        judged = [o for o in self.outcomes if o.scored]
        if not judged:
            return 1.0
        return sum(1 for o in judged if o.passed) / len(judged)

    @property
    def excluded(self) -> bool:
        return any(outcome.excluded for outcome in self.outcomes)

    @property
    def reason(self) -> str:
        return "; ".join(o.detail for o in self.outcomes if o.excluded)

    def notes(self) -> list[str]:
        """Every rule that did not pass, whether or not it excluded anybody."""
        return [o.detail for o in self.outcomes if not o.passed]


@dataclass(frozen=True)
class Readiness:
    status: str
    reasons: tuple[str, ...] = ()


def invitation_readiness(
    candidate: Any, email: Any, *, domain_status: str, min_confidence: float
) -> Readiness:
    """One invitation decision, shared by every report and export."""
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
        # A gap in public data, not a fact about the person, and the same rule
        # that keeps a missing doctorate year from disqualifying anybody applies
        # here. The editorial system can address an invitation this tool cannot,
        # so this asks for a human rather than excluding somebody every rule
        # cleared — which is what it used to do, to eight of ten invitable
        # candidates on one live case.
        review.append("no public address found — invite through the editorial system")
    person = candidate.person
    if person.resolution_method == "name_only" or person.confidence < min_confidence:
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


# --------------------------------------------------------------- the rules
#
# Every rule has the same shape: ``(record, constraint) -> RuleOutcome``. It
# reads quantities off the record and thresholds off the constraint, and it
# invents nothing. A rule that cannot measure what it is about abstains.


def _outcome(
    constraint: Constraint,
    passed: bool,
    detail: str,
    facts: dict[str, Any],
    *,
    manual_review: bool = False,
    abstained: bool = False,
    excluding: bool | None = None,
) -> RuleOutcome:
    """Build an outcome, prefixing every fact with the rule's own name."""
    return RuleOutcome(
        constraint.name,
        passed,
        detail,
        excluding=constraint.excluding if excluding is None else excluding,
        manual_review=manual_review,
        abstained=abstained,
        facts={f"{constraint.name}_{key}": value for key, value in facts.items()},
    )


def restricted_country(record: CandidateRecord, constraint: Constraint) -> RuleOutcome:
    """Refuse an invitation to a country the journal will not invite from.

    Reads the current affiliation country, never nationality. An unknown country
    cannot exclude anybody, but it is the one case here an editor has to settle
    by hand: the whole point of the rule is that the answer must not be guessed.
    """
    countries = constraint.upper_set("countries")
    named = ", ".join(sorted(countries))
    country = (record.person.country_code or "").strip().upper()[:2]
    if not country:
        return _outcome(
            constraint,
            True,
            f"current country unknown — confirm it is not {named} before inviting",
            {"countries": named},
            manual_review=True,
        )
    if country in countries:
        return _outcome(
            constraint,
            False,
            f"currently affiliated in {country}, which the journal does not invite from",
            {"current": country, "countries": named},
        )
    return _outcome(
        constraint,
        True,
        f"{country} is not a restricted country",
        {"current": country, "countries": named},
    )


def recent_activity(record: CandidateRecord, constraint: Constraint) -> RuleOutcome:
    """Is this person still publishing at all?

    Read from their own profile's yearly output. Reading the run's harvest asks
    a different question — "did *this manuscript's* queries turn up anything
    recent from them" — under which a live run called 19 of 22 candidates
    dormant, Z. Q. Zhu among them, purely because their latest work is not on
    this manuscript's topic. The source is reported either way.
    """
    window = constraint.int_("recent_years", 3)
    needed = constraint.int_("min_recent_papers", 1)
    thresholds = {"minimum": needed, "window_years": window}
    publications = record.publications
    if not publications.known:
        return _outcome(
            constraint,
            True,
            "no publication record available — activity not assessed",
            thresholds,
            abstained=True,
        )
    count = publications.count_since(record.now_year - window + 1, record.now_year)
    latest = publications.latest_year
    facts = {
        "papers": count,
        "latest_year": latest,
        "source": publications.source,
        **thresholds,
    }
    if count >= needed:
        return _outcome(constraint, True, f"{count} paper(s) in the last {window} years", facts)
    weaker = "" if publications.source == PROFILE else " [harvested papers only]"
    return _outcome(
        constraint,
        False,
        f"only {count} paper(s) in the last {window} years (needs {needed}); "
        f"last published {latest or 'never, on record'}{weaker}",
        facts,
    )


def relevant_activity(record: CandidateRecord, constraint: Constraint) -> RuleOutcome:
    """Publishing on *this* manuscript's topic, inside the window.

    The run's own relevant corpus, not the handful of papers the report shows:
    the shown evidence is capped by how many papers the run kept overall, so a
    median candidate keeps one and any floor above that would be unsatisfiable
    by construction rather than by merit.
    """
    window = constraint.int_("recent_years", 3)
    needed = constraint.int_("min_recent_papers", 1)
    thresholds = {"minimum": needed, "window_years": window}
    if not record.relevant.papers:
        return _outcome(
            constraint,
            True,
            "no relevant papers in this run's corpus — relevance not assessed",
            thresholds,
            abstained=True,
        )
    count = record.relevant.count_since(record.now_year - window + 1, record.now_year)
    latest = record.relevant.latest_year
    facts = {"papers": count, "latest_year": latest, **thresholds}
    if count >= needed:
        return _outcome(
            constraint, True, f"{count} relevant paper(s) in the last {window} years", facts
        )
    return _outcome(
        constraint,
        False,
        f"only {count} relevant paper(s) in the last {window} years (needs {needed}); "
        f"latest relevant paper {latest or 'undated'}",
        facts,
    )


#: Two vocabularies share the venue-type field, because two sources fill it.
#: OpenAlex states the *work* type — ``article``, ``review``,
#: ``conference-paper``, ``preprint`` — and puts the journal's name in the venue
#: instead. IEEE states the *venue* type — ``IEEE Journals``, ``IEEE
#: Conferences``, ``IEEE Standards``, ``Artech Books``. Matching only on the
#: word "journal" reads the second and silently scores every OpenAlex journal
#: paper as a non-journal, which is how a floor of three journal papers came to
#: exclude 149 of 160 candidates whose records were full of them.
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


def related_journals(record: CandidateRecord, constraint: Constraint) -> RuleOutcome:
    """Require journal-published work on the manuscript's own topic.

    Counted over the evidence that qualified the candidate, so it asks "has this
    person written journal papers about *this*", not "how much do they publish".
    A paper whose venue type no source stated is not counted and not held
    against anybody, but it is reported: a candidate who misses the floor only
    on unresolved venues is a data gap, not a weak reviewer.

    Author position is audited, never decisive. A first or last author carried
    the work and a middle author may not have, which an editor reading a
    borderline candidate wants to see — but a supervisor slot is not a
    qualification, so it cannot decide eligibility.
    """
    minimum = constraint.int_("min_publications", 3)
    papers = record.relevant.papers
    if not papers:
        return _outcome(
            constraint,
            True,
            "no relevant papers in this run's corpus — journal record not assessed",
            {"minimum": minimum},
            abstained=True,
        )
    positions = [(getattr(p, "position", "") or "").lower() for p in papers]
    types = [getattr(p, "venue_type", "") or "" for p in papers]
    weights = [float(getattr(p, "position_weight", 0.0) or 0.0) for p in papers]
    count = sum(1 for t in types if is_journal(t))
    unresolved = sum(1 for t in types if not venue_type_stated(t))
    facts = {
        "count": count,
        "minimum": minimum,
        "nonjournal": sum(1 for t in types if venue_type_stated(t) and not is_journal(t)),
        "unresolved": unresolved,
        "first_author": positions.count("first"),
        "last_author": positions.count("last"),
        "leading": sum(1 for p in positions if p in {"first", "last"}),
        "position_weight_mean": round(sum(weights) / len(weights), 2) if weights else None,
    }
    if count >= minimum:
        return _outcome(constraint, True, f"{count} relevant journal publication(s)", facts)
    shortfall = (
        f"only {count} relevant journal publication(s) of {len(papers)} "
        f"relevant paper(s) (needs {minimum})"
    )
    if unresolved and count + unresolved >= minimum:
        # Enough papers to clear the floor, if only their venues were resolved.
        return _outcome(
            constraint,
            True,
            f"{shortfall}; {unresolved} paper(s) of unstated venue type — "
            "resolve the venues before relying on this",
            facts,
            manual_review=True,
        )
    return _outcome(constraint, False, shortfall, facts)


def seniority(record: CandidateRecord, constraint: Constraint) -> RuleOutcome:
    """Position on the one seniority axis: a floor, and a soft ceiling.

    This was two rules. ``academic_age`` set a floor in years since the
    doctorate and ``career_length`` a ceiling in years of publishing, and
    whenever a doctorate year was known they measured the same quantity — one
    from the profile, one from the run's harvest, disagreeing by up to 28 years
    in adjacent columns of the same spreadsheet. One axis is one rule.

    The floor obeys the mode; **the ceiling never excludes**, whatever the mode
    says. Refusing a reviewer for being too experienced is not something an
    editor should be able to state by accident, and it is not hypothetical: this
    journal's ceiling was once ``require``, which removed every senior
    researcher in the pool — the people an editor most wants a report from — and
    left a run with nobody to invite.
    """
    floor = constraint.int_("min_years", 0)
    ceiling = constraint.int_("max_years", 0)
    thresholds = {"minimum": floor, "maximum": ceiling}
    measure = record.seniority
    if measure.years is None:
        return _outcome(
            constraint,
            True,
            "no doctorate year and no dated publication — seniority not assessed",
            thresholds,
            abstained=True,
        )
    facts = {
        "years": measure.years,
        "basis": measure.basis,
        "since": measure.since,
        **thresholds,
    }
    stated = f"{measure.years} year(s) since {measure.basis} ({measure.since})"
    if floor and measure.years < floor:
        return _outcome(constraint, False, f"{stated}, below the floor of {floor}", facts)
    if ceiling and measure.years > ceiling:
        return _outcome(
            constraint,
            False,
            f"{stated}, above the preferred {ceiling} — a preference, not a bar",
            facts,
            excluding=False,
        )
    return _outcome(constraint, True, stated, facts)


def doctoral_year(record: CandidateRecord, constraint: Constraint) -> RuleOutcome:
    """A doctoral candidate has to be past the journal's year of study.

    A different axis from :func:`seniority`, not a special case of it: a student
    has no doctorate to count from, and their year of study is stated on an
    education record rather than derived from a publication history.
    """
    floor = constraint.int_("min_year", 3)
    person = record.person
    if person.rank != PHD_STUDENT:
        return _outcome(
            constraint, True, "not a doctoral candidate", {"is_doctoral": 0, "minimum": floor}
        )
    year = person.doctoral_year(record.now_year)
    if year is None:
        # Not configurable on purpose. ORCID states an enrolment year for a
        # minority of candidates, and a switch that turned that gap into an
        # exclusion would quietly remove the people whose records are thinnest
        # rather than the ones who are too junior.
        return _outcome(
            constraint,
            True,
            "doctoral candidate, year of study not stated — confirm before inviting",
            {"is_doctoral": 1, "minimum": floor},
            manual_review=True,
        )
    facts = {"is_doctoral": 1, "value": year, "minimum": floor}
    if year >= floor:
        return _outcome(
            constraint,
            True,
            f"doctoral candidate in year {year} — confirm before inviting",
            facts,
            manual_review=True,
        )
    return _outcome(
        constraint,
        False,
        f"doctoral candidate in year {year}, below the journal floor of year {floor}",
        facts,
    )


def unresponsive_veteran(record: CandidateRecord, constraint: Constraint) -> RuleOutcome:
    """A long career alone is never a reason. Silence on top of one is.

    Reads the seniority axis for "long career" and the invitation record for
    "silence" — the latter over the whole career rather than a window, because
    the question is whether somebody has stopped taking review work at all, not
    whether they were busy last year.

    It does not publish the career figure as a column of its own. It is the
    same number ``seniority_years`` holds, and two columns carrying one
    quantity is what this refactor exists to remove: the previous pair derived
    it from two different sources and disagreed for 158 of 197 candidates on a
    live case. The rule's sentence states the figure it used, so nothing is
    hidden — only unduplicated.
    """
    span = constraint.int_("career_years", 10)
    minimum = constraint.int_("min_invitations", 2)
    ceiling = constraint.float_("max_response_rate", 0.0)
    thresholds = {
        "career_minimum": span,
        "invitation_minimum": minimum,
        "rate_maximum": ceiling,
    }
    measure = record.seniority
    career = measure.years
    if career is None:
        return _outcome(
            constraint,
            True,
            "no doctorate year and no dated publication — career length unknown",
            thresholds,
            abstained=True,
        )
    basis = f"{career} year(s) since {measure.basis}"
    if career < span:
        return _outcome(
            constraint, True, f"{basis} — not a long-career candidate", thresholds
        )
    invited, rate = record.invitations.resolved(since_year=None, now_year=record.now_year)
    facts = {"invitations": invited, **thresholds}
    if invited < minimum:
        return _outcome(
            constraint,
            True,
            f"{basis}, {invited} invitation(s) on record — no basis to judge",
            facts,
            abstained=True,
        )
    facts["rate"] = round(rate, 2)
    if rate > ceiling:
        return _outcome(
            constraint, True, f"{basis}, responds to {rate:.0%} of invitations", facts
        )
    return _outcome(
        constraint,
        False,
        f"{basis} and no response to {invited} invitation(s) — "
        "appears to have stopped accepting review work",
        facts,
    )


Rule = Callable[[CandidateRecord, Constraint], RuleOutcome]

#: Every rule there is. The list is the whole eligibility surface: an audit
#: column exists because a rule here produced it, and a rule runs because it is
#: here and switched on. Order is the order an audit reads them in — the
#: decisive gates first, the preferences last.
RULES: tuple[tuple[str, Rule], ...] = (
    ("restricted_country", restricted_country),
    ("related_journals", related_journals),
    ("relevant_activity", relevant_activity),
    ("recent_activity", recent_activity),
    ("doctoral_year", doctoral_year),
    ("seniority", seniority),
    ("unresponsive_veteran", unresponsive_veteran),
)

#: The rule names, in audit order. Exports read this rather than restating it.
RULE_NAMES: tuple[str, ...] = tuple(name for name, _ in RULES)


def assess(record: CandidateRecord, policy: Policy) -> Assessment:
    """Run every switched-on rule against one candidate.

    Pure: everything it reads is already on the record, which was built once.
    No caller adds a rule afterwards — three of them used to, by which time the
    score had already been computed.
    """
    outcomes = []
    for name, rule in RULES:
        constraint = policy.constraint(name)
        if constraint.off:
            continue
        outcomes.append(rule(record, constraint))
    return Assessment(outcomes=outcomes)
