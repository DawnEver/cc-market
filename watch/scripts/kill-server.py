"""Cross-platform process killer for watch plugin.

Finds and kills processes by port (Windows) or by name pattern (Unix).
Works on Windows, Linux, and macOS.

Usage:
  python kill-server.py --port 7001 --pattern "uvicorn myapp"
  python kill-server.py --port 7001                     # port-based only
  python kill-server.py --pattern "uvicorn myapp"        # pattern-based only
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys


def _run(cmd: list[str], timeout: int = 5) -> str:
    try:
        return subprocess.check_output(
            cmd, text=True, timeout=timeout, stderr=subprocess.DEVNULL
        ).strip()
    except Exception:
        return ''


def kill_by_port(port: str) -> None:
    """Kill process listening on the given port (cross-platform)."""
    if sys.platform == 'win32':
        output = _run(['netstat', '-ano'])
        if not output:
            print(f'No process found listening on port {port}')
            return
        for line in output.splitlines():
            if f':{port}' in line and 'LISTENING' in line:
                parts = line.strip().split()
                pid = parts[-1]
                print(f'Killing PID {pid} (port {port})...')
                _run(['taskkill', '/F', '/PID', pid, '/T'])
    else:
        # lsof is more portable than pkill -f for port-based lookup
        output = _run(['lsof', '-ti', f'tcp:{port}'])
        if not output:
            print(f'No process found listening on port {port}')
            return
        for pid in output.splitlines():
            print(f'Killing PID {pid} (port {port})...')
            try:
                os.kill(int(pid), 9)
            except ProcessLookupError:
                pass
    print(f'Done checking port {port}')


def kill_by_pattern(pattern: str) -> None:
    """Kill processes matching the given name pattern (Unix: pkill, Windows: taskkill)."""
    if sys.platform == 'win32':
        output = _run(['tasklist', '/FI', f'IMAGENAME eq {pattern}'])
        if not output or 'No tasks' in output:
            print(f'No process found matching pattern: {pattern}')
            return
        _run(['taskkill', '/F', '/IM', pattern, '/T'])
    else:
        _run(['pkill', '-f', pattern])
    print(f'Killed processes matching: {pattern}')


def main() -> None:
    p = argparse.ArgumentParser(description='Cross-platform process killer')
    p.add_argument('--port', default=os.environ.get('WATCH_PORT', ''))
    p.add_argument('--pattern', default=os.environ.get('WATCH_KILL_PATTERN', ''))
    args = p.parse_args()

    if not args.port and not args.pattern:
        p.error('At least one of --port or --pattern is required')

    if args.port:
        kill_by_port(args.port)
    if args.pattern:
        kill_by_pattern(args.pattern)


if __name__ == '__main__':
    main()
