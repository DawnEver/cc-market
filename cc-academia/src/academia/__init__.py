"""cc-academia — academic research toolchain.

Three workflows (literature review, manuscript review, reviewer discovery) over
one library: a shared scholarly source layer, one PDF ingest implementation, and
an accumulating local SQLite store.
"""

from __future__ import annotations

import json
from pathlib import Path

__all__ = ["__version__"]

#: Fallback used when the plugin manifest is unreadable (an installed wheel
#: without the plugin directory, say).
_FALLBACK_VERSION = "0.0.0"


def _plugin_version() -> str:
    """Read the version from the Claude plugin manifest.

    The manifest is the single source of truth: cc-market's pre-push hook bumps
    the patch version of every changed plugin, so anything else that stored a
    version would silently fall behind on the next push. `scripts/release.py`
    propagates it into pyproject.toml for builds.
    """
    manifest = Path(__file__).resolve().parents[2] / ".claude-plugin" / "plugin.json"
    try:
        return str(json.loads(manifest.read_text(encoding="utf-8"))["version"])
    except (OSError, ValueError, KeyError):
        return _FALLBACK_VERSION


__version__ = _plugin_version()
