"""HTTP health endpoint checker."""

from __future__ import annotations

import urllib.error
import urllib.request
import json

from .base import CheckResult

NAME = 'health'


def check(config: dict, state: dict) -> CheckResult:
    url = config.get('health_url', 'http://127.0.0.1:8000/health/')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'watchd/1.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read().decode('utf-8'))
        status = body.get('status', '?')
        return CheckResult(
            ok=status == 'healthy',
            metrics={
                'reachable': True, 'status': status,
                'cpu': body.get('system', {}).get('cpu_percent'),
                'ram': body.get('system', {}).get('ram_percent'),
                'errors': body.get('requests', {}).get('error_rate'),
            },
            anomalies=[] if status == 'healthy' else [f'Health status: {status}'],
        )
    except Exception as e:
        return CheckResult(ok=False, metrics={'reachable': False},
                          anomalies=[f'Health unreachable: {e}'])
