#!/usr/bin/env python3
"""watch CLI — unified entry point for the watch plugin.

Usage:
  python watch.py --project-dir /path/to/project [--json] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_SCRIPT_DIR = Path(__file__).resolve().parent
_PLUGIN_ROOT = _SCRIPT_DIR.parent
sys.path.insert(0, str(_PLUGIN_ROOT))

from core.config import load_config
from core.loop import run


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='watch — unattended operations supervisor')
    p.add_argument('--project-dir', required=True, help='Project root directory')
    p.add_argument('--config', default=None, help='Config file path')
    p.add_argument('--json', action='store_true', help='Output JSON only')
    p.add_argument('--dry-run', action='store_true', help='Skip actual actions')
    args = p.parse_args(argv)

    project = Path(args.project_dir).resolve()
    report = run(project, dry_run=args.dry_run)

    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        _print_report(report)


def _print_report(report: dict) -> None:
    status = report['status']
    icon = {'healthy': '✓', 'degraded': '⚠', 'unreachable': '✗'}.get(status, '?')
    print(f'\n  {icon} Status: {status.upper()}  ({report["instance"]})')
    print(f'  Timestamp: {report["timestamp"]}')

    for name, comp in report.get('components', {}).items():
        metrics = comp.get('metrics', {})
        errors = comp.get('error', '')
        state = 'error' if errors else 'ok'
        metric_str = ', '.join(f'{k}={v}' for k, v in metrics.items()) if metrics else '-'
        print(f'  [{name}] {state}  {metric_str}')
        if errors:
            print(f'         error: {errors}')

    if report['anomalies']:
        print(f'\n  Anomalies ({len(report["anomalies"])}):')
        for a in report['anomalies']:
            sev = a['severity'].upper() if isinstance(a, dict) else a.severity.upper()
            msg = a['message'] if isinstance(a, dict) else a.message
            print(f'    [{sev}] {msg}')
    else:
        print('\n  No anomalies detected.')
    print()


if __name__ == '__main__':
    main()
