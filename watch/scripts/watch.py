#!/usr/bin/env python3
"""watch CLI — unified entry point. Usage: python watch.py --project-dir /path [--json]"""

from __future__ import annotations

import bootstrap
bootstrap.ensure()

import argparse
import json
import os
import sys
from pathlib import Path

from core.config import load_config
from core.loop import run
from core.pidfile import pid_alive


# ── PID file lock for one-shot runs ────────────────────────────
def _pid_path(project_dir: Path) -> Path:
    p = project_dir / '.claude' / 'watch' / 'state' / 'watch-check.pid'
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _try_lock(project_dir: Path) -> bool:
    """Try to acquire the one-shot check lock. Returns True if acquired."""
    path = _pid_path(project_dir)
    if path.exists():
        try:
            stale_pid = int(path.read_text(encoding='utf-8').strip())
            if pid_alive(stale_pid):
                print(f'[watch] check already running (PID {stale_pid}), '
                      f'skipping duplicate.', file=sys.stderr)
                return False
        except (ValueError, OSError):
            pass
    path.write_text(str(os.getpid()), encoding='utf-8')
    return True


def _unlock(project_dir: Path) -> None:
    path = _pid_path(project_dir)
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='watch — unattended operations supervisor')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--config', default=None)
    p.add_argument('--json', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--status', action='store_true',
                   help='Check daemon liveness via PID file (OS-level, no TaskGet needed)')
    p.add_argument('--action', default=None,
                   help='Execute a named action directly (deploy, rollback, recover_service) '
                        'without re-running the full check loop')
    args = p.parse_args(argv)

    project_dir = Path(args.project_dir).resolve()

    if args.status:
        _print_status(project_dir)
        return

    if args.action:
        _execute_named_action(project_dir, args.action, args.json)
        return

    if not _try_lock(project_dir):
        sys.exit(0)

    try:
        report = run(project_dir, dry_run=args.dry_run)

        if args.json:
            print(json.dumps(report, indent=2, ensure_ascii=False))
        else:
            _print_report(report)
    finally:
        _unlock(project_dir)


def _execute_named_action(project_dir: Path, action_name: str,
                        json_output: bool = False) -> None:
    """Execute a named component action (deploy/rollback/recover_service) directly."""
    from core.config import load_config
    from components.registry import create_registry

    config = load_config(project_dir)
    config['_project_dir'] = str(project_dir)
    registry = create_registry(config, project_dir)

    comp = registry.get('git_version')
    if not comp or not hasattr(comp, 'execute_action'):
        msg = f'Component git_version not found or has no execute_action'
        if json_output:
            print(json.dumps({'status': 'error', 'message': msg}, ensure_ascii=False))
        else:
            print(msg, file=sys.stderr)
        sys.exit(1)

    comp_cfg = registry.get_config('git_version')
    context: dict[str, object] = {'_registry': registry, '_project_dir': str(project_dir)}
    ok = comp.execute_action(action_name, comp_cfg, {}, project_dir, context)

    result = {
        'status': 'ok' if ok else 'failed',
        'action': action_name,
        'result': context.get('deploy_result', 'unknown'),
    }
    if ok and context.get('deploy_branch_updated'):
        result['deploy_branch_updated'] = True
    if context.get('deploy_test_health_passed'):
        result['test_health_passed'] = True
    if context.get('deploy_failure_reason'):
        result['failure_reason'] = str(context['deploy_failure_reason'])

    if json_output:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        _print_report(result)


def _print_status(project_dir: Path) -> None:
    """Check daemon liveness via PID file — OS-level, no TaskGet needed."""
    from datetime import datetime, timezone
    pid_path = project_dir / '.claude' / 'watch' / 'state' / 'watchd.pid'
    hb_path = project_dir / '.claude' / 'watch' / 'state' / 'heartbeat.json'

    # Daemon PID check
    if not pid_path.exists():
        print(json.dumps({'daemon': 'not_running', 'reason': 'no PID file'}, ensure_ascii=False))
        return

    try:
        pid = int(pid_path.read_text(encoding='utf-8').strip())
    except (ValueError, OSError):
        print(json.dumps({'daemon': 'not_running', 'reason': 'corrupt PID file'}, ensure_ascii=False))
        return

    alive = pid_alive(pid)

    # Heartbeat freshness
    hb_age = None
    if hb_path.exists():
        try:
            hb = json.loads(hb_path.read_text(encoding='utf-8'))
            hb_ts = datetime.fromisoformat(hb['ts'])
            hb_age = (datetime.now(timezone.utc) - hb_ts).total_seconds()
        except (json.JSONDecodeError, KeyError, ValueError):
            pass

    status = {
        'daemon': 'running' if alive else 'dead',
        'pid': pid,
        'heartbeat_age_seconds': hb_age,
        'stale': hb_age is not None and hb_age > 600,
    }
    print(json.dumps(status, ensure_ascii=False))


