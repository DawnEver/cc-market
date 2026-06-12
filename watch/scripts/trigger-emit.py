#!/usr/bin/env python3
"""trigger-emit — emit one line every time trigger.json changes.

Designed to be the `command` of a Claude Code `Monitor`: each rewrite of
`.claude/watch/trigger.json` (done by watchd on repeated failure) becomes one stdout
line — i.e. one event — so a *live* full-capability session reacts in real time,
without waiting for the next cron poll. This is the in-session enhancement layer that
complements the standalone `trigger-watch.py` daemon (which is what runs when no
session is alive). See `skills/watch/reference/trigger-watch.md`.

Each emitted line corresponds to one trigger.json change, regardless of anomaly type.

Deliberately pure stdlib — NO `bootstrap.ensure()`, so it does not re-exec into the
managed venv. A Monitor feed must stay a single cheap long-lived process; it only
reads a file's mtime and prints, so it needs no third-party deps. Cross-platform
(Windows/Linux/macOS): uses `Path.stat().st_mtime` polling rather than inotify.

Usage: python trigger-emit.py --project-dir /path [--interval 5]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


def _mtime(p: Path) -> float:
    try:
        return p.stat().st_mtime
    except OSError:
        return 0.0


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='Emit a line whenever trigger.json changes')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--interval', type=int, default=5)
    p.add_argument('--once', action='store_true',
                   help='Emit at most one event then exit (for testing)')
    args = p.parse_args(argv)

    trigger = Path(args.project_dir).resolve() / '.claude' / 'watch' / 'trigger.json'
    last = _mtime(trigger)

    while True:
        time.sleep(args.interval)
        cur = _mtime(trigger)
        # Only emit on a genuine change between two existing snapshots — never on the
        # first appearance (last == 0), to avoid firing on a pre-existing stale trigger.
        if cur != last and last > 0 and cur > 0:
            try:
                payload = json.loads(trigger.read_text(encoding='utf-8'))
                reason = payload.get('reason', 'unknown')
                detail = payload.get('detail', '')
                print(f'ANOMALY trigger: {reason} — {detail}', flush=True)
            except (json.JSONDecodeError, OSError):
                print('ANOMALY trigger: (changed but unreadable)', flush=True)
            if args.once:
                return
        last = cur


if __name__ == '__main__':
    main()
