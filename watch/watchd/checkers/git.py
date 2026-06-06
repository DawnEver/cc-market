"""Git poll checker — fetch + detect new commits."""

from __future__ import annotations

import subprocess
from pathlib import Path

from .base import CheckResult

NAME = 'git'


def check(config: dict, state: dict) -> CheckResult:
    repos = config.get('repos', [{'name': 'main', 'path': '.'}])
    project = Path(config.get('project_dir', '.'))
    result = CheckResult()

    for repo in repos:
        name = repo['name']
        repo_path = (project / repo['path']).resolve()
        if not (repo_path / '.git').is_dir():
            result.anomalies.append(f'{name}: not a git repo ({repo_path})')
            result.ok = False
            continue

        try:
            subprocess.run(['git', 'fetch', 'origin'], cwd=repo_path,
                          capture_output=True, timeout=30, check=False)
        except Exception:
            result.anomalies.append(f'{name}: fetch failed')
            result.ok = False
            continue

        try:
            behind = subprocess.check_output(
                ['git', 'rev-list', '--count', 'HEAD..origin/main'],
                cwd=repo_path, text=True, timeout=10,
            ).strip()
            count = int(behind) if behind.isdigit() else 0
        except Exception:
            count = 0

        result.metrics[f'{name}_new'] = count
        if count > 0:
            result.anomalies.append(f'{name}: {count} new commits')
            result.ok = False

    return result
