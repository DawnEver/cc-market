"""Process presence checker via pgrep."""
from __future__ import annotations
import subprocess
from .base import CheckResult

NAME = 'process'

def check(config: dict, state: dict) -> CheckResult:
    procs = state.get('_watchd_processes') or [
        {'name': 'server', 'match': 'wdg_lab', 'min': 1},
    ]
    result = CheckResult()
    for p in procs:
        try:
            # Cross-platform: pgrep -f returns PIDs, count via wc -l
            r = subprocess.run(['pgrep', '-f', p['match']], capture_output=True, text=True, timeout=5)
            count = len([l for l in r.stdout.strip().split('\n') if l]) if r.stdout.strip() else 0
        except Exception:
            count = 0
        result.metrics[f'{p["name"]}_count'] = count
        if count < p.get('min', 1):
            result.anomalies.append(f'{p["name"]}: {count} < min {p["min"]}')
            result.ok = False
    return result
