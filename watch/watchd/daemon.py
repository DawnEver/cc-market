#!/usr/bin/env python3
"""watchd — lightweight poller. Reuses Component.check() from the AI loop.
Only wakes Claude Code on anomalies. Zero duplicate check logic.

Usage: python daemon.py --project-dir /path [--interval 300] [--once] [--dry-run]
"""
from __future__ import annotations

import argparse, json, sys, time
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent
sys.path.insert(0, str(_PLUGIN_ROOT))
sys.path.insert(0, str(_PLUGIN_ROOT / 'scripts'))

import bootstrap; bootstrap.ensure()

from core.config import load_config as load_main_config
from core.state import load_state, save_state, track_anomaly as track
from components.registry import create_registry

LOG_FILE = '.claude/watch/logs/daemon.jsonl'
STATE_FILE = '.claude/watch/state/daemon.json'
TRIGGER_FILE = '.claude/watch/trigger.json'


def log(project_dir: Path, level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    print(f'[{ts}] {level}: {msg}')
    try:
        p = project_dir / LOG_FILE
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, 'a', encoding='utf-8') as f:
            f.write(json.dumps({'ts': ts, 'level': level, 'msg': msg}, ensure_ascii=False) + '\n')
    except Exception: pass


def wake_claude(project_dir: Path, reason: str, detail: str, dry_run: bool = False) -> None:
    if dry_run:
        log(project_dir, 'info', f'[DRYRUN] Would wake Claude: {reason} — {detail}')
        return
    trigger = project_dir / TRIGGER_FILE
    trigger.parent.mkdir(parents=True, exist_ok=True)
    trigger.write_text(json.dumps({
        'reason': reason, 'detail': detail,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'project_dir': str(project_dir),
    }, ensure_ascii=False) + '\n', encoding='utf-8')
    log(project_dir, 'info', f'Waking Claude: {reason}')


def poll(project_dir: Path, registry, config: dict, state: dict, dry_run: bool = False) -> None:
    """Run all enabled components. Reuses exact same check() as AI loop."""
    components = registry.enabled()
    if not components:
        log(project_dir, 'warn', 'No components enabled.')
        return

    all_ok = True
    names = [c.name for c in components]
    log(project_dir, 'info', f'Polling ({", ".join(names)})')

    for comp in components:
        comp_cfg = registry.get_config(comp.name)
        try:
            result = comp.check(comp_cfg, config, state)
            tag = 'OK' if not result.anomalies else 'FAIL'
            log(project_dir, 'info', f'  [{comp.name}] {tag} {result.metrics}')
            if result.anomalies:
                all_ok = False
                for a in result.anomalies:
                    log(project_dir, 'warn', f'  [{comp.name}] [{a.severity}] {a.message}')
                    track(state, f'{comp.name}_{a.type}')
        except Exception as e:
            log(project_dir, 'error', f'  [{comp.name}] crashed: {e}')
            all_ok = False
            track(state, f'{comp.name}_error')

    # Update fails count BEFORE escalation check so 2nd fail triggers
    state['fails'] = 0 if all_ok else state.get('fails', 0) + 1

    if all_ok:
        # Reset consecutive counters on recovery
        for key in list(state):
            if key.startswith('consecutive_'):
                state.pop(key, None)
        state['last_ok'] = datetime.now(timezone.utc).isoformat()
        log(project_dir, 'info', 'All OK.')
    elif state['fails'] >= 2:
        ck = {k: v for k, v in state.items() if isinstance(v, int) and k.startswith('consecutive_')}
        detail = ', '.join(f'{k}:{v}x' for k, v in ck.items()) if ck else 'checkers failing'
        wake_claude(project_dir, 'anomalies_detected', detail, dry_run)

    save_state(project_dir, state, STATE_FILE)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='watchd — lightweight poller')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--interval', type=int, default=300)
    p.add_argument('--once', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args(argv)

    project_dir = Path(args.project_dir).resolve()
    config = load_main_config(project_dir)
    registry = create_registry(config, project_dir)
    state = load_state(project_dir, STATE_FILE)

    if not registry.enabled():
        log(project_dir, 'warn', 'No components enabled in config. Add components.<name>.enabled: true')
        if args.once:
            return
        while True:
            time.sleep(args.interval)
            config = load_main_config(project_dir)
            registry = create_registry(config, project_dir)
            if registry.enabled():
                log(project_dir, 'info', 'Components now enabled, starting polling.')
                break

    log(project_dir, 'info', f'watchd started (interval={args.interval}s)')
    poll(project_dir, registry, config, state, args.dry_run)

    if args.once:
        log(project_dir, 'info', 'One-shot done.')
        return

    while True:
        time.sleep(args.interval)
        config = load_main_config(project_dir)
        registry = create_registry(config, project_dir)
        state = load_state(project_dir, STATE_FILE)
        poll(project_dir, registry, config, state, args.dry_run)


if __name__ == '__main__':
    main()
