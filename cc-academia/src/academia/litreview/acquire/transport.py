"""Transports — turn a Source into PDF bytes on disk.

A transport is tried only if it *can* handle a source, and transports are tried
cheapest-first. That replaces a single 221-line function whose nine strategies
ran in a fixed order, with ordering constraints that were implicit and, in one
case, wrong: cookie-banner dismissal sat 118 lines *after* the button click it
was meant to unblock, and the common path returned before ever reaching it.

Here the browser transport makes page preparation (banner dismissal, challenge
clearance) a precondition that runs before any interaction strategy, so the
ordering cannot silently regress.

Contract
--------
`fetch(source, target) -> str | None`
    Return the URL the bytes came from, or None for "not available here, try
    the next transport". Raise `Blocked`/`Denied`/`NotOpenAccess` to state a
    reason that should stop or redirect the search.
"""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, urlencode, urljoin, urlparse

from academia.litreview.acquire import http_fetch, researchgate
from academia.litreview.acquire.types import Blocked, Denied, NotOpenAccess, Source
from academia.litreview.acquire.verify import is_pdf_bytes

# Hosts that answer plain HTTP with a challenge page: only a real browser
# session gets through, so the cheap transport is skipped for them entirely.
BROWSER_ONLY_HOSTS = (
    "ieeexplore.ieee.org", "researchgate.net", "sciencedirect.com",
    "onlinelibrary.wiley.com", "academia.edu", "dl.acm.org",
)

CHALLENGE_MARKERS = (
    "challenge-platform", "cf-challenge", "turnstile",
    "verify you are human", "unusual traffic detected",
)
ACCESS_BLOCK_MARKERS = (
    "access to ieee explore requires", "you are not authorized",
    "please sign in to continue", "purchase this document",
)
COOKIE_ACCEPT_SELECTORS = (
    ".osano-cm-button--type_accept", ".osano-cm-button--type_accept-all",
    "button:has-text('Accept all')", "button:has-text('Accept')",
    "button:has-text('I accept')",
)
PDF_BUTTON_SELECTORS = (
    'a[href*="/stampPDF/"]', "xpl-download-pdf a", "a[xpl-download-pdf]",
    ".xpl-btn-pdf",  # current IEEE Xplore download button (Angular, 2023+)
    'a[href*="/stamp/stamp.jsp"]',  # IEEE stamp.jsp PDF endpoint (current)
    ".document-pdf-link a", ".c-pdf-download__link", 'a[href*="/content/pdf/"]',
    "a:has-text('Download PDF')", "a:has-text('View PDF')",
    'a[aria-label*="PDF"]', 'a[title*="PDF"]', ".pdf-btn",
)

CHALLENGE_RETRIES = 3
CHALLENGE_WAIT_MS = 5_000
CLEARANCE_WAIT_MS = 6_000

# Cloudflare Turnstile: the checkbox sits in a cross-origin iframe whose DOM
# is deliberately hostile to selector automation. The reliable equivalent of
# a human click is a coordinate click on the iframe element's checkbox zone.
TURNSTILE_IFRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"]'
TURNSTILE_CLICK_OFFSET_X = 30  # checkbox sits ~30px from the iframe left edge


def host_of(url: str) -> str:
    return urlparse((url or "").lower()).hostname or ""


def needs_browser(url: str) -> bool:
    return any(blocked in host_of(url) for blocked in BROWSER_ONLY_HOSTS)


class Transport(Protocol):
    """Cheapest transport that can handle a source wins."""

    name: str
    cost: int

    def can_handle(self, source: Source) -> bool: ...

    def fetch(self, source: Source, target: Path) -> str | None: ...


# ---------------------------------------------------------------------------
# 1. Plain HTTP — no browser, no JS
# ---------------------------------------------------------------------------

