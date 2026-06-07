"""Daemon liveness checks, state reading, restart, and escalation."""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from components.base import Anomaly, run_command
from core.alert import send_email, send_webhook
from core.config import load_config
from core.log import get_last_report


def _read_daemon_state(project: Path) -> dict:
    """Read watchd daemon state file if it exists."""
    wd_cfg = {}
    try:
        cfg = load_config(project)
        wd_cfg = cfg.get('watchd', {})
    except Exception:
        pass
    path = project / wd_cfg.get('state_file', '.claude/watch/state/daemon.json')
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _check_daemon_liveness(project: Path, config: dict) -> list:
    """Check if watchd is alive via daemon.jsonl freshness.
    Uses get_last_report() from core/log.py — same shared function the
    AI loop uses for history delta computation.
    """
    wd = config.get('watchd', {})
    last = get_last_report(project, wd.get('log_file', '.claude/watch/logs/daemon.jsonl'))
    if not last:
        return [Anomaly(
            type='daemon_not_running', severity='warning',
            message='watchd has never polled (daemon.jsonl not found or empty)',
        )]
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(last['ts'])).total_seconds()
    except (KeyError, ValueError):
        return [Anomaly(
            type='daemon_not_running', severity='warning',
            message='watchd daemon.jsonl has invalid timestamp',
        )]
    interval = wd.get('interval', 300)
    if age > interval * 2:
        return [Anomaly(
            type='daemon_not_running', severity='warning',
            message=f'watchd appears dead: last poll {age:.0f}s ago (interval={interval}s)',
        )]
    return []


def _restart_watchd(project: Path, config: dict) -> bool:
    """Spawn watchd daemon as a detached process via start-server.py.
    Returns True if start-server.py exited with code 0."""
    wd = config.get('watchd', {})
    plugin_root = Path(__file__).resolve().parent.parent  # core/ -> watch/
    start_server = plugin_root / 'scripts' / 'start-server.py'
    daemon_py = plugin_root / 'watchd' / 'daemon.py'

    # start-server.py handles cross-platform detached spawning
    inner = f'python {daemon_py} --project-dir {project}'
    rc, out, err = run_command(
        f'python {start_server} --project-dir {project} --cmd "{inner}"',
        shell=True, cwd=str(project), timeout=15,
    )
    if rc == 0:
        print(f'[watch] watchd restarted (PID in start-server output)', file=sys.stderr)
    else:
        print(f'[watch] watchd restart failed (rc={rc}): {err}', file=sys.stderr)
    return rc == 0


def _escalate(config: dict, anomaly: Anomaly, count: int,
              report: dict, dry_run: bool) -> None:
    """Send alert on escalated anomaly."""
    instance = config['instance']['name']
    subject = f'{anomaly.type} (x{count} consecutive)'

    body_lines = [
        f'<h2>[{instance}] Escalated anomaly</h2>',
        f'<p><b>{anomaly.severity.upper()}</b>: {anomaly.message}</p>',
        f'<p>Consecutive occurrences: {count}</p>',
        f'<p>Timestamp: {report["timestamp"]}</p>',
    ]
    body = '\n'.join(body_lines)

    send_email(subject, body, config, dry_run=dry_run)
    webhook_payload = {
        'text': f'*[{instance}]* {anomaly.severity.upper()}: {anomaly.message} (x{count})',
        'instance': instance,
        'anomaly': {'type': anomaly.type, 'severity': anomaly.severity, 'message': anomaly.message},
        'count': count,
        'timestamp': report['timestamp'],
    }
    send_webhook(config, webhook_payload, dry_run=dry_run)
