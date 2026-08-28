#!/usr/bin/env python3
"""Keep the version consistent across the manifests and pyproject.

`.claude-plugin/plugin.json` is the source of truth, because cc-market's pre-push
hook bumps the patch version of every changed plugin. This script propagates that
version to the Codex manifest and to pyproject.toml, which exists only so a wheel
build is not wrong. `tests/test_manifests.py` is the guard.

Usage:
    python scripts/release.py            # sync manifests to pyproject version
    python scripts/release.py 0.2.0      # bump pyproject first, then sync
    python scripts/release.py --check    # verify only, non-zero exit on drift
"""

from __future__ import annotations

import json
import re
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


def read_pyproject_version() -> str:
    return tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]


def write_version(version: str) -> None:
    path = ROOT / "pyproject.toml"
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(r'(?m)^version = "[^"]+"', f'version = "{version}"', text, count=1)
    if count != 1:
        raise SystemExit("error: could not locate the version field in pyproject.toml")
    path.write_text(updated, encoding="utf-8")


def main(argv: list[str]) -> int:
    check_only = "--check" in argv
    positional = [a for a in argv if not a.startswith("-")]

    if positional:
        if check_only:
            raise SystemExit("error: --check takes no version argument")
        if not re.fullmatch(r"\d+\.\d+\.\d+", positional[0]):
            raise SystemExit(f"error: not a semver version: {positional[0]}")
        path = ROOT / ".claude-plugin/plugin.json"
        manifest = json.loads(path.read_text(encoding="utf-8"))
        manifest["version"] = positional[0]
        path.write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    version = read_version()
    drifted: list[str] = []

    for rel in MANIFESTS:
        path = ROOT / rel
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("version") == version:
            continue
        drifted.append(str(rel))
        if not check_only:
            data["version"] = version
            path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    if read_pyproject_version() != version:
        drifted.append("pyproject.toml")
        if not check_only:
            write_version(version)

    if check_only:
        if drifted:
            print(f"version drift ({version}): " + ", ".join(drifted), file=sys.stderr)
            return 1
        print(f"all manifests at {version}")
        return 0

    print(f"synced {len(drifted)} manifest(s) to {version}" if drifted else f"already at {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
