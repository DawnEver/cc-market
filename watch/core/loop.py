"""Core supervision loop — discover components, run checks, apply remedies, escalate."""

from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from pathlib import Path

from components.registry import create_registry
from core.actions import _to_serializable
from core.config import load_config
from core.daemon_helpers import _check_daemon_liveness, _restart_watchd
from core.log import append_report
from core.remediate import apply_remedies
from core.report import _enrich_report
from core.state import (load_state, save_state, record_last_healthy)

CHECK_TIMEOUT = 60  # per-component hard timeout (seconds)


def run(project_dir: str | Path, dry_run: bool = False) -> dict:
    """Execute one supervision cycle. Returns the report dict."""
    project = Path(project_dir).resolve()
    config = load_config(project)
    config['_project_dir'] = str(project)

    # 1. Component registry
    registry = create_registry(config, project)
    enabled = registry.enabled()
    if not enabled:
        print('[watch] No components enabled. Check your watch.yaml.', file=sys.stderr)
        return {'status': 'healthy', 'anomalies': [], 'components': {}}

    # 2. State
    log_cfg = config.get('logging', {})
    state = load_state(project, log_cfg.get('state_file', '.claude/watch/state/monitor.json'))

    # 3. Run all checks
    ts = datetime.now(timezone.utc).isoformat()
    report: dict = {
        'status': 'healthy',
        'timestamp': ts,
        'instance': config['instance']['name'],
        'anomalies': [],
        'completions': [],
        'components': {},
    }

    for comp in enabled:
        comp_cfg = registry.get_config(comp.name)
        print(f'[{comp.name}] checking...', file=sys.stderr, flush=True)
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(comp.check, comp_cfg, config, state)
                result = future.result(timeout=CHECK_TIMEOUT)
            report['components'][comp.name] = {
                'metrics': result.metrics,
                'data': result.data,
                'anomalies': [{'type': a.type, 'severity': a.severity,
                               'message': a.message} for a in result.anomalies],
                'completions': list(result.completions),
            }
            for a in result.anomalies:
                a.source = f'{comp.name}.{a.type}'
            report['anomalies'].extend(result.anomalies)
            for c in result.completions:
                report['completions'].append({**c, 'source': comp.name})
        except FutureTimeoutError:
            print(f'[{comp.name}] timed out after {CHECK_TIMEOUT}s', file=sys.stderr, flush=True)
            report['components'][comp.name] = {'error': f'timed out after {CHECK_TIMEOUT}s'}
        except Exception as e:
            print(f'[{comp.name}] check failed: {e}', file=sys.stderr, flush=True)
            report['components'][comp.name] = {'error': str(e)}

    # 3b. Meta-check: daemon liveness
    daemon_anomalies = _check_daemon_liveness(project, config)
    for a in daemon_anomalies:
        a.source = 'watchd.daemon_not_running'
    report['anomalies'].extend(daemon_anomalies)

    # 3c. Auto-restart watchd if detected dead
    if config.get('watchd', {}).get('auto_restart', True):
        for a in daemon_anomalies:
            if a.type == 'daemon_not_running':
                ok = _restart_watchd(project, config)
                a.message += ' (auto-restart attempted' + (' - ok)' if ok else ' - failed)')
                if ok:
                    # Remove anomaly on successful restart — daemon is back
                    report['anomalies'].remove(a)

    # 4. Apply remedies for each anomaly
    if not report['anomalies']:
        for key in list(state.keys()):
            if key.startswith('consecutive_'):
                state.pop(key, None)
        state.pop('_alert_sent', None)
        state.pop('_remedies', None)
        # Adaptive AI-sweep: each healthy cycle climbs the backoff ladder.
        state['_healthy_streak'] = int(state.get('_healthy_streak', 0)) + 1
        record_last_healthy(state, ts)
    else:
        # Any anomaly snaps the AI sweep back to the shortest rung.
        state['_healthy_streak'] = 0
        apply_remedies(registry, report['anomalies'], config, state,
                       project, ts, report=report, dry_run=dry_run)

    # 5. Status
    if any(a.severity == 'critical' for a in report['anomalies']):
        report['status'] = 'degraded'
    elif report['anomalies']:
        report['status'] = 'degraded'
    elif report['completions']:
        # Terminal success: task(s) finished with no outstanding anomalies. Not
        # `degraded` — lets /watch:watch stop refreshing the cron instead of
        # rescheduling at the anomaly cadence.
        report['status'] = 'complete'

    # 5b. Serialize anomalies (Anomaly objects → dicts)
    report = _to_serializable(report)

    # 5c. Enrich report with progressive disclosure layers
    report = _enrich_report(report, registry, config, state, project)

    # 6. Persist
    save_state(project, state, log_cfg.get('state_file', '.claude/watch/state/monitor.json'))

    append_report(report, project, log_file=log_cfg.get('log_file', '.claude/watch/logs/health.jsonl'),
                  max_entries=log_cfg.get('max_entries', 10000))
    return report
