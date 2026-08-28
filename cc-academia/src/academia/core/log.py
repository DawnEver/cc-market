"""Console logging.

Every CLI command speaks two languages: a human stream on stderr and, under
``--json``, a machine payload on stdout. Keeping them on separate file handles is
what lets a playbook pipe structured output while the user still sees progress.
"""

from __future__ import annotations

import json
import sys
from typing import Any

_VERBOSE = False


def set_verbose(enabled: bool) -> None:
    global _VERBOSE
    _VERBOSE = enabled


def info(message: str) -> None:
    print(message, file=sys.stderr)


def detail(message: str) -> None:
    if _VERBOSE:
        print(message, file=sys.stderr)


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def error(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)


def emit(payload: Any) -> None:
    """Write the machine-readable result to stdout."""
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, default=str)
    sys.stdout.write("\n")
