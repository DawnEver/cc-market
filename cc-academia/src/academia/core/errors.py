"""Error taxonomy.

Exit codes are part of the CLI contract that playbooks branch on:

===== =========================================================
 0    success
 2    usage error — bad arguments, missing workspace
 3    external source failure — API down, rate limited, blocked
===== =========================================================
"""

from __future__ import annotations

from typing import Any

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_SOURCE = 3


class AcademiaError(RuntimeError):
    """Base class; carries the exit code the CLI should use."""

    exit_code = 1


class UsageError(AcademiaError):
    exit_code = EXIT_USAGE


class SourceError(AcademiaError):
    """A scholarly data source failed.

    ``reason`` is a stable machine token (``http_429``, ``captcha_or_bot_check``,
    ``network_error``) so callers can branch without parsing prose.
    """

    exit_code = EXIT_SOURCE

    def __init__(self, reason: str, source: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(f"[{source}] {reason}")
        self.reason = reason
        self.source = source
        self.details = details or {}
