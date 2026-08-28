"""Console entry point for the Zotero MCP server.

Installed as ``academia-zotero-mcp``, so ``.mcp.json`` names a command instead of
a script path -- a path breaks the moment the plugin updates.

Two jobs before handing over: load the environment, and apply the pyzotero
attachment-filename patch.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from academia.core import paths


def load_env() -> Path | None:
    """Read ``.env`` from the user's config directory, then the plugin root.

    Stdlib only, and deliberately non-overriding: a value already exported by the
    host wins over the file.
    """
    override = os.environ.get(paths.ENV_CONFIG_DIR, "").strip()
    candidates = []
    if override:
        candidates.append(Path(override).expanduser() / ".env")
    candidates.append(paths.plugin_root() / ".env")

    for path in candidates:
        if not path.exists():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
        return path
    return None


def main() -> int:
    load_env()

    from academia.litreview.zotero import mcp_patch

    mcp_patch.apply()

    try:
        from zotero_mcp.cli import main as server_main
    except ImportError:
        print(
            "zotero-mcp-server is not installed. Launch it with:\n"
            "  uv run --no-project --with 'zotero-mcp-server[semantic,pdf]' academia-zotero-mcp",
            file=sys.stderr,
        )
        return 2

    return int(server_main() or 0)


if __name__ == "__main__":
    raise SystemExit(main())
