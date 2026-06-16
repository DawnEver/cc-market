#!/usr/bin/env python3
"""plugin_version — detect silent watch-plugin cache bumps.

The watch plugin is loaded from a versioned cache dir
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`). The marketplace can
update it out-of-band, so the version watchd runs against may bump silently. This
CLI resolves the highest installed version by glob (never hardcode the dir — see
the project memory on plugin-path gotchas), compares it to the last value the AI
sweep recorded, and reports drift so the skill can `/reload-plugins` + restart
watchd by pidfile.

Deliberately pure stdlib (no `bootstrap.ensure()`): it only reads dir names and a
small JSON state file. Cross-platform.

Usage:
  python plugin_version.py --project-dir /path [--json]      # report drift
  python plugin_version.py --project-dir /path --record      # mark current as seen
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

DEFAULT_MARKETPLACE = 'cc-market'
DEFAULT_PLUGIN = 'watch'
STATE_REL = '.claude/watch/state/plugin_version.json'


def _cache_root(marketplace: str, plugin: str) -> Path:
    return Path(os.path.expanduser('~')) / '.claude' / 'plugins' / 'cache' / marketplace / plugin


def _parse_semver(name: str) -> tuple:
    """Sortable key from a 'X.Y.Z' dir name; non-numeric parts sort lowest."""
    parts = []
    for chunk in name.split('.'):
        parts.append(int(chunk) if chunk.isdigit() else -1)
    return tuple(parts)


def discover_versions(cache_root: Path) -> list[str]:
    """All version dir names under the plugin cache root, sorted ascending."""
    if not cache_root.is_dir():
        return []
    versions = [p.name for p in cache_root.iterdir() if p.is_dir()]
    return sorted(versions, key=_parse_semver)


def highest_version(cache_root: Path) -> str | None:
    versions = discover_versions(cache_root)
    return versions[-1] if versions else None


def read_last_seen(state_file: Path) -> str | None:
    try:
        return json.loads(state_file.read_text(encoding='utf-8')).get('version')
    except (OSError, ValueError):
        return None


def write_last_seen(state_file: Path, version: str) -> None:
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps({'version': version}), encoding='utf-8')


def check(project_dir: Path, marketplace: str, plugin: str) -> dict:
    cache_root = _cache_root(marketplace, plugin)
    current = highest_version(cache_root)
    state_file = project_dir / STATE_REL
    last_seen = read_last_seen(state_file)
    return {
        'plugin': plugin,
        'current': current,
        'last_seen': last_seen,
        # drift only once we have a recorded baseline AND a resolvable current
        # version that differs — a first run (no baseline) is not drift.
        'drift': bool(current and last_seen and current != last_seen),
        'install_path': str(cache_root / current) if current else None,
        'all_versions': discover_versions(cache_root),
    }


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='Detect silent watch-plugin version bumps')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--marketplace', default=DEFAULT_MARKETPLACE)
    p.add_argument('--plugin', default=DEFAULT_PLUGIN)
    p.add_argument('--record', action='store_true',
                   help='record the current highest version as the seen baseline')
    p.add_argument('--json', action='store_true')
    args = p.parse_args(argv)

    project_dir = Path(args.project_dir).resolve()
    result = check(project_dir, args.marketplace, args.plugin)

    if args.record and result['current']:
        write_last_seen(project_dir / STATE_REL, result['current'])
        result['last_seen'] = result['current']
        result['drift'] = False

    if args.json:
        print(json.dumps(result))  # noqa: T201
    elif result['drift']:
        print(f"DRIFT: {args.plugin} {result['last_seen']} -> {result['current']}")  # noqa: T201
    else:
        print(f"OK: {args.plugin} {result['current']}")  # noqa: T201


if __name__ == '__main__':
    main()
