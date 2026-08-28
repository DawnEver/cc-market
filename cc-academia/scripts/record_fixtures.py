#!/usr/bin/env python3
"""Capture live API responses into tests/fixtures/.

Run by hand when a source changes shape; the test suite itself never touches the
network. Fixtures are trimmed to a couple of records so the repository stays
small and reviewable, and they contain only public metadata about published
papers -- no personal contact details.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from academia.core.http import BROWSER_USER_AGENT, build_url, get_json, post_json
from academia.core.paths import contact_email

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"


#: Session-scoped keys IEEE echoes back. They identify the subscriber, not the
#: papers, and have no business in a public repository.
STRIP_KEYS = ("userInfo", "subscribedContentApplied", "promoApplied", "handleProduct")


def sanitize(payload: object) -> object:
    """Drop anything that describes the caller rather than the literature."""
    if isinstance(payload, dict):
        return {k: sanitize(v) for k, v in payload.items() if k not in STRIP_KEYS}
    if isinstance(payload, list):
        return [sanitize(v) for v in payload]
    return payload


def write(name: str, payload: object) -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    path = FIXTURES / name
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(FIXTURES.parents[1])}")


def record_ieee() -> None:
    data, _ = post_json(
        "https://ieeexplore.ieee.org/rest/search",
        {
            "queryText": "permanent magnet synchronous motor torque ripple",
            "newsearch": True,
            "pageNumber": 1,
            "rowsPerPage": 3,
            "searchField": "All Metadata",
        },
        "ieee",
        headers={
            "User-Agent": BROWSER_USER_AGENT,
            "Referer": "https://ieeexplore.ieee.org/search/searchresult.jsp",
            "Origin": "https://ieeexplore.ieee.org",
        },
    )
    data["records"] = (data.get("records") or [])[:3]
    write("ieee_search.json", data)


def record_openalex() -> None:
    mailto = contact_email() or None
    works = get_json(
        build_url(
            "https://api.openalex.org/works",
            {
                "search": "permanent magnet synchronous motor torque ripple",
                "per-page": 3,
                "select": (
                    "id,doi,display_name,publication_year,type,cited_by_count,primary_location,"
                    "best_oa_location,authorships,corresponding_author_ids,keywords,topics,"
                    "referenced_works,abstract_inverted_index"
                ),
                "mailto": mailto,
            },
        ),
        "openalex",
    )
    for record in works.get("results", []):
        record["referenced_works"] = record.get("referenced_works", [])[:5]
    write("openalex_works.json", works)

    author_id = ""
    for record in works.get("results", []):
        for authorship in record.get("authorships", []):
            candidate = (authorship.get("author") or {}).get("id")
            if candidate:
                author_id = str(candidate).rsplit("/", 1)[-1]
                break
        if author_id:
            break

    author = get_json(
        build_url(
            f"https://api.openalex.org/authors/{author_id}",
            {
                "select": (
                    "id,orcid,display_name,display_name_alternatives,affiliations,"
                    "last_known_institutions,topics,works_count,cited_by_count"
                ),
                "mailto": mailto,
            },
        ),
        "openalex",
    )
    write("openalex_author.json", author)


def record_orcid() -> None:
    """Pick an ORCID whose education section is actually populated."""
    mailto = contact_email() or None
    works = get_json(
        build_url(
            "https://api.openalex.org/works",
            {
                "search": "power electronics converter",
                "per-page": 50,
                "filter": "from_publication_date:2023-01-01",
                "select": "authorships",
                "mailto": mailto,
            },
        ),
        "openalex",
    )
    candidates: list[str] = []
    for record in works.get("results", []):
        for authorship in record.get("authorships", []):
            orcid = (authorship.get("author") or {}).get("orcid")
            if orcid:
                candidates.append(str(orcid).rsplit("/", 1)[-1])

    for orcid in dict.fromkeys(candidates):
        educations = get_json(f"https://pub.orcid.org/v3.0/{orcid}/educations", "orcid")
        if not educations.get("affiliation-group"):
            continue
        employments = get_json(f"https://pub.orcid.org/v3.0/{orcid}/employments", "orcid")
        write("orcid_educations.json", educations)
        write("orcid_employments.json", employments)
        return
    print("no ORCID with a populated education section found in this sample", file=sys.stderr)


if __name__ == "__main__":
    which = sys.argv[1:] or ["ieee", "openalex", "orcid"]
    if "ieee" in which:
        record_ieee()
    if "openalex" in which:
        record_openalex()
    if "orcid" in which:
        record_orcid()
