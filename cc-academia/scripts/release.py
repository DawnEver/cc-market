#!/usr/bin/env python3
"""Keep the version consistent across the manifests and pyproject.

`.claude-plugin/plugin.json` is the source of truth. The repository-level
`scripts/release.sh` bumps it and regenerates the Codex manifest; pyproject derives
its own version from the same file. This checker never writes release state.

Usage:
    python scripts/release.py --check
"""

from __future__ import annotations

import json
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
#: Written from the authoritative version. The marketplace entries reference the
#: plugin by path and carry no version of their own.
MANIFESTS = (Path(".codex-plugin/plugin.json"),)


def read_version() -> str:
    """The authoritative version: whatever the Claude plugin manifest says."""
    manifest = json.loads((ROOT / ".claude-plugin/plugin.json").read_text(encoding="utf-8"))
    return str(manifest["version"])


def pyproject_states_a_version() -> bool:
    """pyproject must stay dynamic; a literal version would drift on every push."""
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    return "version" in data["project"]


def main(argv: list[str]) -> int:
    if argv != ["--check"]:
        raise SystemExit("usage: python scripts/release.py --check")

    version = read_version()
    drifted: list[str] = []

    for rel in MANIFESTS:
        path = ROOT / rel
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") == version:
            continue
        drifted.append(str(rel))

    if pyproject_states_a_version():
        raise SystemExit(
            "error: pyproject.toml states a literal version. It must stay "
            'dynamic and derive from .claude-plugin/plugin.json, or the root '
            "release workflow will leave the two disagreeing."
        )

    if drifted:
        print(f"version drift ({version}): " + ", ".join(drifted), file=sys.stderr)
        return 1
    print(f"all manifests at {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
