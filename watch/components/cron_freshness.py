"""Cron freshness component — verify /watch:watch has refreshed its durable CronCreate."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from components.base import Action, Anomaly, CheckResult, Component, RemedyStep

DEFAULT_MARKER_FILE = '.claude/watch/state/cron_refresh.json'
DEFAULT_GRACE_SECONDS = 3600          # before a missing marker escalates to critical
DEFAULT_GRACE_MULTIPLIER = 1.5        # threshold = interval * multiplier + buffer
DEFAULT_FIXED_BUFFER_SECONDS = 1800
DEFAULT_FALLBACK_MAX_AGE_SECONDS = 3600
DEFAULT_INTERVAL_SECONDS = 43200      # 12h, matches instance.check_interval_normal


class CronFreshness(Component):
    name = 'cron_freshness'
    description = 'Verify /watch:watch has refreshed its durable CronCreate schedule'

    def check(self, comp_cfg: dict, global_cfg: dict, state: dict) -> CheckResult:
        project = Path(global_cfg.get('_project_dir', '.'))
        marker_path = project / comp_cfg.get('marker_file', DEFAULT_MARKER_FILE)
        grace = comp_cfg.get('grace_seconds', DEFAULT_GRACE_SECONDS)
        grace_multiplier = comp_cfg.get('grace_multiplier', DEFAULT_GRACE_MULTIPLIER)
        fixed_buffer = comp_cfg.get('fixed_buffer_seconds', DEFAULT_FIXED_BUFFER_SECONDS)
        fallback_max_age = comp_cfg.get('fallback_max_age_seconds', DEFAULT_FALLBACK_MAX_AGE_SECONDS)

        result = CheckResult()
        now = datetime.now(timezone.utc)

        if not marker_path.exists():
            first_missing = state.get('_cron_marker_first_missing')
            if first_missing is None:
                state['_cron_marker_first_missing'] = now.isoformat()
                age = 0.0
            else:
                age = (now - datetime.fromisoformat(first_missing)).total_seconds()
            severity = 'critical' if age > grace else 'warning'
            result.metrics['cron_marker_missing_seconds'] = round(age, 1)
            result.anomalies.append(Anomaly(
                type='cron_marker_missing', severity=severity,
                value=age, threshold=grace,
                message=(f'cron refresh marker not found ({marker_path}) — '
                         f'/watch:watch may never have completed its CronCreate refresh step'),
            ))
            return result

        state.pop('_cron_marker_first_missing', None)

        try:
            data = json.loads(marker_path.read_text(encoding='utf-8'))
            ts = datetime.fromisoformat(data['ts'])
            interval = float(data.get('interval_seconds', DEFAULT_INTERVAL_SECONDS))
            mode = data.get('mode', 'normal')
        except (json.JSONDecodeError, OSError, KeyError, ValueError) as e:
            result.anomalies.append(Anomaly(
                type='cron_marker_missing', severity='warning',
                message=f'Failed to read cron refresh marker: {e}',
            ))
            return result

        age = (now - ts).total_seconds()
        threshold = interval * grace_multiplier + fixed_buffer
        if mode == 'fallback':
            threshold = min(threshold, fallback_max_age)

        result.metrics['cron_marker_age_seconds'] = round(age, 1)
        result.metrics['cron_marker_threshold_seconds'] = round(threshold, 1)
        result.data['cron_mode'] = mode
        result.data['cron_expr'] = data.get('cron_expr', '')

        if age > threshold:
            result.anomalies.append(Anomaly(
                type='cron_stale', severity='critical',
                value=age, threshold=threshold,
                message=(f'CronCreate refresh marker stale: {age:.0f}s since last refresh '
                         f'(max {threshold:.0f}s, mode={mode})'),
            ))

        return result

    def remedies(self) -> dict[str, list[RemedyStep]]:
        return {
            'cron_stale': [RemedyStep(action='log_cron_stale', on='critical', escalate_after=1)],
            'cron_marker_missing': [RemedyStep(action='log_cron_stale', on='critical', escalate_after=1)],
        }

    def actions(self) -> dict[str, Action]:
        return {
            'log_cron_stale': Action(
                description='Record cron schedule staleness for escalation',
                command='echo cron-schedule-stale',
                shell=True,
                timeout=5,
            ),
        }
