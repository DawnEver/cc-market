"""Core supervision loop — discover components, run checks, apply remedies, escalate."""

from __future__ import annotations

import json
import sys
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from datetime import datetime, timezone
from pathlib import Path

from components.base import Action, Anomaly, run_command
from components.registry import create_registry
from core.alert import send_email, send_webhook
from core.config import load_config
from core.log import append_report, get_last_report
from core.state import (load_state, save_state, track_anomaly, reset_anomaly,
                         record_last_healthy, record_remedy_attempt, set_alert_sent)

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
            }
            for a in result.anomalies:
                a.source = f'{comp.name}.{a.type}'
            report['anomalies'].extend(result.anomalies)
        except FutureTimeoutError:
            print(f'[{comp.name}] timed out after {CHECK_TIMEOUT}s', file=sys.stderr, flush=True)
            report['components'][comp.name] = {'error': f'timed out after {CHECK_TIMEOUT}s'}
        except Exception as e:
            print(f'[{comp.name}] check failed: {e}', file=sys.stderr, flush=True)
            report['components'][comp.name] = {'error': str(e)}

    # 4. Apply remedies for each anomaly
    if not report['anomalies']:
        for key in list(state.keys()):
            if key.startswith('consecutive_'):
                state.pop(key, None)
        state.pop('_alert_sent', None)
        state.pop('_remedies', None)
        record_last_healthy(state, ts)
    else:
        context: dict[str, object] = {}
        for anomaly in report['anomalies']:
            steps = registry.get_remedies(anomaly.type)
            if not steps or (len(steps) == 1 and steps[0].action == 'log'):
                track_anomaly(state, anomaly.type)
                continue

            print(f'  [{anomaly.type}] applying remedies...', file=sys.stderr, flush=True)
            escalate_count = 0
            for step in steps:
                if step.on != 'always' and step.on != anomaly.severity:
                    continue
                if step.condition and not _eval_condition(step.condition, state):
                    continue

                action = registry.get_action(step.action)
                if not action:
                    print(f'    action "{step.action}" not found, skipping', file=sys.stderr)
                    continue

                for attempt in range(step.max_attempts):
                    ok = _execute_action(action, project, registry,
                                        anomaly.source or '', context)
                    if ok:
                        record_remedy_attempt(state, anomaly.type, step.action, 'ok', attempt + 1)
                        break
                    print(f'    retry {attempt + 1}/{step.max_attempts}', file=sys.stderr)
                else:
                    record_remedy_attempt(state, anomaly.type, step.action, 'failed', step.max_attempts)

                if step.escalate_after:
                    escalate_count = track_anomaly(state, anomaly.type)
                    if escalate_count >= step.escalate_after:
                        _escalate(config, anomaly, escalate_count, report, dry_run)
                        set_alert_sent(state, ts)

    # 5. Status
    if any(a.severity == 'critical' for a in report['anomalies']):
        report['status'] = 'degraded'
    elif report['anomalies']:
        report['status'] = 'degraded'

    # 5b. Serialize anomalies (Anomaly objects → dicts)
    report = _to_serializable(report)

    # 5c. Enrich report with progressive disclosure layers
    report = _enrich_report(report, registry, config, state, project)

    # 6. Persist
    save_state(project, state, log_cfg.get('state_file', '.claude/watch/state/monitor.json'))

    append_report(report, project, log_file=log_cfg.get('log_file', '.claude/watch/logs/health.jsonl'),
                  max_entries=log_cfg.get('max_entries', 10000))
    return report


def _to_serializable(report: dict) -> dict:
    """Convert Anomaly objects to plain dicts for JSON output."""
    out = dict(report)
    out['anomalies'] = [
        {'type': a.type, 'severity': a.severity, 'message': a.message,
         'value': a.value, 'threshold': a.threshold, 'source': a.source}
        for a in report['anomalies']
    ]
    return out