class HttpTransport:
    """Repositories and preprint servers need nothing more than this.

    When *accept_all* is True (--http-only mode), publisher URLs are also
    attempted — they will likely fail with a challenge page, but the failure
    is logged with a clear reason so the user knows what to download manually.
    """

    name = "http"
    cost = 10

    def __init__(self, accept_all: bool = False) -> None:
        self._accept_all = accept_all

    def can_handle(self, source: Source) -> bool:
        if not source.url:
            return False
        if self._accept_all:
            return True
        return not needs_browser(source.url)

    def fetch(self, source: Source, target: Path) -> str | None:
        return http_fetch.fetch_pdf(source.url, target)


# ---------------------------------------------------------------------------
# 2. Browser — session cookies, JS, and Cloudflare clearance
# ---------------------------------------------------------------------------

class BrowserTransport:
    """Drives a live Playwright page.

    Every strategy below assumes a *prepared* page: banners dismissed and any
    challenge resolved. `_prepare` guarantees that once, up front.
    """

    name = "browser"
    cost = 50

    def __init__(self, page: Any):
        self.page = page
        self._intercepted: list[tuple[str, bytes]] = []

    def can_handle(self, source: Source) -> bool:
        return bool(source.url)

    def fetch(self, source: Source, target: Path) -> str | None:
        url = source.url

        # Fast path: a direct PDF URL may not need the page at all.
        body = self._request_bytes(url, referer="")
        if body is not None:
            target.write_bytes(body)
            return url

        downloads: list[Any] = []
        self._intercepted = []

        # Must be real functions: Playwright stores bookkeeping attributes on
        # the handler, and a builtin method (list.append) has no __dict__.
        def on_download(download: Any) -> None:
            downloads.append(download)

        def on_response(response: Any) -> None:
            # Chrome renders some PDFs inline instead of downloading them, and
            # a Cloudflare-guarded host may serve the page 200 while still
            # refusing an out-of-band context request. Whatever the tab
            # actually received is the most reliable copy available.
            try:
                if response.status != 200:
                    return
                content_type = (response.headers.get("content-type", "") or "").lower()
                if "pdf" not in content_type and not response.url.lower().endswith(".pdf"):
                    return
                body = response.body()
            except Exception:
                return
            if is_pdf_bytes(body):
                self._intercepted.append((response.url, body))

        self.page.on("download", on_download)
        self.page.on("response", on_response)
        try:
            response = self._navigate(url, downloads)
            if downloads:
                downloads[0].save_as(target)
                return downloads[0].url or url

            self._prepare()  # banners + challenge, BEFORE any interaction

            for strategy in (
                self._from_response, self._from_linked_pdf,
                self._from_pdf_button, self._from_ieee_iframe,
            ):
                found = strategy(target, url, response, downloads)
                if found:
                    return found

            self._raise_if_blocked()
            return None
        finally:
            self.page.remove_listener("download", on_download)
            self.page.remove_listener("response", on_response)

    # -- preparation ------------------------------------------------------

    def _prepare(self) -> None:
        self._dismiss_cookie_banner()
        self._await_challenge()

    def _dismiss_cookie_banner(self) -> None:
        for selector in COOKIE_ACCEPT_SELECTORS:
            try:
                button = self.page.locator(selector).first
                if button and button.is_visible():
                    button.click(timeout=5_000)
                    self.page.wait_for_timeout(1_000)
                    return
            except Exception:
                continue

    def _await_challenge(self) -> None:
        """Give a Cloudflare interstitial a chance to resolve itself.

        Order per round: wait for the passive check to clear on its own
        if it
        does not, click the Turnstile checkbox once (coordinate click — the
        iframe DOM resists selectors); wait again. Never loops forever: after
        CHALLENGE_RETRIES rounds the caller classifies the page as Blocked and
        moves on to the next source, so one stubborn host cannot stall a run.
        """
        for attempt in range(CHALLENGE_RETRIES):
            html = self._content().lower()
            if not any(marker in html for marker in CHALLENGE_MARKERS):
                return
            if attempt == CHALLENGE_RETRIES - 1:
                return
            self.page.wait_for_timeout(CHALLENGE_WAIT_MS)
            if not self._still_challenged():
                continue
            self._click_turnstile_checkbox()

    def _still_challenged(self) -> bool:
        html = self._content().lower()
        return any(marker in html for marker in CHALLENGE_MARKERS)

    def _click_turnstile_checkbox(self) -> bool:
        """Click the Cloudflare Turnstile checkbox via iframe coordinates.

        Returns True if a clickable iframe was found. Image-puzzle escalations
        are not attempted
        the outer retry simply lets the page settle.
        """
        try:
            frames = self.page.locator(TURNSTILE_IFRAME_SELECTOR)
            if frames.count() == 0:
                return False
            box = frames.first.bounding_box()
            if not box:
                return False
            x = box["x"] + TURNSTILE_CLICK_OFFSET_X
            y = box["y"] + box["height"] / 2
            self.page.mouse.move(x - 120, y - 60)
            self.page.mouse.move(x, y, steps=18)
            self.page.wait_for_timeout(150)
            self.page.mouse.click(x, y)
            print("  clicked Cloudflare Turnstile checkbox", flush=True)
            return True
        except Exception:
            return False

    # -- strategies -------------------------------------------------------

    def _from_response(self, target, url, response, downloads) -> str | None:
        """The navigation itself returned the PDF."""
        intercepted = self._take_intercepted()
        if intercepted is not None:
            target.write_bytes(intercepted)
            return self._intercepted[-1][0] or url
        if response is None:
            return None
        try:
            content_type = (response.headers.get("content-type", "") or "").lower()
            if "application/pdf" not in content_type:
                return None
            body = response.body()
        except Exception:
            return None
        if is_pdf_bytes(body):
            target.write_bytes(body)
            return response.url or url
        return None

    def _from_linked_pdf(self, target, url, response, downloads) -> str | None:
        """PDF linked in the HTML — the most reliable signal on repositories."""
        html, base = self._content(), self._url() or url
        for link in http_fetch.extract_pdf_links(html, base)[:http_fetch.MAX_LINKS_PER_PAGE]:
            body = self._request_bytes(link, referer=base)
            if body is None:
                # Cloudflare-guarded file endpoint: an out-of-band context
                # request runs no JS and is refused, but the tab itself is
                # allowed to load the file. Navigate, then take whichever copy
                # arrives — the intercepted response or a now-permitted request.
                self._goto(link)
                self.page.wait_for_timeout(CLEARANCE_WAIT_MS)
                body = self._take_intercepted() or self._request_bytes(link, referer=base)
            if body is not None:
                target.write_bytes(body)
                return link
        return None

    def _take_intercepted(self) -> bytes | None:
        """Most recent PDF the tab actually received, if any."""
        return self._intercepted[-1][1] if self._intercepted else None

    def _from_pdf_button(self, target, url, response, downloads) -> str | None:
        for selector in PDF_BUTTON_SELECTORS:
            try:
                button = self.page.locator(selector).first
                if not (button and button.is_visible()):
                    continue
                button.click(timeout=3_000)
            except Exception:
                continue
            for _ in range(6):
                if downloads:
                    downloads[0].save_as(target)
                    return downloads[0].url or url
                self.page.wait_for_timeout(500)
        return None

    def _from_ieee_iframe(self, target, url, response, downloads) -> str | None:
        """Fetch IEEE's PDF endpoint from its current stamp link or old iframe."""
        stamp = ""
        with contextlib.suppress(Exception):
            stamp = self.page.locator('a[href*="/stamp/stamp.jsp"]').first.get_attribute(
                "href", timeout=3_000
            ) or ""
        if stamp:
            query = parse_qs(urlparse(stamp).query)
            number = (query.get("arnumber") or [""])[0]
            if number:
                pdf_url = urljoin(
                    self._url() or url,
                    "/stampPDF/getPDF.jsp?" + urlencode(
                        {"tp": "", "arnumber": number, "ref": ""}
                    ),
                )
                body = self._request_bytes(pdf_url, referer=self._url() or url)
                if body is not None:
                    target.write_bytes(body)
                    return pdf_url
        try:
            src = self.page.locator('iframe[src*="stampPDF/getPDF.jsp"]').first.get_attribute(
                "src", timeout=10_000
            )
        except Exception:
            return None
        if not src:
            return None
        pdf_url = urljoin(self._url() or url, src)
        body = self._request_bytes(pdf_url, referer=self._url() or url)
        if body is not None:
            target.write_bytes(body)
            return pdf_url
        return None

    # -- failure classification -------------------------------------------

    def _raise_if_blocked(self) -> None:
        html = self._content().lower()
        challenge = [m for m in CHALLENGE_MARKERS if m in html]
        if challenge:
            raise Blocked(f"bot check did not clear: {challenge}")
        blocked = [m for m in ACCESS_BLOCK_MARKERS if m in html]
        if blocked:
            raise Blocked(f"access wall: {blocked}")

    # -- page primitives ---------------------------------------------------

    def _navigate(self, url: str, downloads: list[Any]) -> Any:
        try:
            response = self.page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        except Exception as error:
            # Navigating straight to a PDF raises "Download is starting".
            if "download" in str(error).lower():
                for _ in range(10):
                    if downloads:
                        break
                    self.page.wait_for_timeout(500)
            return None
        with contextlib.suppress(Exception):
            self.page.wait_for_load_state("networkidle", timeout=15_000)
        return response

    def _goto(self, url: str) -> None:
        with contextlib.suppress(Exception):
            self.page.goto(url, wait_until="domcontentloaded", timeout=60_000)

    def _request_bytes(self, url: str, referer: str) -> bytes | None:
        headers = {"Referer": referer} if referer else None
        try:
            response = self.page.context.request.get(
                url, timeout=60_000, **({"headers": headers} if headers else {})
            )
            if response.status != 200:
                return None
            body = response.body()
        except Exception:
            return None
        return body if is_pdf_bytes(body) else None

    def _content(self) -> str:
        try:
            return self.page.content()
        except Exception:
            return ""

    def _url(self) -> str:
        try:
            return self.page.url or ""
        except Exception:
            return ""


