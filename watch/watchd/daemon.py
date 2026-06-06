#!/usr/bin/env python3
"""watchd — modular background poller. Only wakes Claude Code on anomalies.
Usage: python daemon.py --project-dir /path [--interval 300] [--once] [--dry-run]
"""
from __future__ import annotations

import argparse, json, sys, time
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent
sys.path.insert(0, str(_PLUGIN_ROOT))
sys.path.insert(0, str(_PLUGIN_ROOT / 'scripts'))

import bootstrap; bootstrap.ensure()

from watchd.core.config import load_config
from watchd.core.state import load, save, track_fail, track_ok, should_escalate
from watchd.checkers.registry import load as load_checkers


def log(project_dir: Path, level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    print(f'[{ts}] {level}: {msg}')
    try:
        p = project_dir / '.claude' / 'watchd-log.jsonl'
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'ts': ts, 'level': level, 'msg': msg}, ensure_ascii=False) + '\n')
    except Exception: pass


def wake_claude(project_dir: Path, reason: str, detail: str, dry_run: bool = False) -> None:
    if dry_run:
        log(project_dir, 'info', f'[DRYRUN] Would wake Claude: {reason} — {detail}')
        return
    trigger = project_dir / '.claude' / '.watch-alert-trigger.json'
    trigger.parent.mkdir(parents=True, exist_ok=True)
    trigger.write_text(json.dumps({
        'reason': reason, 'detail': detail,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'project_dir': str(project_dir),
    }, ensure_ascii=False) + '\n', encoding='utf-8')
    log(project_dir, 'info', f'Waking Claude: {reason}')


def poll(project_dir: Path, checkers: list, dry_run: bool = False) -> None:
    config = load_config(project_dir)
    state = load(project_dir)
    all_ok = True
    log(project_dir, 'info', f'Polling ({", ".join(c.NAME for c in checkers)})')
    for mod in checkers:
        try:
            r = mod.check(config, state)
            tag = 'OK' if r.ok else 'FAIL'
            log(project_dir, 'info', f'  [{mod.NAME}] {tag} {r.metrics}')
            if not r.ok:
                all_ok = False; track_fail(state, mod.NAME)
                for a in r.anomalies: log(project_dir, 'warn', f'  [{mod.NAME}] {a}')
        except Exception as e:
            log(project_dir, 'error', f'  [{mod.NAME}] crashed: {e}')
            all_ok = False; track_fail(state, mod.NAME)
    if all_ok: track_ok(state); log(project_dir, 'info', 'All OK.')
    elif should_escalate(state, 2):
        ck = state.get('checkers', {})
        detail = ', '.join(f'{k}:{v["fails"]}x' for k, v in ck.items())
        wake_claude(project_dir, 'checkers_failing', detail, dry_run)
    save(project_dir, state)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='watchd — lightweight poller')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--interval', type=int, default=300)
    p.add_argument('--checkers', default='health,git,disk,process')
    p.add_argument('--once', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args(argv)
    project_dir = Path(args.project_dir).resolve()
    checkers = load_checkers(args.checkers.split(','), project_dir)
    if not checkers: print('No checkers loaded.', file=sys.stderr); sys.exit(1)
    log(project_dir, 'info', f'watchd started (project={project_dir}, interval={args.interval}s, checkers={",".join(c.NAME for c in checkers)})')
    poll(project_dir, checkers, args.dry_run)
    if args.once: log(project_dir, 'info', 'One-shot done.'); return
    while True: time.sleep(args.interval); poll(project_dir, checkers, args.dry_run)

if __name__ == '__main__': main()
