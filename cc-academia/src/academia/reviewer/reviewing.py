"""What the workbook states about a candidate *as a reviewer*.

Every run produces these from public sources, for every candidate:

| Signal | Source |
|--------|--------|
| public reviews, per journal, recency, reviewed for this journal | ORCID peer-review section (mostly written there by Web of Science) |
| articles in the window | OpenAlex yearly output (``person_output``) |
| invitations in the last months, still open; status on this manuscript | the store's invitation record (``review_history``) |
| most relevant works | this run's own evidence |

An imported ScholarOne page adds the Reviewer Locator's own numbers in
``locator_*`` columns — verified reviews, articles, workload, R-Score. Those
exist nowhere public, so they are shown only when imported and never
approximated.

Nothing here excludes anybody or moves a score. Unknown is blank, never 0: no
ORCID, or a record nobody read, is a gap in the data rather than a reviewer who
has never reviewed. ``review_record`` is a hint that reads "Check by hand" at
most.
"""

from __future__ import annotations

import sqlite3
from datetime import date
from typing import Any

from academia.reviewer.policy import Policy
from academia.reviewer.rank import Candidate
from academia.store import repository as repo

NOT_INVITED = "not yet invited"

#: Every column ``signals`` can return, in reading order. The review-record
#: columns are absent when that check is switched off.
COLUMNS = (
    "found_by",
    "invitation_status",
    "reviews",
    "reviews_source",
    "reviews_by_journal",
    "reviewed_target_journal",
    "reviews_last_12_months",
    "days_since_last_review",
    "articles_window",
    "articles_window_years",
    "invitations_last_12_months",
    "invitations_open",
    "relevant_works",
    "orcid_url",
    "locator_reviews",
    "locator_articles",
    "locator_reviews_by_journal",
    "locator_load",
    "locator_days_since_review",
    "locator_r_score",
    "locator_works",
    "locator_wos_url",
    "review_record",
    "review_record_ratio",
    "review_record_reasons",
    "review_record_reviews_minimum",
    "review_record_ratio_minimum",
    "review_record_countries_minimum",
)

#: How many entries a compact text cell lists before it says "…".
COMPACT = 5
WORKS_SHOWN = 3


def _day(value: str) -> date | None:
    """A review date at whatever precision ORCID gives, at its earliest day."""
    parts = (value or "").split("-")
    try:
        year = int(parts[0])
        month = int(parts[1]) if len(parts) > 1 else 1
        day = int(parts[2]) if len(parts) > 2 else 1
        return date(year, month, day)
    except (ValueError, IndexError):
        return None


def _months_ago(today: date, months: int) -> date:
    year, month = divmod(today.year * 12 + today.month - 1 - months, 12)
    return date(year, month + 1, min(today.day, 28))


def invitation_status(conn: sqlite3.Connection, person_id: str, ms_id: str) -> str:
    """Where this person stands on *this* manuscript.

    ``returned`` needs the editorial system — only an imported page says a
    review came back. The rest reads ``review_history``, so an invitation
    recorded with ``rev-disc invite`` counts exactly like an imported one.
    """
    row = conn.execute(
        "SELECT responded, accepted FROM review_history WHERE person_id = ? AND ms_id = ?",
        (person_id, ms_id),
    ).fetchone()
    imported = next(
        (r["data"] for r in repo.editorial_invitations(conn, ms_id) if r["person_id"] == person_id),
        None,
    )
    if imported and imported.get("returned"):
        return "returned"
    if row is None:
        return NOT_INVITED
    if row["accepted"]:
        return "agreed"
    if row["accepted"] == 0 or (row["responded"] and not row["accepted"]):
        return "declined"
    return "invited"


def _compact(pairs: list[tuple[str, int]]) -> str:
    ordered = sorted(pairs, key=lambda kv: (-kv[1], kv[0]))
    text = "; ".join(f"{name} {count}" for name, count in ordered[:COMPACT])
    return text + ("; …" if len(ordered) > COMPACT else "")


def _is_target(name: str, group_id: str, policy: Policy) -> bool:
    target = str(policy.data.get("journal") or "").strip().lower()
    issns = {str(i).lower() for i in policy.data.get("issns") or []}
    issn = group_id.partition(":")[2].lower() if group_id.lower().startswith("issn:") else ""
    return bool((target and name.strip().lower() == target) or (issn and issn in issns))


def _work_line(title: str, venue: str, year: Any, doi: str) -> str:
    where = ", ".join(str(v) for v in (venue, year) if v)
    link = f"https://doi.org/{doi}" if doi else ""
    return " — ".join(part for part in (title, where, link) if part)


