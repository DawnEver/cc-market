"""Browser session management and per-paper source planning.

Fetching strategies live in `transport.py`, orchestration in `engine.py`;
this module owns the login profile, the browser launch, and `candidate_urls`.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from academia.litreview.acquire import oa_resolve, researchgate
from academia.litreview.acquire.types import Blocked

# ---------------------------------------------------------------------------
# Playwright setup (inlined from deleted browser/login.py)
# ---------------------------------------------------------------------------

DEFAULT_BROWSER_CHANNEL = "chromium"
DEFAULT_NETWORK_MODE = "direct"
SUPPORTED_BROWSER_CHANNELS = {"chromium", "chrome"}
SUPPORTED_NETWORK_MODES = {"direct", "system"}
COMPLETION_MODES = {"browser-close", "stdin", "none"}
PROFILE_MARKER = ".lit-review-profile"
IEEE_HOME = "https://ieeexplore.ieee.org/"


def _start_playwright():
    from playwright.sync_api import sync_playwright
    return sync_playwright().start()


def _launch_options(channel: str = "chromium", network_mode: str = "direct"):
    opts: dict[str, Any] = {"headless": False}
    if channel == "chrome":
        opts["channel"] = "chrome"
    args = [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
    ]
    if network_mode == "direct":
        args.append("--no-proxy-server")
    opts["args"] = args
    return opts


def _validate_dedicated_profile(profile: Path) -> None:
    marker = profile / PROFILE_MARKER
    if not marker.is_file() and any(profile.iterdir()):
        raise ValueError(f"profile exists but is not a recognized browser profile: {profile}")


def open_login(profile: Path, url: str = IEEE_HOME, browser_channel: str = "chromium",
               completion: str = "browser-close", network_mode: str = "direct") -> int:
    profile.mkdir(parents=True, exist_ok=True)
    _validate_dedicated_profile(profile)
    (profile / PROFILE_MARKER).touch()
    pw = _start_playwright()
    try:
        browser = pw.chromium.launch_persistent_context(
            user_data_dir=str(profile), **_launch_options(browser_channel, network_mode),
        )
        page = browser.new_page()
        page.goto(url)
        if completion == "stdin":
            input("Press Enter after login...")
        elif completion == "browser-close":
            print("Close the browser window when done.")
            page.wait_for_event("close", timeout=0)
        browser.close()
    finally:
        pw.stop()
    print(f"logged-in: {profile}")
    return 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Legacy name for the typed failure. Keeping it an alias (rather than a
# separate class) means old raisers are still classified as BLOCKED.
AccessBlockedError = Blocked

_PROFILE_LOCK_MARKERS = (
    "existing browser", "profile appears to be in use",
    "singletonlock", "failed to create a profilesyncdatatypecontroller",
)


def candidate_urls(item: dict[str, Any], resolve: bool = True) -> list[str]:
    """Build the ordered list of URLs to try for one queue item.

    Screening often records only a publisher landing page (or worse, a search
    URL), which Cloudflare will reject. Resolving the DOI against the OA
    aggregators surfaces repository and preprint mirrors that download cleanly,
    so those are merged in and everything is ranked by source reliability.
    """
    urls: list[str] = []
    for key in ("pdf_url", "oa_url", "html_url", "url"):
        value = str(item.get(key) or "").strip()
        if value:
            urls.append(value)

    doi = str(item.get("doi") or "").strip()
    if doi:
        if resolve:
            urls.extend(oa_resolve.resolve_oa_urls(doi, title=str(item.get("title") or "") or None))
        normalized = doi.removeprefix("https://doi.org/").removeprefix("doi:")
        urls.append(f"https://doi.org/{normalized}")

    # ResearchGate as a systematic last resort: it carries author-uploaded
    # copies of papers no repository or aggregator knows about. Ranked last,
    # so it is only reached once every cheaper source has failed. At most one
    # RG search per paper — its rate limits escalate to an IP ban.
    query = researchgate.query_from_item(item)
    if query and not any(researchgate.is_researchgate_url(u) for u in urls):
        urls.append(researchgate.search_url(query))

    return oa_resolve.rank_urls(urls)



def _is_profile_lock_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(marker in message for marker in _PROFILE_LOCK_MARKERS)


def _kill_stale_chrome() -> bool:
    """Force-close Chrome so a locked profile can be reopened. Returns success."""
    import platform
    import subprocess

    command = (
        ["taskkill", "/F", "/IM", "chrome.exe"]
        if platform.system() == "Windows"
        else ["pkill", "-f", "chrome"]
    )
    try:
        subprocess.run(command, capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        return False
    time.sleep(2)
    return True


def playwright_page(
    profile: Path | None = None,
    browser_channel: str = DEFAULT_BROWSER_CHANNEL,
    network_mode: str = DEFAULT_NETWORK_MODE,
) -> tuple[Any, Callable[[], None]]:
    """Open a browser page for the transports; returns (page, close).

    Uses the dedicated persistent profile when given — that is what carries
    the login and Cloudflare clearance cookies — otherwise a plain headed
    browser, which is enough on a campus IP.
    """
    playwright = _start_playwright()
    browser = None

    if profile is not None:
        _validate_dedicated_profile(profile)
        if not (profile / PROFILE_MARKER).exists():
            raise ValueError("run browser-login first to create the dedicated profile")
        try:
            context = playwright.chromium.launch_persistent_context(
                str(profile.resolve()),
                **_launch_options(browser_channel, network_mode=network_mode),
            )
        except Exception as error:
            # A stale process still holds the profile lock. Only then is killing
            # Chrome justified — doing it unconditionally would close the
            # browser windows the user is actually working in.
            if not _is_profile_lock_error(error) or not _kill_stale_chrome():
                playwright.stop()
                raise
            try:
                context = playwright.chromium.launch_persistent_context(
                    str(profile.resolve()),
                    **_launch_options(browser_channel, network_mode=network_mode),
                )
            except Exception:
                playwright.stop()
                raise
    else:
        browser = playwright.chromium.launch(
            headless=False,
            channel=browser_channel if browser_channel != "chromium" else None,
        )
        context = browser.new_context()

    # Hide the automation markers Cloudflare scores on. Context-level so the
    # patch also reaches cross-origin iframes (Turnstile reads them too).
    context.add_init_script(
        """
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
        Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
        """
    )
    page = context.pages[0] if context.pages else context.new_page()

    def close() -> None:
        try:
            context.close()
            if browser is not None:
                browser.close()
        finally:
            playwright.stop()

    return page, close


# Public entry point lives in engine.py; re-exported so existing callers
# (orchestrator, tests) keep importing it from here.


