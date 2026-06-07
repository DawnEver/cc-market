#!/usr/bin/env python3
"""watch CLI — unified entry point. Usage: python watch.py --project-dir /path [--json]"""

from __future__ import annotations

import bootstrap
bootstrap.ensure()

import argparse
import json
import sys
from pathlib import Path

from core.config import load_config
from core.loop import run


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='watch — unattended operations supervisor')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--config', default=None)
    p.add_argument('--json', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args(argv)

    report = run(Path(args.project_dir).resolve(), dry_run=args.dry_run)

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        _print_report(report)


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
