"""Report enrichment — progressive disclosure layers for supervision output."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

from core.daemon_helpers import _read_daemon_state, _check_daemon_liveness
from core.log import get_last_report


def _enrich_report(report: dict, registry, config: dict,
                   state: dict, project: Path) -> dict:
    """Add progressive-disclosure layers to the report."""
    report['summary'] = _build_summary(report)
    report['watch'] = _build_watch_overview(config, registry, state, project)
    report['history'] = _build_history(report, project)
    report['escalation'] = _build_escalation(state)
    # Embed remedy_plan in each anomaly
    for a in report['anomalies']:
        steps = registry.get_remedies(a['type']) if hasattr(registry, 'get_remedies') else []
        a['remedy_plan'] = [
            {'action': s.action, 'max_attempts': s.max_attempts,
             'escalate_after': s.escalate_after}
            for s in steps
        ]
    return report


def _build_summary(report: dict) -> str:
    """One-line orientation string."""
    comp_names = list(report.get('components', {}).keys())
    anomalies = report['anomalies']
    completions = report.get('completions', [])
    if not anomalies and completions:
        msgs = '; '.join(c.get('message', 'complete') for c in completions[:3])
        return f'COMPLETE — {msgs}'
    if not anomalies:
        comps = ', '.join(comp_names[:4])
        if len(comp_names) > 4:
            comps += f', +{len(comp_names) - 4} more'
        return f'HEALTHY — {comps} OK'

    criticals = [a for a in anomalies if a.get('severity') == 'critical']
    warnings = [a for a in anomalies if a.get('severity') == 'warning']
    parts = []
    for a in criticals + warnings:
        msg = a.get('message', '')[:80]
        parts.append(msg)
    summary = f'DEGRADED — {"; ".join(parts[:3])}'
    if len(parts) > 3:
        summary += f' (+{len(parts) - 3} more)'
    return summary


def _build_watch_overview(config: dict, registry, state: dict,
                          project: Path) -> dict:
    """Configuration overview — what's being watched and how."""
    instance = config.get('instance', {})
    alert_cfg = config.get('alerts', {})
    daemon_state = _read_daemon_state(project)

    # Alert targets (redacted for safety)
    email = alert_cfg.get('email', {}).get('to', '')
    webhook = alert_cfg.get('webhook', {}).get('url', '')
    alerts = {}
    if email:
        alerts['email'] = _redact_email(email)
    if webhook:
        alerts['webhook'] = _redact_url(webhook)

    # Version tracking
    vt = None
    gv_cfg = registry.get_config('git_version') if hasattr(registry, 'get_config') else {}
    if gv_cfg and gv_cfg.get('repositories'):
        repos = gv_cfg['repositories']
        vt = {
            'enabled': True,
            'repos': [r['name'] for r in repos],
            'deploy_branch': gv_cfg.get('deploy', {}).get('deploy_branch', 'deploy'),
        }

    # Daemon status (from state file) + liveness (from daemon.jsonl freshness)
    daemon_liveness = _check_daemon_liveness(project, config)
    daemon_alive = len(daemon_liveness) == 0

    return {
        'project': str(project),
        'instance': instance.get('name', ''),
        'components': [c.name for c in registry.enabled()] if hasattr(registry, 'enabled') else [],
        'alerts': alerts,
        'daemon': {
            'alive': daemon_alive,
            'running': daemon_state.get('running', daemon_alive),
            'pid': daemon_state.get('pid'),
            'interval_seconds': daemon_state.get('interval'),
            'last_poll': daemon_state.get('last_poll'),
        },
        'intervals': {
            'normal': _format_duration(instance.get('check_interval_normal', 43200)),
            'anomaly': _format_duration(instance.get('check_interval_anomaly', 1800)),
        },
        'version_tracking': vt,
    }


def _build_history(report: dict, project: Path) -> dict:
    """Delta from previous check."""
    prev = get_last_report(project)
    if not prev:
        return {'previous_check': None, 'seconds_ago': None, 'deltas': {}}

    deltas: dict[str, dict[str, float]] = {}
    prev_comps = prev.get('components', {})
    for name, comp in report.get('components', {}).items():
        prev_metrics = prev_comps.get(name, {}).get('metrics', {})
        curr_metrics = comp.get('metrics', {})
        comp_deltas = {}
        for k, v in curr_metrics.items():
            if k in prev_metrics and isinstance(v, (int, float)):
                comp_deltas[k] = round(v - prev_metrics[k], 2)
        if comp_deltas:
            deltas[name] = comp_deltas

    return {
        'previous_check': prev.get('timestamp'),
        'seconds_ago': None,  # caller computes relative
        'deltas': deltas,
    }


def _build_escalation(state: dict) -> dict:
    """Escalation state — consecutive counts and remedy history."""
    consecutive = {}
    for k, v in state.items():
        if k.startswith('consecutive_'):
            consecutive[k[len('consecutive_'):]] = v

    remedies = state.get('_remedies', [])

    return {
        'consecutive': consecutive,
        'alerts_sent_this_cycle': '_alert_sent' in state,
        'remedies_attempted': remedies,
    }


def _redact_email(email: str) -> str:
    """Redact email for safe display: ab***@domain."""
    if '@' not in email:
        return email[:2] + '***'
    local, domain = email.split('@', 1)
    return local[:2] + '***@' + domain


def _redact_url(url: str) -> str:
    """Show only domain of webhook URL."""
    try:
        p = urlparse(url)
        return p.netloc or url[:20] + '...'
    except Exception:
        return url[:20] + '...'


def _format_duration(seconds: int | float) -> str:
    """Format seconds into human-readable duration."""
    seconds = int(seconds)
    if seconds < 60:
        return f'{seconds}s'
    if seconds < 3600:
        return f'{seconds // 60}m'
    return f'{seconds // 3600}h'
