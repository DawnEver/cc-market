"""Agent-owned public lookup worklists, answers, and attempt audit state.

This subsystem describes open-world reachability work. It is separate from
contact extraction, which only fetches and attributes addresses from supplied
pages and published papers.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from academia.core.models import Person, utcnow


def lookup_worklist(
    people: list[Person], *, resolved: set[str] | None = None
) -> list[dict[str, str]]:
    """Candidates with no address yet, with enough context to resolve one.

    Automatic discovery reaches roughly a fifth of candidates in this field, and
    that is a property of the data rather than a gap in the code: publisher
    landing pages refuse IEEE, MDPI and IET; no repository copies exist; and
    Crossref carries no addresses at all. Each of those was measured, not
    assumed.

    What closes the rest is a search — the thing an editor does by hand and the
    one step the CLI cannot take, having no search tool and no business
    guessing. So it hands over a worklist instead of a column of "not found",
    and accepts the answer back as a URL whose page it will read itself. The
    rule survives the detour: the address is still *found on a page*, never
    constructed from a name and a domain.

    ``resolved`` is the set of person ids that already have an address.
    """
    already = resolved or set()
    from academia.reviewer.seniority import UNKNOWN

    items: list[dict[str, str]] = []
    for person in people:
        needs = []
        if person.person_id not in already:
            needs.append("email")
        if person.rank == UNKNOWN and not person.stated_title:
            needs.append("position")
        if not needs:
            continue
        affiliation = person.current_affiliation
        institution = affiliation.institution if affiliation else ""
        query = " ".join(filter(None, [person.display_name, institution, "faculty profile"]))
        items.append(
            {
                "person_id": person.person_id,
                "name": person.display_name,
                "institution": institution,
                "orcid": person.orcid,
                "needs": needs,
                "suggested_query": query,
            }
        )
    return items


@dataclass
class LookupAttempt:
    """One explicit public-web search attempt for a candidate."""

    person_id: str
    searched_at: str = ""
    queries: list[str] = field(default_factory=list)
    urls_seen: list[str] = field(default_factory=list)
    urls_selected: list[str] = field(default_factory=list)
    outcome: str = ""

    def as_dict(self) -> dict:
        return {
            "person_id": self.person_id,
            "searched_at": self.searched_at or utcnow(),
            "queries": self.queries,
            "urls_seen": self.urls_seen,
            "urls_selected": self.urls_selected,
            "outcome": self.outcome,
        }


LOOKUP_OUTCOMES = {"found", "no_public_data", "blocked", "skipped"}


@dataclass
class Lookups:
    """What a search turned up, ready to be recorded with its provenance."""

    urls: dict[str, list[str]] = field(default_factory=dict)
    ranks: dict[str, tuple[str, str]] = field(default_factory=dict)
    #: person_id -> (institution, year_from, year_to, source_url). Read off a
    #: bio or a staff page by whoever did the search; the doctoral floor cannot
    #: be applied to anybody whose years nobody has stated.
    doctorates: dict[str, tuple[str, int | None, int | None, str]] = field(default_factory=dict)
    #: person_id -> (institution, country_code, source_url). A bibliographic
    #: database can attach someone to an institution they never worked at, and
    #: the country it implies then feeds the geographic score. A correction read
    #: off their own staff page outranks it — with the page recorded.
    affiliations: dict[str, tuple[str, str, str]] = field(default_factory=dict)
    attempts: list[LookupAttempt] = field(default_factory=list)


def read_lookups(path) -> Lookups:
    """Read the answers to a `rev-disc contacts` worklist.

    Three shapes per candidate, so the simple case stays simple::

        "person-1": "https://a.edu/x"
        "person-2": ["https://a.edu/x", "https://lab.example/y"]
        "person-3": {"urls": [...], "rank": "professor", "rank_source": "https://..."}
        "person-4": {"rank": "phd_student", "rank_source": "https://...",
                     "phd_start_year": 2022, "doctorate_source": "https://..."}
        "person-5": {"institution": "University of Sheffield", "institution_country": "GB",
                     "institution_source": "https://..."}

    ``phd_start_year`` and ``phd_year`` are the enrolment and award years of the
    doctorate, and ``doctorate_source`` is the page or author biography that
    stated them — an IEEE paper's author block usually does. Without them the
    doctoral-year floor has nothing to measure and every student passes.

    A rank must come with the URL that stated it. Whoever did the search read a
    page; the dossier records which one, so the claim stays checkable — the same
    rule that governs addresses, applied to the one field a regex could not read
    reliably enough to be trusted.
    """
    import json
    from pathlib import Path

    from academia.core.errors import UsageError
    from academia.reviewer.seniority import KNOWN_RANKS

    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UsageError(f"could not read {path}: {error}") from error
    if not isinstance(data, dict):
        raise UsageError(f"{path} must hold an object mapping person_id to a URL or list")

    lookups = Lookups()
    for person_id, value in data.items():
        key = str(person_id)
        if isinstance(value, dict):
            raw_urls = value.get("urls") or []
            rank = as_text_or_empty(value.get("rank"))
            if rank:
                if rank not in KNOWN_RANKS:
                    raise UsageError(
                        f"{key}: unrecognised rank {rank!r}. "
                        f"Expected one of: {', '.join(sorted(KNOWN_RANKS))}"
                    )
                source = as_text_or_empty(value.get("rank_source"))
                if not source:
                    raise UsageError(
                        f"{key}: a rank needs rank_source — the URL of the page stating it"
                    )
                lookups.ranks[key] = (rank, source)

            phd_start = _year_or_none(key, "phd_start_year", value.get("phd_start_year"))
            phd_end = _year_or_none(key, "phd_year", value.get("phd_year"))
            if phd_start or phd_end:
                doctorate_source = as_text_or_empty(value.get("doctorate_source"))
                if not doctorate_source:
                    raise UsageError(
                        f"{key}: a doctorate year needs doctorate_source — the URL of "
                        "the page or author biography stating it"
                    )
                lookups.doctorates[key] = (
                    as_text_or_empty(value.get("doctorate_institution")),
                    phd_start,
                    phd_end,
                    doctorate_source,
                )
            institution = as_text_or_empty(value.get("institution"))
            if institution:
                institution_source = as_text_or_empty(value.get("institution_source"))
                if not institution_source:
                    raise UsageError(
                        f"{key}: an institution needs institution_source — the URL of "
                        "the page stating where they work now"
                    )
                country = as_text_or_empty(value.get("institution_country")).upper()
                if country and len(country) != 2:
                    raise UsageError(
                        f"{key}: institution_country must be a two-letter code, got {country!r}"
                    )
                lookups.affiliations[key] = (institution, country, institution_source)
        else:
            raw_urls = value

        urls = [raw_urls] if isinstance(raw_urls, str) else list(raw_urls or [])
        cleaned = [u.strip() for u in urls if isinstance(u, str) and u.strip()]
        if cleaned:
            lookups.urls[key] = cleaned
        outcome = as_text_or_empty(value.get("outcome")) if isinstance(value, dict) else ""
        if outcome and outcome not in LOOKUP_OUTCOMES:
            raise UsageError(
                f"{key}: unrecognised lookup outcome {outcome!r}. "
                f"Expected one of: {', '.join(sorted(LOOKUP_OUTCOMES))}"
            )
        if not outcome:
            outcome = "found"
        queries = _text_list(value.get("queries")) if isinstance(value, dict) else []
        urls_seen = _text_list(value.get("urls_seen")) if isinstance(value, dict) else []
        searched_at = as_text_or_empty(value.get("searched_at")) if isinstance(value, dict) else ""
        lookups.attempts.append(
            LookupAttempt(
                person_id=key,
                searched_at=searched_at,
                queries=queries,
                urls_seen=urls_seen,
                urls_selected=cleaned,
                outcome=outcome,
            )
        )
    return lookups


def _text_list(value) -> list[str]:
    values = [value] if isinstance(value, str) else list(value or [])
    return [item.strip() for item in values if isinstance(item, str) and item.strip()]


def read_lookup_attempts(path) -> list[LookupAttempt]:
    """Read a workspace attempt log; a missing log means nobody searched yet."""
    import json
    from pathlib import Path

    source = Path(path)
    if not source.exists():
        return []
    attempts = []
    for line in source.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        attempts.append(
            LookupAttempt(
                person_id=str(row["person_id"]),
                searched_at=as_text_or_empty(row.get("searched_at")),
                queries=_text_list(row.get("queries")),
                urls_seen=_text_list(row.get("urls_seen")),
                urls_selected=_text_list(row.get("urls_selected")),
                outcome=as_text_or_empty(row.get("outcome")),
            )
        )
    return attempts


def annotate_lookup_status(
    items: list[dict], attempts: list[LookupAttempt], *, total: int
) -> tuple[list[dict], dict[str, int]]:
    """Add attempt state to missing-data items and summarize lookup coverage."""
    latest = {attempt.person_id: attempt for attempt in attempts}
    annotated = []
    for item in items:
        attempt = latest.get(str(item["person_id"]))
        annotated.append(
            {
                **item,
                "searched": attempt is not None,
                "last_outcome": attempt.outcome if attempt else "",
            }
        )
    never_searched = sum(not item["searched"] for item in annotated)
    return annotated, {
        "missing": len(annotated),
        "resolved": max(0, total - len(annotated)),
        "never_searched": never_searched,
    }


def _year_or_none(key: str, field_name: str, value) -> int | None:
    """A four-digit year, or nothing. A malformed one stops the run."""
    from academia.core.errors import UsageError

    if value in (None, ""):
        return None
    try:
        year = int(value)
    except (TypeError, ValueError):
        raise UsageError(f"{key}: {field_name} must be a year, got {value!r}") from None
    if not 1900 <= year <= 2100:
        raise UsageError(f"{key}: {field_name} {year} is not a plausible year")
    return year


def as_text_or_empty(value) -> str:
    return str(value).strip() if isinstance(value, str) else ""


def read_homepage_file(path) -> dict[str, list[str]]:
    """Read ``{person_id: url | [url, ...]}`` written by whoever did the search."""
    import json
    from pathlib import Path

    from academia.core.errors import UsageError

    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise UsageError(f"could not read {path}: {error}") from error
    if not isinstance(data, dict):
        raise UsageError(f"{path} must hold an object mapping person_id to a URL or list")

    resolved: dict[str, list[str]] = {}
    for person_id, value in data.items():
        urls = [value] if isinstance(value, str) else list(value or [])
        cleaned = [u.strip() for u in urls if isinstance(u, str) and u.strip()]
        if cleaned:
            resolved[str(person_id)] = cleaned
    return resolved
