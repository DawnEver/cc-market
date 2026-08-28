"""One HTTP policy for acquisition.

Timeouts, user-agent, and retry/backoff used to be re-decided in every module
that reached the network, so a change to politeness policy meant finding all
of them. This is the single place.

Retries cover transient faults and explicit rate limiting only. A 403 or 404
is an answer, not a hiccup: retrying it wastes time and, on a rate-limited
host, is what escalates a challenge into a ban.
"""

from __future__ import annotations

import time
from typing import Any

import requests

from academia.core.http import polite_user_agent

DEFAULT_TIMEOUT = 30
MAX_RETRIES = 3
BACKOFF_BASE_S = 1.5

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})


def default_headers(referer: str = "", accept: str = "") -> dict[str, str]:
    headers = {
        "User-Agent": BROWSER_UA,
        "Accept": accept or "application/pdf,text/html;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.9",
        "X-Contact": polite_user_agent(),
    }
    if referer:
        # Repository file endpoints reject hotlinked requests; arriving "from"
        # the landing page is what an ordinary reader looks like.
        headers["Referer"] = referer
    return headers


def new_session() -> requests.Session:
    return requests.Session()


def get(
    url: str,
    *,
    session: Any = None,
    referer: str = "",
    accept: str = "",
    timeout: int = DEFAULT_TIMEOUT,
    retries: int = MAX_RETRIES,
    **kwargs: Any,
) -> Any:
    """GET with polite headers and backoff on transient failures.

    Returns the final response (even a failing one) or raises the last
    transport exception if every attempt failed to connect.
    """
    getter = session.get if session is not None else requests.get
    last_error: Exception | None = None
    response: Any = None

    for attempt in range(retries):
        try:
            response = getter(
                url, timeout=timeout, allow_redirects=True,
                headers=default_headers(referer, accept), **kwargs,
            )
        except Exception as error:
            last_error = error
            response = None

        if response is not None and response.status_code not in RETRY_STATUSES:
            return response
        if attempt < retries - 1:
            time.sleep(BACKOFF_BASE_S * (2 ** attempt))

    if response is not None:
        return response
    raise last_error if last_error else RuntimeError(f"no response from {url}")
