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
