"""Core acquisition types.

Failures used to be free-text strings, so every caller re-guessed what a
failure meant. The distinctions that actually change behaviour are:

  BLOCKED          a bot check or throttle — worth retrying, possibly by hand
  DENIED           an IP-level ban — retrying makes it worse
  stop touching the host
  NOT_OPEN_ACCESS  the source simply has no free copy — terminal, not an error
  NOT_FOUND        the paper is not at this source
  ERROR            a transport fault (network, malformed payload)

These live in the acquire package rather than models.py because nothing
outside acquisition produces or consumes them
the ledger record is the one
artifact that crosses the boundary, and downstream reads it as plain JSON.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class Outcome(StrEnum):
    """Terminal state of a download attempt. `str` mixin keeps JSON readable."""

    DOWNLOADED = "downloaded"
    BLOCKED = "blocked"
    DENIED = "denied"
    NOT_OPEN_ACCESS = "not_open_access"
    NOT_FOUND = "not_found"
    ERROR = "error"

    @property
    def is_success(self) -> bool:
        return self is Outcome.DOWNLOADED

    @property
    def is_retryable(self) -> bool:
        """Whether trying again later could plausibly succeed."""
        return self in (Outcome.BLOCKED, Outcome.ERROR)


class AcquisitionError(RuntimeError):
    """Base for failures that carry an Outcome."""

    outcome: Outcome = Outcome.ERROR


class Blocked(AcquisitionError):
    """Bot check, login wall, or throttling — retryable."""

    outcome = Outcome.BLOCKED


class Denied(AcquisitionError):
    """Host has banned this client outright; stop trying it this run."""

    outcome = Outcome.DENIED


class NotOpenAccess(AcquisitionError):
    """The source exists but offers no downloadable full text."""

    outcome = Outcome.NOT_OPEN_ACCESS


def outcome_of(error: BaseException) -> Outcome:
    """Classify any exception into an Outcome."""
    if isinstance(error, AcquisitionError):
        return error.outcome
    return Outcome.ERROR


@dataclass(frozen=True)
class Source:
    """One candidate location for a paper, with its priority rank."""

    url: str
    rank: int = 0

    def __str__(self) -> str:  # keeps log lines readable
        return self.url


@dataclass(frozen=True)
class Attempt:
    """What one transport did with one source."""

    url: str
    transport: str
    outcome: Outcome
    detail: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "url": self.url, "transport": self.transport,
            "outcome": self.outcome.value, "detail": self.detail,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Attempt:
        return cls(
            url=str(data.get("url") or ""),
            transport=str(data.get("transport") or ""),
            outcome=Outcome(str(data.get("outcome") or Outcome.ERROR.value)),
            detail=str(data.get("detail") or ""),
        )


@dataclass
class DownloadRecord:
    """The ledger entry for one paper — the downstream source of truth.

    Carries `title` so the manifest can be built without re-reading the queue,
    and `pdf_path`/`sha256` so nothing downstream has to re-discover which file
    belongs to which paper.
    """

    candidate_id: str
    outcome: Outcome
    timestamp: str
    title: str = ""
    pdf_path: str = ""
    sha256: str = ""
    source_url: str = ""
    attempts: list[Attempt] = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        return self.outcome.is_success

    def to_dict(self) -> dict[str, Any]:
        return {
            "candidate_id": self.candidate_id,
            "outcome": self.outcome.value,
            "timestamp": self.timestamp,
            "title": self.title,
            "pdf_path": self.pdf_path,
            "sha256": self.sha256,
            "source_url": self.source_url,
            "attempts": [a.to_dict() for a in self.attempts],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DownloadRecord:
        return cls(
            candidate_id=str(data.get("candidate_id") or ""),
            outcome=Outcome(str(data.get("outcome") or Outcome.ERROR.value)),
            timestamp=str(data.get("timestamp") or ""),
            title=str(data.get("title") or ""),
            pdf_path=str(data.get("pdf_path") or ""),
            sha256=str(data.get("sha256") or ""),
            source_url=str(data.get("source_url") or ""),
            attempts=[Attempt.from_dict(a) for a in data.get("attempts") or []],
        )

    def failure_summary(self) -> str:
        """One line explaining why this paper has no PDF."""
        if self.succeeded:
            return ""
        if not self.attempts:
            # No attempt at all means nothing was even resolvable to try.
            return "no candidate URL — item has no pdf_url, html_url, doi, or title"
        parts = [f"{a.url} -> {a.outcome.value}" + (f": {a.detail}" if a.detail else "")
                 for a in self.attempts]
        return f"all {len(self.attempts)} attempt(s) failed: " + " | ".join(parts)