def _execute_action(action: Action, project_dir: Path,
                    registry=None, anomaly_source: str = '',
                    context: dict | None = None) -> bool:
    """Execute an Action. Delegates special actions (__deploy__, __rollback__, etc.)
    to the owning component. Returns True on success."""
    ctx = context or {}

    # Delegate special actions to the component
    if action.command and action.command.startswith('__'):
        special = action.command.strip('_')
        if registry and anomaly_source:
            comp_name = anomaly_source.split('.')[0]
            comp = registry.get(comp_name)
            if comp and hasattr(comp, 'execute_action'):
                return comp.execute_action(special, registry.get_config(comp_name),
                                          {}, project_dir, ctx)  # type: ignore[call-arg]
        print(f'    cannot delegate {special}: no component found', file=sys.stderr)
        return False

    if action.start:
        # Restart action — supports multiple kill/start commands
        if action.kill:
            kills = action.kill if isinstance(action.kill, list) else [action.kill]
            for kill_cmd in kills:
                run_command(kill_cmd, shell=True, cwd=str(project_dir), timeout=15)
        import time
        time.sleep(action.wait)
        starts = action.start if isinstance(action.start, list) else [action.start]
        for start_cmd in starts:
            rc, out, err = run_command(start_cmd, shell=True, cwd=str(project_dir),
                                       timeout=action.timeout)
            if rc != 0:
                print(f'    start failed [{start_cmd[:60]}]: {err}', file=sys.stderr)
                return False
        print(f'    started {len(starts)} process(es)', file=sys.stderr)
        return True

    if action.command:
        rc, out, err = run_command(action.command, shell=action.shell,
                                   cwd=str(project_dir), timeout=action.timeout)
        if rc != 0:
            print(f'    command failed: {err}', file=sys.stderr)
            return False
        if out:
            print(f'    {out[:200]}', file=sys.stderr)
        return True

    return False


def _eval_condition(condition: str, context: dict) -> bool:
    """Minimal condition evaluator. Supports: $var > 0, $var == 0, $var."""
    cond = condition.strip()
    # Simple variable reference
    if cond.startswith('$'):
        var = cond[1:].split()[0]
        return bool(context.get(var, 0))
    # Comparison: $var > 0
    import re
    m = re.match(r'\$(\w+)\s*(>|<|==|!=)\s*(\S+)', cond)
    if m:
        var, op, val = m.group(1), m.group(2), m.group(3)
        ctx_val = context.get(var, 0)
        try:
            val = float(val) if '.' in val else int(val)
        except ValueError:
            pass
        if op == '>':
            return ctx_val > val
        if op == '<':
            return ctx_val < val
        if op == '==':
            return ctx_val == val
        if op == '!=':
            return ctx_val != val
    return True


# ── Report enrichment (progressive disclosure) ──────────────────────────

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

    return {
        'project': str(project),
        'instance': instance.get('name', ''),
        'components': [c.name for c in registry.enabled()] if hasattr(registry, 'enabled') else [],
        'alerts': alerts,
        'daemon': {
            'running': daemon_state.get('running', False),
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


def _read_daemon_state(project: Path) -> dict:
    """Read watchd daemon state file if it exists."""
    path = project / '.claude/watch/state/daemon.json'
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def _redact_email(email: str) -> str:
    """Redact email for safe display: ab***@domain."""
    if '@' not in email:
        return email[:2] + '***'
    local, domain = email.split('@', 1)
    return local[:2] + '***@' + domain


def _redact_url(url: str) -> str:
    """Show only domain of webhook URL."""
    from urllib.parse import urlparse
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


def _escalate(config: dict, anomaly: Anomaly, count: int,
              report: dict, dry_run: bool) -> None:
    """Send alert on escalated anomaly."""
    instance = config['instance']['name']
    subject = f'{anomaly.type} (x{count} consecutive)'

    body_lines = [
        f'<h2>[{instance}] Escalated anomaly</h2>',
        f'<p><b>{anomaly.severity.upper()}</b>: {anomaly.message}</p>',
        f'<p>Consecutive occurrences: {count}</p>',
        f'<p>Timestamp: {report["timestamp"]}</p>',
    ]
    body = '\n'.join(body_lines)

    send_email(subject, body, config, dry_run=dry_run)
    webhook_payload = {
        'text': f'*[{instance}]* {anomaly.severity.upper()}: {anomaly.message} (x{count})',
        'instance': instance,
        'anomaly': {'type': anomaly.type, 'severity': anomaly.severity, 'message': anomaly.message},
        'count': count,
        'timestamp': report['timestamp'],
    }
    send_webhook(config, webhook_payload, dry_run=dry_run)
