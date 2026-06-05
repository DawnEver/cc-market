"""Core supervision loop — discover components, run checks, apply remedies, escalate."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from components.base import Action, Anomaly, run_command
from components.registry import create_registry
from core.alert import send_email, send_webhook
from core.config import load_config
from core.log import append_report
from core.state import load_state, save_state, track_anomaly


def run(project_dir: str | Path, dry_run: bool = False) -> dict:
    """Execute one supervision cycle. Returns the report dict."""
    project = Path(project_dir).resolve()
    config = load_config(project)

    # 1. Component registry
    registry = create_registry(config, project)
    enabled = registry.enabled()
    if not enabled:
        print('[watch] No components enabled. Check your watch.yaml.')
        return {'status': 'healthy', 'anomalies': [], 'components': {}}

    # 2. State
    log_cfg = config.get('logging', {})
    state = load_state(project, log_cfg.get('state_file', '.claude/watch-state.json'))

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
        print(f'[{comp.name}] checking...')
        try:
            result = comp.check(comp_cfg, config, state)
            report['components'][comp.name] = {
                'metrics': result.metrics,
                'anomalies': [{'type': a.type, 'severity': a.severity,
                               'message': a.message} for a in result.anomalies],
            }
            for a in result.anomalies:
                a.source = f'{comp.name}.{a.type}'
            report['anomalies'].extend(result.anomalies)
        except Exception as e:
            print(f'[{comp.name}] check failed: {e}')
            report['components'][comp.name] = {'error': str(e)}

    # 4. Apply remedies for each anomaly
    if not report['anomalies']:
        for key in list(state.keys()):
            if key.startswith('consecutive_'):
                state.pop(key, None)
    else:
        context: dict[str, object] = {}
        for anomaly in report['anomalies']:
            steps = registry.get_remedies(anomaly.type)
            if not steps or (len(steps) == 1 and steps[0].action == 'log'):
                track_anomaly(state, anomaly.type)
                continue

            print(f'  [{anomaly.type}] applying remedies...')
            escalate_count = 0
            for step in steps:
                if step.on != 'always' and step.on != anomaly.severity:
                    continue
                if step.condition and not _eval_condition(step.condition, state):
                    continue

                action = registry.get_action(step.action)
                if not action:
                    print(f'    action "{step.action}" not found, skipping')
                    continue

                for attempt in range(step.max_attempts):
                    ok = _execute_action(action, project, registry,
                                        anomaly.source or '', context)
                    if ok:
                        break
                    print(f'    retry {attempt + 1}/{step.max_attempts}')

                if step.escalate_after:
                    escalate_count = track_anomaly(state, anomaly.type)
                    if escalate_count >= step.escalate_after:
                        _escalate(config, anomaly, escalate_count, report, dry_run)

    # 5. Status
    if any(a.severity == 'critical' for a in report['anomalies']):
        report['status'] = 'degraded'
    elif report['anomalies']:
        report['status'] = 'degraded'

    # 6. Persist
    save_state(project, state, log_cfg.get('state_file', '.claude/watch-state.json'))

    output = _to_serializable(report)
    append_report(output, project, log_file=log_cfg.get('log_file', '.claude/health-log.jsonl'),
                  max_entries=log_cfg.get('max_entries', 10000))
    return output


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
        print(f'    cannot delegate {special}: no component found')
        return False

    if action.start:
        # Restart action
        if action.kill:
            run_command(action.kill, shell=True, cwd=str(project_dir), timeout=15)
            import time
            time.sleep(action.wait)
        rc, out, err = run_command(action.start, shell=True, cwd=str(project_dir),
                                   timeout=action.timeout)
        if rc != 0:
            print(f'    start failed: {err}')
            return False
        print(f'    started: {action.start}')
        return True

    if action.command:
        rc, out, err = run_command(action.command, shell=action.shell,
                                   cwd=str(project_dir), timeout=action.timeout)
        if rc != 0:
            print(f'    command failed: {err}')
            return False
        if out:
            print(f'    {out[:200]}')
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