def _print_report(report: dict) -> None:
    icon = {'healthy': '✓', 'degraded': '⚠', 'unreachable': '✗'}.get(report['status'], '?')

    # ── Layer 1: Summary ──
    summary = report.get('summary', f'Status: {report["status"].upper()}')
    print(f'\n  {icon} {summary}')

    # ── Layer 2: Configuration overview ──
    w = report.get('watch', {})
    if w:
        project = w.get('project', '')
        instance = w.get('instance', '')
        components = ', '.join(w.get('components', []))
        alerts = w.get('alerts', {})
        alert_info = ''
        if alerts.get('email'):
            alert_info += f'email: {alerts["email"]}'
        if alerts.get('webhook'):
            if alert_info:
                alert_info += ', '
            alert_info += f'webhook: {alerts["webhook"]}'
        daemon = w.get('daemon', {})
        if daemon.get('running'):
            daemon_info = f'running (pid {daemon.get("pid", "?")}, every {daemon.get("interval_seconds", "?")}s)'
        else:
            daemon_info = 'not running'
        intervals = w.get('intervals', {})
        vt = w.get('version_tracking')

        print(f'  Project: {project}  |  Instance: {instance}')
        print(f'  Components: {components}')
        if alert_info:
            print(f'  Alerts: {alert_info}')
        print(f'  Daemon: {daemon_info}')
        print(f'  Intervals: normal={intervals.get("normal", "?")}, anomaly={intervals.get("anomaly", "?")}')
        if vt and vt.get('enabled'):
            print(f'  Version tracking: {", ".join(vt.get("repos", []))} → {vt.get("deploy_branch", "deploy")}')
        print()

    # ── Layer 3: Metrics with deltas ──
    history = report.get('history', {})
    deltas = history.get('deltas', {})
    for name, comp in report.get('components', {}).items():
        m = comp.get('metrics', {})
        if not m:
            print(f'  [{name}] -')
            continue
        parts = []
        for k, v in m.items():
            delta = deltas.get(name, {}).get(k)
            if delta is not None:
                arrow = '↑' if delta > 0 else ('↓' if delta < 0 else '→')
                parts.append(f'{k}={v} ({delta:+g}{arrow})')
            else:
                parts.append(f'{k}={v}')
        print(f'  [{name}]  {"  ".join(parts)}')

    # ── Layer 4: Anomalies, remedies, escalation ──
    anomalies = report.get('anomalies', [])
    escalation = report.get('escalation', {})

    if anomalies:
        print(f'\n  Anomalies ({len(anomalies)}):')
        for a in anomalies:
            sev = a.get('severity', 'warning').upper()
            msg = a.get('message', '?')
            plan = a.get('remedy_plan', [])
            plan_str = ''
            if plan:
                actions = ', '.join(p['action'] for p in plan)
                plan_str = f'  → remedies: {actions}'
            print(f'    [{sev}] {msg}{plan_str}')

        if escalation.get('consecutive'):
            cons = escalation['consecutive']
            print(f'\n  Consecutive: {cons}')
        if escalation.get('remedies_attempted'):
            print(f'  Remedy history:')
            for r in escalation['remedies_attempted']:
                status = '✓' if r.get('result') == 'ok' else '✗'
                print(f'    {status} {r["action"]} ({r.get("attempts", "?")} attempt(s))')
        if escalation.get('alerts_sent_this_cycle'):
            print(f'  Alert sent this cycle.')
    else:
        last_healthy = report.get('history', {}).get('previous_check')
        if last_healthy:
            print(f'\n  No anomalies. Last check: {last_healthy}')
        else:
            print('\n  No anomalies detected.')
    print()


if __name__ == '__main__':
    main()
