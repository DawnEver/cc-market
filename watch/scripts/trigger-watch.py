#!/usr/bin/env python3
"""trigger-watch — standalone poller for trigger.json. Runs scripts/watch.py on change.
Completely independent of any Claude Code session — no claude -p, no skill dependency.
All context is in filesystem state (state/*.json, logs/*.jsonl) read by the AI loop each run.

Usage: python trigger-watch.py --project-dir /path [--interval 15] [--once] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent
sys.path.insert(0, str(_PLUGIN_ROOT))
sys.path.insert(0, str(_PLUGIN_ROOT / 'scripts'))

import bootstrap; bootstrap.ensure()

from core import pidfile
from core.config import load_config
from core.log import append_report

LOG_FILE = '.claude/watch/logs/trigger-watch.jsonl'
PIDFILE = 'trigger-watch.pid'
WATCH_PY = _PLUGIN_ROOT / 'scripts' / 'watch.py'


def _log(project_dir: Path, level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    print(f'[{ts}] {level}: {msg}')
    append_report({'ts': ts, 'level': level, 'msg': msg}, project_dir,
                  log_file=LOG_FILE, max_entries=0)


def _ack_trigger(project_dir: Path, trigger_ts: str, handled_by: str) -> None:
    ack_path = project_dir / '.claude' / 'watch' / 'state' / 'trigger_ack.json'
    ack_path.parent.mkdir(parents=True, exist_ok=True)
    ack_path.write_text(json.dumps({
        'last_trigger_ts': trigger_ts,
        'acked_at': datetime.now(timezone.utc).isoformat(),
        'handled_by': handled_by,
    }, ensure_ascii=False) + '\n', encoding='utf-8')


def _run_ai_loop(project_dir: Path, dry_run: bool = False) -> bool:
    """Run the full AI check loop (scripts/watch.py) directly — same venv, no claude -p needed."""
    cmd = [sys.executable, str(WATCH_PY), '--project-dir', str(project_dir)]
    if dry_run:
        _log(project_dir, 'info', f'[DRYRUN] Would run: {" ".join(cmd)}')
        return True
    _log(project_dir, 'info', 'Running AI check loop...')
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.stdout:
            _log(project_dir, 'info', f'watch.py: {result.stdout.strip()[:500]}')
        if result.stderr:
            _log(project_dir, 'warn', f'watch.py stderr: {result.stderr.strip()[:500]}')
        if result.returncode != 0:
            _log(project_dir, 'error', f'watch.py exited with code {result.returncode}')
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        _log(project_dir, 'error', 'watch.py timed out after 600s')
        return False


def _poll(project_dir: Path, config: dict, last_mtime: float,
          dry_run: bool = False) -> float:
    trigger_path = project_dir / config['watchd']['trigger_file']
    current_mtime = trigger_path.stat().st_mtime if trigger_path.exists() else 0.0

    if current_mtime != last_mtime and last_mtime > 0 and current_mtime > 0:
        try:
            trigger_data = json.loads(trigger_path.read_text(encoding='utf-8'))
            trigger_ts = trigger_data.get('timestamp', 'unknown')
            reason = trigger_data.get('reason', 'unknown')
            detail = trigger_data.get('detail', '')
            _log(project_dir, 'info', f'Trigger detected: {reason} — {detail}')
        except (json.JSONDecodeError, OSError):
            trigger_ts = datetime.now(timezone.utc).isoformat()
            _log(project_dir, 'warn', 'Trigger file changed but unreadable')

        success = _run_ai_loop(project_dir, dry_run)

        if success:
            _ack_trigger(project_dir, trigger_ts, 'trigger-watch')
            _log(project_dir, 'info', f'Trigger acked at {trigger_ts}')
        else:
            _log(project_dir, 'error', 'Trigger NOT acked — claude call failed')

    return current_mtime


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='trigger-watch — poll trigger.json, wake Claude')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--interval', type=int, default=15)
    p.add_argument('--once', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--force', action='store_true',
                   help='Kill existing trigger-watch and take over')
    args = p.parse_args(argv)

    project_dir = Path(args.project_dir).resolve()

    # ── Single-instance guard (skipped for one-shot/dry runs) ──
    if not args.once and not args.dry_run:
        if not pidfile.acquire(project_dir, PIDFILE):
            if args.force:
                pidfile.terminate(project_dir, PIDFILE)
                time.sleep(0.5)
                pidfile.acquire(project_dir, PIDFILE)
            else:
                print(f'trigger-watch already running (PID '
                      f'{pidfile.read(project_dir, PIDFILE)}). Use --force to replace.',
                      file=sys.stderr)
                sys.exit(1)

    config = load_config(project_dir)
    wd = config['watchd']
    trigger_path = project_dir / wd['trigger_file']

    _log(project_dir, 'info',
         f'trigger-watch starting (interval={args.interval}s, '
         f'trigger={wd["trigger_file"]}, dry_run={args.dry_run})')

    last_mtime = trigger_path.stat().st_mtime if trigger_path.exists() else 0.0
    _log(project_dir, 'info',
         f'Initial mtime: {last_mtime} {"(exists)" if last_mtime > 0 else "(no file)"}')

    last_mtime = _poll(project_dir, config, last_mtime, args.dry_run)

    if args.once:
        _log(project_dir, 'info', 'One-shot done.')
        return

    while True:
        time.sleep(args.interval)
        config = load_config(project_dir)
        last_mtime = _poll(project_dir, config, last_mtime, args.dry_run)


if __name__ == '__main__':
    main()
