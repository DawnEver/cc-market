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
from pathlib import Path


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
    else:
        popen_kwargs['start_new_session'] = True  # type: ignore[call-arg]

    proc = subprocess.Popen(cmd_parts, **popen_kwargs)  # type: ignore[arg-type]
    print(f'Process started (PID {proc.pid}) in {cwd}')


if __name__ == '__main__':
    main()
