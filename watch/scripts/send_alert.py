#!/usr/bin/env python3
"""Thin CLI wrapper for core.alert — used by alert-hook.js and manual alerts.

Usage:
  python send_alert.py --project-dir /path --subject "..." [--body "..."] [--dry-run] [--webhook]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_PLUGIN_ROOT))

from core.alert import send_email, send_webhook
from core.config import load_config


def main() -> None:
    p = argparse.ArgumentParser(description='watch alert dispatcher')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--subject', required=True)
    p.add_argument('--body', default=None)
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--webhook', action='store_true')
    args = p.parse_args()

    config = load_config(args.project_dir)
    body = args.body or sys.stdin.read()

    if args.webhook:
        import json
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {'text': body}
        ok = send_webhook(config, payload, dry_run=args.dry_run)
    else:
        ok = send_email(args.subject, body, config, dry_run=args.dry_run)

    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
