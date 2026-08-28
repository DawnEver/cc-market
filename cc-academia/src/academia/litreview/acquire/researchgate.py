"""ResearchGate acquisition — search, then download author-uploaded full text.

ResearchGate hosts author-uploaded copies of papers that are otherwise
paywalled, which makes it the last useful source before giving up on a paper.
It cannot be scraped over plain HTTP (403) and it is aggressive about rate
limiting, so everything here runs through the shared Playwright page.

Getting a PDF takes three hops, none of which a single URL fetch can do:
    search results  →  publication page  →  /download

Bot checks are handled, not bypassed:
  * Requests are paced, because the challenge is mostly triggered by burst rate.
  * Visiting the home page first banks a clearance cookie (a cold hit straight
    on /search reliably challenges).
  * A challenge already showing is waited out, and in a headed browser the user
    can solve it in the visible window — the run picks up automatically.
  * The clearance cookie lives in the browser profile, so one solve covers
    later runs.
"""

from __future__ import annotations

import contextlib
import re
import time
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote_plus, urljoin, urlparse

HOST = "www.researchgate.net"
HOME_URL = f"https://{HOST}/"
SEARCH_ENDPOINT = f"https://{HOST}/search/publication?q="

MAX_CANDIDATES = 3
"""Publication pages opened per paper — each costs a request against the limit."""

REQUEST_PACING_S = 6.0
"""Delay between ResearchGate page loads; bursts are what trigger the check."""

PAGE_SETTLE_MS = 7_000
CHALLENGE_POLL_S = 5.0
CHALLENGE_WAIT_S = 180.0
"""How long to let a challenge clear — long enough for a human to solve it."""

_CHALLENGE_MARKERS = (
    "challenge-platform", "just a moment", "security check required",
    "temporarily unavailable", "unusual activity from your network",
    "cf-challenge", "turnstile",
)
_FULL_TEXT_MARKERS = ("download full-text pdf", "download full-text", "public full-text")

_PUBLICATION_RE = re.compile(r'href="(/?publication/\d+_[^"]+)"', re.IGNORECASE)


_DENIED_MARKERS = (
    "error reference number: 1020", "you do not have access to www.researchgate.net",
    "access denied",
)


class ChallengeError(RuntimeError):
    """ResearchGate showed a bot check that did not clear."""


class AccessDeniedError(RuntimeError):
    """ResearchGate has blocked this IP outright (Cloudflare error 1020).

    This is not a challenge and there is nothing to solve: the network address
    is banned. Retrying makes it worse and risks the institution's reputation
    with the CDN, so the run stops touching ResearchGate entirely.
    """


def is_access_denied(html: str) -> bool:
    lowered = (html or "").lower()
    return any(marker in lowered for marker in _DENIED_MARKERS)


class _CircuitBreaker:
    """Once ResearchGate denies this IP, skip it for the rest of the run."""

    def __init__(self) -> None:
        self.tripped = False

    def trip(self) -> None:
        self.tripped = True

    def reset(self) -> None:
        self.tripped = False


BREAKER = _CircuitBreaker()


def is_researchgate_url(url: str) -> bool:
    return "researchgate.net" in (urlparse(url or "").hostname or "")


def search_url(query: str) -> str:
    return SEARCH_ENDPOINT + quote_plus(query)


def download_url(publication_url: str) -> str:
    return publication_url.rstrip("/") + "/download"


def is_challenged(html: str) -> bool:
    lowered = (html or "").lower()
    return any(marker in lowered for marker in _CHALLENGE_MARKERS)


def has_full_text(html: str) -> bool:
    """True only when RG offers the PDF itself.

    'Request full-text' routes through the author and yields nothing now, so it
    must not be mistaken for availability.
    """
    lowered = (html or "").lower()
    return any(marker in lowered for marker in _FULL_TEXT_MARKERS)


def query_from_item(item: dict[str, Any]) -> str:
    """Best search phrase for a queue item: its title, else a recycled query, else DOI."""
    title = str(item.get("title") or "").strip()
    if title:
        return title

    # Queues written before this module stored a hand-built RG search URL;
    # recover the phrase rather than re-navigating to a bare search page.
    for key in ("html_url", "pdf_url", "url"):
        value = str(item.get(key) or "")
        if is_researchgate_url(value) and "q=" in value:
            terms = parse_qs(urlparse(value).query).get("q") or []
            if terms and terms[0].strip():
                return terms[0].strip()

    return str(item.get("doi") or "").strip()


