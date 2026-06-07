"""Watchd heartbeat component — verify daemon heartbeat file freshness."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from components.base import Anomaly, CheckResult, Component


class WatchdHeartbeat(Component):
    name = 'watchd_heartbeat'
    description = 'Check that watchd daemon heartbeat file is fresh'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        project = Path(global_cfg.get('_project_dir', '.'))
        wd = global_cfg.get('watchd', {})
        heartbeat_path = project / wd.get('heartbeat_file', '.claude/watch/state/heartbeat.json')
        max_age = comp_cfg.get('max_age_seconds', 600)
        result = CheckResult()

        if not heartbeat_path.exists():
            result.anomalies.append(Anomaly(
                type='daemon_heartbeat_missing', severity='warning',
                message='watchd heartbeat file not found — daemon may not be running',
            ))
            return result

        try:
            data = json.loads(heartbeat_path.read_text(encoding='utf-8'))
            last_ts = datetime.fromisoformat(data['ts'])
            age = (datetime.now(timezone.utc) - last_ts).total_seconds()
            result.metrics['heartbeat_age_seconds'] = round(age, 1)
            result.data['last_heartbeat'] = data['ts']
            result.data['daemon_pid'] = data.get('pid')

            if age > max_age:
                result.anomalies.append(Anomaly(
                    type='daemon_heartbeat_stale', severity='warning',
                    value=age, threshold=max_age,
                    message=f'watchd heartbeat stale: {age:.0f}s since last beat (max {max_age}s)',
                ))
        except Exception as e:
            result.anomalies.append(Anomaly(
                type='daemon_heartbeat_error', severity='warning',
                message=f'Failed to read watchd heartbeat: {e}',
            ))
        return result
