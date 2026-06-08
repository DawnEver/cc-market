"""Action execution and condition evaluation for the supervision loop."""

from __future__ import annotations

import sys
import time
from pathlib import Path

from components.base import Action, run_command


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
                ctx['_registry'] = registry
                ctx['_project_dir'] = str(project_dir)
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