def _record_check(
    conn: sqlite3.Connection,
    candidate: Candidate,
    policy: Policy,
    reviews: int | str,
    articles: int | str,
    locator: dict | None,
    today: date,
) -> dict[str, Any]:
    settings = (policy.data.get("reviewing") or {}).get("record_check") or {}
    if str(settings.get("mode", "off")) == "off":
        return {}
    min_reviews = int(settings.get("min_reviews", 20))
    min_ratio = float(settings.get("min_reviews_per_article", 2.0))
    min_countries = int(settings.get("min_countries", 3))
    free = {str(d).lower() for d in settings.get("free_mail_domains") or []}
    out: dict[str, Any] = {
        "review_record_reviews_minimum": min_reviews,
        "review_record_ratio_minimum": min_ratio,
        "review_record_countries_minimum": min_countries,
        "review_record_ratio": "",
        "review_record_reasons": "",
    }
    if reviews == "" or articles == "":
        out["review_record"] = "VERIFY"
        out["review_record_reasons"] = "review count or article count unknown"
        return out
    ratio = (reviews / articles) if articles else float("inf")
    out["review_record_ratio"] = round(ratio, 2) if articles else ""
    reasons: list[str] = []
    if reviews >= min_reviews and ratio >= min_ratio:
        emails = [row["email"] for row in repo.emails_of(conn, candidate.person.person_id)]
        if emails and all(e.partition("@")[2].lower() in free for e in emails):
            reasons.append("only a non-institutional address is known")
        horizon = today.year - int(
            (policy.data.get("reviewing") or {}).get("article_window_years", 5)
        )
        countries = {
            a.country_code
            for a in candidate.person.affiliations
            if a.country_code
            and (a.is_current or (a.year_to or a.year_from or today.year) >= horizon)
        }
        for _, country in (locator or {}).get("affiliations") or []:
            if country:
                countries.add(country)
        if len(countries) >= min_countries:
            reasons.append(f"affiliations in {len(countries)} countries")
        if reasons:
            shown = f"{ratio:.1f}" if articles else "no articles"
            reasons.insert(
                0, f"{reviews} reviews against {articles} articles ({shown} per article)"
            )
    out["review_record"] = "REVIEW" if reasons else "PASS"
    out["review_record_reasons"] = "; ".join(reasons)
    return out


def signals(
    conn: sqlite3.Connection,
    candidate: Candidate,
    policy: Policy,
    *,
    ms_id: str,
    today: date,
    harvested: bool,
) -> dict[str, Any]:
    """Every reviewing column for one candidate, keyed by column name.

    ``harvested`` says whether this run found them as an author of related
    work. It is not read off the evidence: a candidate proposed from outside
    has their own works scored, and having evidence does not make them ours.
    """
    person = candidate.person
    settings = policy.data.get("reviewing") or {}
    window = int(settings.get("article_window_years", 5))
    # Twelve months, fixed: the column names say so, and it is the window the
    # Reviewer Locator's own workload figure uses.
    since = _months_ago(today, 12)

    locator = next(
        (
            r["data"]
            for r in repo.locator_suggestions(conn, ms_id)
            if r["person_id"] == person.person_id
        ),
        None,
    )
    found_by = "both" if harvested and locator else ("locator" if locator else "ours")

    check, rows = repo.review_record(conn, person.person_id)
    by_journal: dict[str, int] = {}
    target = False
    dates = []
    for row in rows:
        name = row["journal"] or row["group_id"] or "unnamed venue"
        by_journal[name] = by_journal.get(name, 0) + 1
        target = target or _is_target(name, row["group_id"] or "", policy)
        if (day := _day(row["completed"] or "")) is not None:
            dates.append(day)
    known = check is not None
    latest = max(dates, default=None)

    locator_journals = [
        (str(j), int(n)) for j, n in (locator or {}).get("reviews_by_journal") or []
    ]
    locator_target = any(_is_target(j, "", policy) for j, _ in locator_journals)
    if known or locator:
        reviewed_target: bool | str = target or locator_target
    else:
        reviewed_target = ""

    works = person.works_by_year
    articles: int | str = (
        sum(n for year, n in works.items() if year > today.year - window) if works else ""
    )

    history = repo.invitation_history(conn, person.person_id)
    recent = [h for h in history if (_day(h["invited_at"] or "") or date.min) >= since]

    evidence = sorted(candidate.evidence, key=lambda e: -e.similarity)[:WORKS_SHOWN]
    locator_works = ((locator or {}).get("works") or [])[:WORKS_SHOWN]

    reviews: int | str = len(rows) if known else ""
    out: dict[str, Any] = {
        "found_by": found_by,
        "invitation_status": invitation_status(conn, person.person_id, ms_id),
        "reviews": reviews,
        "reviews_source": (check["source"] if known else "unknown"),
        "reviews_by_journal": _compact(list(by_journal.items())),
        "reviewed_target_journal": reviewed_target,
        "reviews_last_12_months": sum(1 for d in dates if d >= since) if known else "",
        "days_since_last_review": (today - latest).days if latest else "",
        "articles_window": articles,
        "articles_window_years": window,
        "invitations_last_12_months": len(recent),
        "invitations_open": sum(1 for h in history if h["responded"] is None),
        "relevant_works": "\n".join(_work_line(e.title, e.venue, e.year, e.doi) for e in evidence),
        "orcid_url": f"https://orcid.org/{person.orcid}" if person.orcid else "",
        "locator_reviews": (locator or {}).get("verified_reviews", "") if locator else "",
        "locator_articles": _blank((locator or {}).get("articles")),
        "locator_reviews_by_journal": _compact(locator_journals),
        "locator_load": (
            f"{_blank(locator.get('current_assignments'))} / "
            f"{_blank(locator.get('past_year_assignments'))}"
            if locator
            else ""
        ),
        "locator_days_since_review": _blank((locator or {}).get("days_since_last_review")),
        "locator_r_score": _blank((locator or {}).get("r_score")),
        "locator_works": "\n".join(
            _work_line(w.get("title", ""), w.get("venue", ""), w.get("year"), w.get("doi", ""))
            for w in locator_works
        ),
        "locator_wos_url": (locator or {}).get("wos_url", ""),
    }
    # The hint prefers the Locator's verified counts where they were imported,
    # because Web of Science sees every verified review and ORCID only the ones
    # the reviewer chose to publish.
    hint_reviews = out["locator_reviews"] if locator else reviews
    hint_articles = (
        out["locator_articles"] if locator and out["locator_articles"] != "" else articles
    )
    out.update(_record_check(conn, candidate, policy, hint_reviews, hint_articles, locator, today))
    return out


def _blank(value: Any) -> Any:
    return "" if value is None else value
