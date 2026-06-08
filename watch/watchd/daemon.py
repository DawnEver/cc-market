#!/usr/bin/env python3
"""watchd — lightweight poller. Reuses Component.check() from the AI loop.
Only wakes Claude Code on anomalies. Zero duplicate check logic.

All paths and thresholds come from config.yaml (watchd.* section).
CLI --interval overrides config value.

Usage: python daemon.py --project-dir /path [--interval 300] [--once] [--dry-run]
"""
from __future__ import annotations

import argparse, atexit, json, os, sys, time
from datetime import datetime, timezone
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_PLUGIN_ROOT = _HERE.parent
sys.path.insert(0, str(_PLUGIN_ROOT))
sys.path.insert(0, str(_PLUGIN_ROOT / 'scripts'))

import bootstrap; bootstrap.ensure()

from core.config import load_config as load_main_config
from core.state import load_state, save_state, track_anomaly as track
from core.log import append_report
from components.registry import create_registry


# ── PID file guard ───────────────────────────────────────────────
def _pid_path(project_dir: Path) -> Path:
    p = project_dir / '.claude' / 'watch' / 'state' / 'watchd.pid'
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _pid_alive(pid: int) -> bool:
    """Check if a process with given PID is alive (cross-platform)."""
    try:
        import psutil
        return psutil.pid_exists(pid)
    except ImportError:
        if sys.platform == 'win32':
            import ctypes.wintypes
            SYNCHRONIZE = 0x100000
            h = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if not h:
                return False
            WAIT_TIMEOUT = 0x00000102
            alive = ctypes.windll.kernel32.WaitForSingleObject(h, 0) == WAIT_TIMEOUT
            ctypes.windll.kernel32.CloseHandle(h)
            return alive
        else:
            try:
                os.kill(pid, 0)
                return True
            except (OSError, ProcessLookupError):
                return False


def _acquire_pidfile(project_dir: Path) -> bool:
    """Write PID file if no live instance holds it. Returns True if acquired."""
    path = _pid_path(project_dir)
    if path.exists():
        try:
            stale_pid = int(path.read_text(encoding='utf-8').strip())
            if _pid_alive(stale_pid):
                return False
        except (ValueError, OSError):
            pass
    path.write_text(str(os.getpid()), encoding='utf-8')
    atexit.register(_release_pidfile, project_dir)
    return True


