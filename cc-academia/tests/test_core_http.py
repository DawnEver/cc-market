"""Retry policy: only transient failures are worth a backoff sleep."""

from __future__ import annotations

import pytest

from academia.core import http
from academia.core.errors import SourceError


def test_build_url_drops_empty_params():
    url = http.build_url("https://api/x", {"q": "motor", "page": None, "tags": []})
    assert url == "https://api/x?q=motor"


def test_build_url_appends_to_existing_query():
    assert http.build_url("https://api/x?a=1", {"b": "2"}) == "https://api/x?a=1&b=2"


@pytest.mark.parametrize("status,expected", [(429, True), (503, True), (404, False), (401, False)])
def test_is_transient_follows_status(status, expected):
    err = SourceError(f"http_{status}", "test", {"status": status})
    assert http.is_transient(err) is expected


def test_network_errors_are_transient():
    assert http.is_transient(SourceError("network_error: timed out", "test"))
    assert http.is_transient(SourceError("timeout", "test"))
    assert not http.is_transient(SourceError("non_json_response", "test"))


@pytest.mark.parametrize(
    "raised",
    [
        ConnectionResetError(10054, "An existing connection was forcibly closed by the remote host"),
        ConnectionAbortedError(10053, "An established connection was aborted by the software"),
        BrokenPipeError(32, "Broken pipe"),
        # No errno: CPython re-dispatches OSError by errno, so a bare
        # OSError(10060) *is* a TimeoutError and takes the arm above it. The
        # catch-all still has to exist for what maps to nothing.
        OSError("socket closed unexpectedly"),
    ],
)
def test_a_socket_failure_mid_body_becomes_a_source_error(monkeypatch, raised):
    """The socket layer's own errors are the sources' errors too.

    A reset arrives *after* urlopen has handed back the response object, so
    urllib never wraps it in a URLError and no caller's ``except SourceError``
    sees it. It escaped the whole way out of an enrich run and killed it,
    discarding the candidates already done — so the one thing this must do is
    convert, not propagate.
    """
    def boom(*args, **kwargs):
        raise raised

    monkeypatch.setattr(http, "urlopen", boom)

    with pytest.raises(SourceError) as caught:
        http.get_text("https://example.edu/staff", "test")

    assert caught.value.reason.startswith("network_error")
    assert http.is_transient(caught.value)


def test_with_retries_gives_up_immediately_on_permanent_failure(monkeypatch):
    calls = []

    def always_404():
        calls.append(1)
        raise SourceError("http_404", "test", {"status": 404})

    monkeypatch.setattr(http.time, "sleep", lambda _: None)
    with pytest.raises(SourceError):
        http.with_retries(always_404, attempts=3)
    assert len(calls) == 1


def test_with_retries_recovers_from_a_transient_failure(monkeypatch):
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise SourceError("http_429", "test", {"status": 429})
        return "ok"

    monkeypatch.setattr(http.time, "sleep", lambda _: None)
    assert http.with_retries(flaky, attempts=3) == "ok"
    assert len(calls) == 3


def test_polite_user_agent_includes_contact(monkeypatch):
    monkeypatch.setenv("ACADEMIA_CONTACT", "me@example.com")
    assert "me@example.com" in http.polite_user_agent()
    monkeypatch.setenv("ACADEMIA_CONTACT", "")
    assert http.polite_user_agent() == "cc-academia/0.1"


def test_get_text_reports_the_host_it_was_redirected_to(monkeypatch):
    """Nearly every landing page is a doi.org link that redirects to a publisher.

    Attributing a failure to doi.org rather than to the publisher lets two dead
    publishers disable every remaining lookup in the run.
    """

    class Response:
        headers = {"content-type": "text/html"}  # noqa: RUF012
        url = "https://www.mdpi.com/article/1"

        def read(self):
            return b"<html>ok</html>"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(http, "urlopen", lambda *a, **k: Response())
    text, final = http.get_text_resolved("https://doi.org/10.3390/en17051089", "probe")

    assert text == "<html>ok</html>"
    assert final == "https://www.mdpi.com/article/1"


def test_a_browser_fetch_sends_a_whole_browser_header_set():
    """A lone User-Agent is not a browser and some university sites know it.

    uakron.edu returns 403 to a request carrying only ``User-Agent`` and 200 to
    the same request with the headers a real browser always sends alongside it.
    That 403 cost us a candidate's address that was in the page all along, so
    the browser headers travel together rather than one of them alone.
    """
    from academia.core.http import BROWSER_HEADERS, BROWSER_USER_AGENT

    assert BROWSER_HEADERS["User-Agent"] == BROWSER_USER_AGENT
    for header in ("Accept", "Accept-Language", "Upgrade-Insecure-Requests"):
        assert header in BROWSER_HEADERS