def extract_publication_links(html: str) -> list[str]:
    """Absolute publication URLs from a search results page.

    RG emits these as relative hrefs with no leading slash and a trailing
    `?_sg=` tracking blob
    both trip up naive matching.
    """
    links: list[str] = []
    seen: set[str] = set()
    for href in _PUBLICATION_RE.findall(html or ""):
        clean = href.split("?")[0].split("#")[0]
        absolute = urljoin(HOME_URL, clean.lstrip("/"))
        if absolute not in seen:
            seen.add(absolute)
            links.append(absolute)
    return links


def _goto(page: Any, url: str, settle_ms: int = PAGE_SETTLE_MS) -> str:
    with contextlib.suppress(Exception):
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(settle_ms)
    try:
        return page.content()
    except Exception:
        return ""


def wait_for_clearance(page: Any, html: str, wait_s: float | None = None) -> str:
    """Poll until the bot check clears; return the cleared HTML.

    We do not attempt to defeat the check. Some resolve on their own, and a
    headed browser lets the user solve the one that does not — either way the
    run continues instead of losing the paper.
    """
    if not is_challenged(html):
        return html
    # Read at call time so the limit stays configurable (and testable).
    limit = CHALLENGE_WAIT_S if wait_s is None else wait_s

    print(
        "  ResearchGate bot check — solve it in the browser window if it does "
        f"not clear on its own (waiting up to {int(limit)}s)...",
        flush=True,
    )
    deadline = time.monotonic() + limit
    while time.monotonic() < deadline:
        time.sleep(CHALLENGE_POLL_S)
        try:
            current = page.content()
        except Exception:
            continue
        # A check can turn into an outright ban while we wait; don't sit on it.
        if is_access_denied(current):
            return current
        if not is_challenged(current):
            print("  bot check cleared, continuing.", flush=True)
            return current
    return html


def _guard_access(html: str) -> None:
    """Trip the breaker and abort if ResearchGate has banned this IP."""
    if is_access_denied(html):
        BREAKER.trip()
        raise AccessDeniedError(
            "ResearchGate denied this IP (Cloudflare error 1020) — not a solvable "
            "check. Skipping ResearchGate; retry from another network or later."
        )


def _load(page: Any, url: str) -> str:
    """Load an RG page, waiting out a bot check if one appears."""
    html = _goto(page, url)
    if is_challenged(html):
        html = wait_for_clearance(page, html)
        if is_challenged(html):
            # A reload often settles it once the clearance cookie is banked.
            html = _goto(page, url)
    return html


def fetch(page: Any, query: str, target: Path, warm_up: bool = True) -> str | None:
    """Search ResearchGate for *query* and save the first full-text PDF.

    Returns the download URL, or None when RG has no downloadable copy — which
    is common and not an error. Raises ChallengeError if a bot check blocks the
    search outright, so the caller can report that distinctly.
    """
    if not query:
        return None
    if BREAKER.tripped:
        raise AccessDeniedError("ResearchGate blocked this IP earlier in the run")

    if warm_up:
        # A cold request to /search is challenged far more often than one made
        # after the home page has set its cookies.
        home = _goto(page, HOME_URL, settle_ms=4_000)
        _guard_access(home)

    html = _load(page, search_url(query))
    _guard_access(html)
    if is_challenged(html):
        raise ChallengeError("ResearchGate bot check did not clear during search")

    for publication in extract_publication_links(html)[:MAX_CANDIDATES]:
        time.sleep(REQUEST_PACING_S)
        page_html = _load(page, publication)
        _guard_access(page_html)
        if is_challenged(page_html) or not has_full_text(page_html):
            continue

        link = download_url(publication)
        try:
            response = page.context.request.get(
                link, timeout=90_000, headers={"Referer": publication},
            )
            body = response.body() if response.status == 200 else b""
        except Exception:
            continue
        if body and body.lstrip().startswith(b"%PDF-"):
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(body)
            return link
    return None
