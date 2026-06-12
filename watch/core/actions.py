"""Action execution and condition evaluation for the supervision loop."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from components.base import Action, run_command

# Bundled helper scripts ship alongside the plugin; resolve them from this
# file's location so config never globs ~/.claude/plugins/... (install-root and
# cache-layout fragile) to find them.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / 'scripts'


def _run_script(script: str, args: list[str], cwd: Path,
                timeout: int) -> tuple[int, str, str]:
    """Run a bundled helper script (kill-server.py / start-server.py)."""
    try:
        r = subprocess.run(
            [sys.executable, str(_SCRIPTS_DIR / script), *args],
            cwd=str(cwd), capture_output=True, text=True, timeout=timeout,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return -1, '', f'{script} timed out after {timeout}s'
    except Exception as e:
        return -1, '', str(e)


def _exec_managed(action: Action, project_dir: Path) -> bool:
    """Execute the managed-service form: free port(s)/pattern via kill-server.py,
    then spawn start_cmd detached via start-server.py. Both helpers are
    cross-platform; project specifics live in data fields, not shell strings."""
    ports = action.kill_port if isinstance(action.kill_port, list) else (
        [action.kill_port] if action.kill_port is not None else [])
    for port in ports:
        _run_script('kill-server.py', ['--port', str(port)], project_dir, timeout=20)
    if action.kill_pattern:
        _run_script('kill-server.py', ['--pattern', action.kill_pattern],
                    project_dir, timeout=20)

    if action.start_cmd:
        time.sleep(action.wait)
        cwd = (project_dir / action.start_dir).resolve() if action.start_dir else project_dir
        args = ['--project-dir', str(cwd), '--cmd', action.start_cmd]
        if action.start_log:
            args += ['--log', str(project_dir / action.start_log)]
        rc, out, err = _run_script('start-server.py', args, project_dir, action.timeout)
        if rc != 0:
            print(f'    start failed [{action.start_cmd[:60]}]: {err}', file=sys.stderr)
            return False
        if out:
            print(f'    {out}', file=sys.stderr)
    return True


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

    # Delegate special actions (__deploy__, __recover_service__, ...) to the
    # component that implements them. Prefer the anomaly's own component; fall
    # back to the component that *declares* this action — a health anomaly
    # (http_health/shell_probe) can trigger a git_version action like recovery.
    if action.command and action.command.startswith('__'):
        special = action.command.strip('_')
        comp = None
        if registry and anomaly_source:
            c = registry.get(anomaly_source.split('.')[0])
            if c is not None and hasattr(c, 'execute_action'):
                comp = c
        if comp is None and registry is not None:
            for c in getattr(registry, '_components', {}).values():
                if hasattr(c, 'execute_action') and any(
                        a.command == action.command for a in c.actions().values()):
                    comp = c
                    break
        if comp is not None:
            ctx['_registry'] = registry
            ctx['_project_dir'] = str(project_dir)
            return comp.execute_action(special, registry.get_config(comp.name),
                                       {}, project_dir, ctx)  # type: ignore[call-arg]
        print(f'    cannot delegate {special}: no component found', file=sys.stderr)
        return False

    # Composition — run other named actions in order (e.g. restart_all =
    # [restart_backend, restart_frontend]), so multi-tier actions don't
    # duplicate their per-tier command strings.
    if action.steps:
        ok = True
        for sname in action.steps:
            sub = registry.get_action(sname) if registry else None
            if sub is None:
                print(f'    step action "{sname}" not found', file=sys.stderr)
                ok = False
                continue
            ok = _execute_action(sub, project_dir, registry, anomaly_source, ctx) and ok
        return ok

    # Managed-service form — declarative kill_port/start_cmd handled by the
    # bundled cross-platform helpers (no inline plugin-path glob in config).
    if action.kill_port is not None or action.kill_pattern or action.start_cmd:
        return _exec_managed(action, project_dir)

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
