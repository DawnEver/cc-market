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
    print(f'\n  {icon} Status: {report["status"].upper()}  ({report["instance"]})')
    for name, comp in report.get('components', {}).items():
        m = comp.get('metrics', {})
        s = ', '.join(f'{k}={v}' for k, v in m.items()) if m else '-'
        print(f'  [{name}] {s}')
    if report['anomalies']:
        print(f'\n  Anomalies ({len(report["anomalies"])}):')
        for a in report['anomalies']:
            print(f'    [{a["severity"].upper()}] {a["message"]}')
    else:
        print('\n  No anomalies detected.')
    print()


if __name__ == '__main__':
    main()
