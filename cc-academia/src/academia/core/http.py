"""One HTTP layer for every scholarly source.

The four legacy providers each grew their own ``_api_get``, their own retry loop
and their own idea of which failures were worth retrying. That duplication is the
single largest source of drift in the old codebase, so it lives here once.

Only stdlib — no ``requests``/``httpx`` dependency for what amounts to GET and POST.
"""

from __future__ import annotations

import json
import time
import urllib.parse
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from academia.core.errors import SourceError
from academia.core.paths import contact_email

#: Timeouts, rate limits and server hiccups are worth another attempt.
#: Everything else (bad key, malformed query, 404) must fail fast rather than
#: burn three backoff sleeps on a deterministic error.
TRANSIENT_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})

BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def polite_user_agent() -> str:
    """Identify ourselves to APIs with polite pools (OpenAlex, Crossref, ORCID)."""
    contact = contact_email()
    return f"cc-academia/0.1 (mailto:{contact})" if contact else "cc-academia/0.1"


def build_url(base: str, params: dict[str, Any]) -> str:
    """Encode query parameters, dropping empty ones."""
    clean = {k: v for k, v in params.items() if v not in (None, "", [])}
    if not clean:
        return base
    encoded = urllib.parse.urlencode(clean, quote_via=urllib.parse.quote)
    joiner = "&" if "?" in base else "?"
    return f"{base}{joiner}{encoded}"


def _request(
    url: str,
    source: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> tuple[str, str]:
    """Perform one request. Returns ``(body_text, content_type)``."""
    request = Request(url, data=body, method=method, headers=headers or {})
    try:
        with urlopen(request, timeout=timeout) as response:
            return (
                response.read().decode("utf-8", errors="replace"),
                response.headers.get("content-type", ""),
            )
    except HTTPError as exc:
        text = exc.read().decode("utf-8", errors="replace")
        raise SourceError(
            f"http_{exc.code}", source, {"status": exc.code, "body": text[:500]}
        ) from exc
    except URLError as exc:
        raise SourceError(f"network_error: {exc.reason}", source) from exc
    except TimeoutError as exc:
        raise SourceError("timeout", source) from exc


def _parse_json(text: str, source: str) -> dict[str, Any]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise SourceError("non_json_response", source) from exc
    if not isinstance(data, dict):
        raise SourceError("unexpected_json_shape", source)
    return data


def get_json(
    url: str,
    source: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    merged = {"User-Agent": polite_user_agent(), "Accept": "application/json"}
    merged.update(headers or {})
    text, _ = _request(url, source, headers=merged, timeout=timeout)
    return _parse_json(text, source)


def post_json(
    url: str,
    payload: dict[str, Any],
    source: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
) -> tuple[dict[str, Any], str]:
    """POST JSON, returning ``(parsed, raw_text)``.

    The raw text is handed back because some endpoints (IEEE) need to be inspected
    for bot checks before the payload can be trusted.
    """
    merged = {
        "User-Agent": polite_user_agent(),
        "Accept": "application/json",
        "Content-Type": "application/json",
    }
    merged.update(headers or {})
    text, _ = _request(
        url,
        source,
        method="POST",
        body=json.dumps(payload).encode("utf-8"),
        headers=merged,
        timeout=timeout,
    )
    return _parse_json(text, source), text


def is_transient(error: Exception) -> bool:
    status = None
    if isinstance(error, SourceError):
        status = error.details.get("status")
    if status is not None:
        return status in TRANSIENT_STATUSES
    if isinstance(error, SourceError):
        return error.reason.startswith("network_error") or error.reason == "timeout"
    return isinstance(error, TimeoutError | ConnectionError)


def with_retries(fn, *args: Any, attempts: int = 3, base_delay: float = 1.0, **kwargs: Any) -> Any:
    """Call ``fn`` with exponential backoff on transient failures only."""
    attempts = max(1, attempts)
    for attempt in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as error:
            if attempt >= attempts - 1 or not is_transient(error):
                raise
            time.sleep(base_delay * (2**attempt))
    raise AssertionError("unreachable")