def _release_pidfile(project_dir: Path) -> None:
    path = _pid_path(project_dir)
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def _log(project_dir: Path, log_file: str, level: str, msg: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    print(f'[{ts}] {level}: {msg}')
    append_report({'ts': ts, 'level': level, 'msg': msg}, project_dir,
                  log_file=log_file, max_entries=0)


def _wake_claude(project_dir: Path, config: dict, reason: str, detail: str,
                 dry_run: bool = False) -> None:
    wd = config['watchd']
    log_file = wd['log_file']
    if dry_run:
        _log(project_dir, log_file, 'info', f'[DRYRUN] Would wake Claude: {reason} — {detail}')
        return
    trigger = project_dir / wd['trigger_file']
    trigger.parent.mkdir(parents=True, exist_ok=True)
    trigger.write_text(json.dumps({
        'reason': reason, 'detail': detail,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'project_dir': str(project_dir),
    }, ensure_ascii=False) + '\n', encoding='utf-8')
    _log(project_dir, log_file, 'info', f'Waking Claude: {reason}')


def _poll(project_dir: Path, registry, config: dict, state: dict,
          dry_run: bool = False) -> None:
    """Run all enabled components. Reuses exact same check() as AI loop."""
    wd = config['watchd']
    log_file = wd['log_file']
    components = registry.enabled()
    if not components:
        _log(project_dir, log_file, 'warn', 'No components enabled.')
        return

    all_ok = True
    names = [c.name for c in components]
    _log(project_dir, log_file, 'info', f'Polling ({", ".join(names)})')

    for comp in components:
        comp_cfg = registry.get_config(comp.name)
        try:
            result = comp.check(comp_cfg, config, state)
            tag = 'OK' if not result.anomalies else 'FAIL'
            _log(project_dir, log_file, 'info', f'  [{comp.name}] {tag} {result.metrics}')
            if result.anomalies:
                all_ok = False
                for a in result.anomalies:
                    _log(project_dir, log_file, 'warn',
                         f'  [{comp.name}] [{a.severity}] {a.message}')
                    track(state, f'{comp.name}_{a.type}')
        except Exception as e:
            _log(project_dir, log_file, 'error', f'  [{comp.name}] crashed: {e}')
            all_ok = False
            track(state, f'{comp.name}_error')

    state['fails'] = 0 if all_ok else state.get('fails', 0) + 1
    fail_threshold = wd.get('fail_threshold', 2)

    if all_ok:
        for key in list(state):
            if key.startswith('consecutive_'):
                state.pop(key, None)
        state['last_ok'] = datetime.now(timezone.utc).isoformat()
        _log(project_dir, log_file, 'info', 'All OK.')
    elif state['fails'] >= fail_threshold:
        ck = {k: v for k, v in state.items()
              if isinstance(v, int) and k.startswith('consecutive_')}
        detail = ', '.join(f'{k}:{v}x' for k, v in ck.items()) if ck else 'checkers failing'
        _wake_claude(project_dir, config, 'anomalies_detected', detail, dry_run)

    save_state(project_dir, state, wd['state_file'])

    # Heartbeat — write after each poll so health-check pipeline can verify liveness
    hb_path = project_dir / wd['heartbeat_file']
    hb_path.parent.mkdir(parents=True, exist_ok=True)
    hb_path.write_text(json.dumps({
        'ts': datetime.now(timezone.utc).isoformat(),
        'pid': os.getpid(),
    }, ensure_ascii=False) + '\n', encoding='utf-8')


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description='watchd — lightweight poller')
    p.add_argument('--project-dir', required=True)
    p.add_argument('--interval', type=int, default=None)
    p.add_argument('--once', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    p.add_argument('--force', action='store_true',
                   help='Kill existing daemon and take over')
    args = p.parse_args(argv)

    project_dir = Path(args.project_dir).resolve()

    # ── Single-instance guard ──
    if not _acquire_pidfile(project_dir):
        if args.force:
            pid_path = _pid_path(project_dir)
            stale_pid = int(pid_path.read_text(encoding='utf-8').strip())
            try:
                import psutil
                p = psutil.Process(stale_pid)
                p.terminate()
                p.wait(timeout=5)
            except (ImportError, psutil.NoSuchProcess):
                import signal
                os.kill(stale_pid, signal.SIGTERM)
            except psutil.TimeoutExpired:
                try:
                    p.kill()
                except psutil.NoSuchProcess:
                    pass
            time.sleep(0.5)
            _acquire_pidfile(project_dir)
        else:
            pid_path = _pid_path(project_dir)
            stale_pid = pid_path.read_text(encoding='utf-8').strip()
            print(f'watchd already running (PID {stale_pid}). '
                  f'Use --force to replace.', file=sys.stderr)
            sys.exit(1)

    config = load_main_config(project_dir)
    wd = config['watchd']

    # CLI interval overrides config; config overrides defaults
    interval = args.interval if args.interval is not None else wd['interval']
    log_file = wd['log_file']
    state_file = wd['state_file']

    registry = create_registry(config, project_dir)
    state = load_state(project_dir, state_file)

    if not registry.enabled():
        _log(project_dir, log_file, 'warn',
             'No components enabled in config. Add components.<name>.enabled: true')
        if args.once:
            return
        while True:
            time.sleep(interval)
            config = load_main_config(project_dir)
            registry = create_registry(config, project_dir)
            if registry.enabled():
                _log(project_dir, log_file, 'info', 'Components now enabled, starting polling.')
                break

    _log(project_dir, log_file, 'info', f'watchd started (interval={interval}s)')
    _poll(project_dir, registry, config, state, args.dry_run)

    if args.once:
        _log(project_dir, log_file, 'info', 'One-shot done.')
        return

    while True:
        time.sleep(interval)
        config = load_main_config(project_dir)
        registry = create_registry(config, project_dir)
        state = load_state(project_dir, state_file)
        _poll(project_dir, registry, config, state, args.dry_run)


if __name__ == '__main__':
    main()
