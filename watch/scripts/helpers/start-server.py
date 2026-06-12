"""Cross-platform process starter for watch plugin.

Spawns a command as a detached child process.
Works on Windows, Linux, and macOS.

Usage:
  python start-server.py --project-dir /path/to/project --cmd "uv run python -m myapp"
  python start-server.py --cmd "python -m http.server 8080"
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path

# Brief pause after spawn to detect instant crashes (e.g. bad code / bad args).
_STARTUP_PROBE_DELAY = 0.4


def _is_alive(proc: subprocess.Popen) -> bool:
    """Return True if the child is still running (no exit code yet)."""
    return proc.poll() is None


def _build_win_startupinfo(redirecting: bool):
    """On Windows, force STARTF_USESTDHANDLES when redirecting so child output
    never leaks back to an inherited console window. Returns None elsewhere or
    when not redirecting (DEVNULL handles are passed explicitly anyway)."""
    if sys.platform != 'win32':
        return None
    startupinfo = subprocess.STARTUPINFO()  # type: ignore[attr-defined]
    if redirecting:
        startupinfo.dwFlags |= subprocess.STARTF_USESTDHANDLES  # type: ignore[attr-defined]
    return startupinfo


def main() -> None:
    p = argparse.ArgumentParser(description='Cross-platform detached process starter')
    p.add_argument('--project-dir', default=os.environ.get('WATCH_PROJECT_DIR', str(Path.cwd())))
    p.add_argument('--cmd', default=os.environ.get('WATCH_START_CMD', ''))
    p.add_argument('--log', default='', help='Log file for stdout/stderr (default: DEVNULL)')
    args = p.parse_args()

    if not args.cmd:
        p.error('--cmd is required (the command to spawn)')

    cwd = Path(args.project_dir).resolve()
    cmd_parts = shlex.split(args.cmd) if sys.platform != 'win32' else args.cmd

    log_fh = None
    if args.log:
        log_path = Path(args.log)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_fh = open(str(log_path), 'a')
        popen_kwargs = {
            'cwd': cwd,
            'stdout': log_fh,
            'stderr': log_fh,
        }
    else:
        popen_kwargs = {
            'cwd': cwd,
            'stdout': subprocess.DEVNULL,
            'stderr': subprocess.DEVNULL,
        }

    if sys.platform == 'win32':
        popen_kwargs['creationflags'] = subprocess.DETACHED_PROCESS  # type: ignore[call-arg]
        startupinfo = _build_win_startupinfo(redirecting=bool(args.log))
        if startupinfo is not None:
            popen_kwargs['startupinfo'] = startupinfo  # type: ignore[call-arg]
    else:
        popen_kwargs['start_new_session'] = True  # type: ignore[call-arg]

    try:
        proc = subprocess.Popen(cmd_parts, **popen_kwargs)  # type: ignore[arg-type]
    finally:
        # Parent does not need its own handle to the log; the child keeps it.
        if log_fh is not None:
            log_fh.close()

    # Startup verification: a process that crashes on bad code/args often dies
    # within milliseconds. Give it a brief moment, then confirm it's alive.
    time.sleep(_STARTUP_PROBE_DELAY)
    if not _is_alive(proc):
        rc = proc.returncode
        print(f'Process (PID {proc.pid}) died immediately (exit code {rc}) in {cwd}')
        if args.log:
            print(f'See log for details: {args.log}')
        sys.exit(1)

    print(f'Process started (PID {proc.pid}) in {cwd} — alive after startup probe')


if __name__ == '__main__':
    main()
