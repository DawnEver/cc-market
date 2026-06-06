"""Disk usage checker."""

from __future__ import annotations

import shutil

from .base import CheckResult

NAME = 'disk'


def check(config: dict, state: dict) -> CheckResult:
    try:
        usage = shutil.disk_usage('/')
        pct = round((usage.used / usage.total) * 100, 2)
        free_gb = round(usage.free / (1024 ** 3), 2)
        ok = pct < 85
        return CheckResult(
            ok=ok,
            metrics={'disk_pct': pct, 'free_gb': free_gb},
            anomalies=[] if ok else [f'Disk {pct}% full'],
        )
    except Exception as e:
        return CheckResult(ok=False, anomalies=[f'Disk check failed: {e}'])