# ---------------------------------------------------------------------------
# 3. ResearchGate — a site driver, because one URL is not enough
# ---------------------------------------------------------------------------

class ResearchGateTransport:
    """Needs search -> publication -> /download, so it cannot be a plain fetch."""

    name = "researchgate"
    cost = 90

    def __init__(self, page: Any, item: dict[str, Any] | None = None):
        self.page = page
        self.item = item or {}

    def can_handle(self, source: Source) -> bool:
        return researchgate.is_researchgate_url(source.url)

    def fetch(self, source: Source, target: Path) -> str | None:
        query = (
            researchgate.query_from_item(self.item)
            or researchgate.query_from_item({"html_url": source.url})
        )
        if not query:
            return None
        try:
            found = researchgate.fetch(self.page, query, target)
        except researchgate.AccessDeniedError as error:
            raise Denied(str(error)) from error
        except researchgate.ChallengeError as error:
            raise Blocked(str(error)) from error
        if found is None:
            raise NotOpenAccess("ResearchGate has no downloadable full text")
        return found


def default_transports(page: Any | None, item: dict[str, Any] | None = None,
                      http_only: bool = False) -> list[Transport]:
    """Transports in cost order. Without a page, only plain HTTP is possible.

    When *http_only* is True, browser and ResearchGate transports are skipped
    even if a page is available — every paper is attempted via plain HTTP only.
    """
    transports: list[Transport] = [HttpTransport(accept_all=http_only)]
    if page is not None and not http_only:
        transports.append(BrowserTransport(page))
        transports.append(ResearchGateTransport(page, item))
    return sorted(transports, key=lambda t: t.cost)
