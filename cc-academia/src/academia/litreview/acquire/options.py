"""Acquisition option vocabularies.

Separate from `download.py` because the CLI needs these at parser-build time,
while `download.py` pulls in the whole HTTP and browser stack. Keeping them here
means `lit-review --help` works without the `acquire` extra installed, and the
command that actually needs it says so by name instead of dying on an ImportError.
"""

from __future__ import annotations

DEFAULT_BROWSER_CHANNEL = "chromium"
DEFAULT_NETWORK_MODE = "direct"

SUPPORTED_BROWSER_CHANNELS = frozenset({"chromium", "chrome"})
SUPPORTED_NETWORK_MODES = frozenset({"direct", "system"})
COMPLETION_MODES = frozenset({"browser-close", "stdin", "none"})

IEEE_HOME = "https://ieeexplore.ieee.org/"

#: Downloads per run. A cap, not a preference: publisher rate limits escalate to
#: IP bans, and a ban is not something a retry can fix.
HARD_LIMIT = 20
