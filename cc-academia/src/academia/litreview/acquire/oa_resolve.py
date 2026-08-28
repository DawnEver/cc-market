"""Open-access PDF resolution and source ranking.

Publisher pages (IEEE Xplore, Springer Link) sit behind Cloudflare Turnstile and
defeat automated download. Institutional repositories and preprint servers serve
the same PDF over plain HTTP. This module answers, for a given DOI, "where else
can I get this?" and orders the answers so the cheapest, most reliable source is
tried first.

Priority (mirrors AGENTS.md § PDF Download Strategy):
    repository > preprint > aggregator (ResearchGate) > publisher > unknown
"""

from __future__ import annotations

import json
import os
from typing import Any
from urllib.parse import urlparse

from academia.litreview.acquire import net

# Lower rank sorts first.
RANK_REPOSITORY = 0
RANK_PREPRINT = 1
RANK_AGGREGATOR = 2
RANK_PUBLISHER = 3
RANK_UNKNOWN = 4
RANK_DOI_REDIRECT = 5  # bare doi.org — just redirects to the publisher wall
RANK_SEARCH_PAGE = 9  # not a paper URL at all — always last resort

TIMEOUT = 15

# Host fragments that identify an institutional / national repository. Path
# markers catch the long tail of DSpace, Pure, and EPrints installations whose
# hostnames we cannot enumerate.
_REPOSITORY_HOSTS = (
    ".edu", ".ac.uk", ".uni-", "repo.", "repository.", "eprints.", "dspace.",
    "hal.science", "diva-portal.org", "zenodo.org", "figshare.com",
    "europepmc.org", "ncbi.nlm.nih.gov", "core.ac.uk",
    "hdl.handle.net", "research-information.", "pure.",
)
_REPOSITORY_PATHS = (
    "/bitstream/", "/portalfiles/", "/ws/files/", "/eprint/", "/handle/",
    "/server/api/core/bitstreams/",
)
_PREPRINT_HOSTS = (
    "arxiv.org", "techrxiv.org", "biorxiv.org", "medrxiv.org", "ssrn.com",
    "preprints.org", "osf.io", "hal.archives-ouvertes.fr",
)
_AGGREGATOR_HOSTS = ("researchgate.net", "academia.edu", "semanticscholar.org")
_PUBLISHER_HOSTS = (
    "ieee.org", "springer.com", "sciencedirect.com", "wiley.com", "acm.org",
    "tandfonline.com", "mdpi.com", "iop.org", "sagepub.com", "elsevier.com",
)
# Query/search endpoints return result lists, never a PDF.
_SEARCH_MARKERS = ("/search/", "/search?", "?q=", "&q=", "/results")


def rank_url(url: str) -> int:
    """Classify *url* into a download-priority bucket (lower tries first)."""
    if not url:
        return RANK_UNKNOWN
    lowered = url.lower()
    if any(marker in lowered for marker in _SEARCH_MARKERS):
        return RANK_SEARCH_PAGE
    host = (urlparse(lowered).hostname or "")
    path = urlparse(lowered).path

    if any(fragment in host for fragment in _REPOSITORY_HOSTS):
        return RANK_REPOSITORY
    if any(marker in path for marker in _REPOSITORY_PATHS):
        return RANK_REPOSITORY
    if any(fragment in host for fragment in _PREPRINT_HOSTS):
        return RANK_PREPRINT
    if any(fragment in host for fragment in _AGGREGATOR_HOSTS):
        return RANK_AGGREGATOR
    if any(fragment in host for fragment in _PUBLISHER_HOSTS):
        return RANK_PUBLISHER
    if host.endswith("doi.org"):
        return RANK_DOI_REDIRECT
    return RANK_UNKNOWN


def rank_urls(urls: list[str]) -> list[str]:
    """Deduplicate and sort *urls* by download priority (stable within a rank)."""
    seen: set[str] = set()
    unique: list[str] = []
    for url in urls:
        cleaned = (url or "").strip()
        if cleaned and cleaned not in seen:
            seen.add(cleaned)
            unique.append(cleaned)
    return sorted(unique, key=rank_url)


# ---------------------------------------------------------------------------
# Providers — each returns candidate PDF/landing URLs for a DOI, or [] on miss
# ---------------------------------------------------------------------------

def _get_json(url: str, params: dict[str, str] | None = None) -> Any:
    response = net.get(
        url, params=params, timeout=TIMEOUT, accept="application/json",
    )
    if response.status_code != 200:
        return None
    try:
        return response.json()
    except (ValueError, json.JSONDecodeError):
        return None


def _contact_email() -> str:
    """Unpaywall and OpenAlex require a contact address in the polite pool."""
    return os.environ.get("LIT_REVIEW_CONTACT", "").strip() or "literature-review@example.com"


def _unpaywall_urls(doi: str) -> list[str]:
    data = _get_json(f"https://api.unpaywall.org/v2/{doi}", {"email": _contact_email()})
    if not isinstance(data, dict):
        return []
    urls: list[str] = []
    for location in data.get("oa_locations") or []:
        if not isinstance(location, dict):
            continue
        urls.extend(str(location.get(key) or "") for key in ("url_for_pdf", "url_for_landing_page"))
    return [u for u in urls if u]


def _openalex_urls(doi: str) -> list[str]:
    data = _get_json(f"https://api.openalex.org/works/doi:{doi}", {"mailto": _contact_email()})
    if not isinstance(data, dict):
        return []
    locations = list(data.get("locations") or [])
    for key in ("best_oa_location", "primary_location", "open_access"):
        value = data.get(key)
        if isinstance(value, dict):
            locations.append(value)
    urls: list[str] = []
    for location in locations:
        if not isinstance(location, dict):
            continue
        urls.extend(
            str(location.get(key) or "")
            for key in ("pdf_url", "landing_page_url", "oa_url")
        )
    return [u for u in urls if u]


def _semantic_scholar_urls(doi: str) -> list[str]:
    data = _get_json(
        f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi}",
        {"fields": "openAccessPdf,externalIds,url"},
    )
    if not isinstance(data, dict):
        return []
    urls: list[str] = []
    oa_pdf = data.get("openAccessPdf")
    if isinstance(oa_pdf, dict) and oa_pdf.get("url"):
        urls.append(str(oa_pdf["url"]))
    arxiv_id = (data.get("externalIds") or {}).get("ArXiv") if isinstance(data.get("externalIds"), dict) else None
    if arxiv_id:
        urls.append(f"https://arxiv.org/pdf/{arxiv_id}")
    return urls


# Resolved by name at call time so tests (and future plugins) can substitute one.
_PROVIDER_NAMES = ("_unpaywall_urls", "_openalex_urls", "_semantic_scholar_urls")


def resolve_oa_urls(doi: str, title: str | None = None) -> list[str]:
    """Return ranked open-access URLs for *doi*.

    Every provider is best-effort: a network failure or schema change in one
    must not sink the whole download run, so failures degrade to no results.
    """
    doi = (doi or "").strip().removeprefix("https://doi.org/").removeprefix("doi:")
    if not doi:
        return []
    collected: list[str] = []
    for name in _PROVIDER_NAMES:
        try:
            collected.extend(globals()[name](doi))
        except Exception:
            continue
    return rank_urls(collected)
