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
import time

# Re-poll after a kill to confirm the port is freed before declaring success.
_VERIFY_DELAY = 0.4
_KILL_ATTEMPTS = 3

# Suppress the transient console window each child (netstat/taskkill/tasklist)
# would otherwise flash on Windows. 0 (no-op) on POSIX.
NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0


def _run(cmd: list[str], timeout: int = 5) -> str:
    try:
        return subprocess.check_output(
            cmd, text=True, timeout=timeout, stderr=subprocess.DEVNULL,
            creationflags=NO_WINDOW,
        ).strip()
    except Exception:
        return ''


def parse_listening_pids_win(netstat_output: str, port: str) -> list[str]:
    """Parse `netstat -ano` output for PIDs LISTENING on exactly the given port.

    Robust to inconsistent column spacing (splits on arbitrary whitespace) and
    ignores non-LISTENING states (TIME_WAIT, ESTABLISHED, etc). Matches the port
    exactly against the local-address column so :7001 does not match :70010.
    """
    pids: list[str] = []
    suffix = f':{port}'
    for line in netstat_output.splitlines():
        parts = line.split()
        # Expected TCP row: Proto  Local  Foreign  State  PID
        if len(parts) < 5:
            continue
        if parts[0].upper() != 'TCP':
            continue
        if parts[3].upper() != 'LISTENING':
            continue
        local_addr = parts[1]
        if not local_addr.endswith(suffix):
            continue
        # Confirm the matched segment is the port column, not part of an address.
        host, _, addr_port = local_addr.rpartition(':')
        if addr_port != port:
            continue
        pid = parts[-1]
        if pid.isdigit() and pid not in pids:
            pids.append(pid)
    return pids


def _listening_pids(port: str) -> list[str]:
    """Return PIDs currently LISTENING on the port (cross-platform)."""
    if sys.platform == 'win32':
        return parse_listening_pids_win(_run(['netstat', '-ano']), port)
    out = _run(['lsof', '-ti', f'tcp:{port}', '-sTCP:LISTEN'])
    if not out:
        # Older lsof may not accept -sTCP filter combined with -ti; fall back.
        out = _run(['lsof', '-ti', f'tcp:{port}'])
    return [pid for pid in out.splitlines() if pid.strip()]


def _kill_pid(pid: str) -> None:
    if sys.platform == 'win32':
        _run(['taskkill', '/F', '/PID', pid, '/T'])
    else:
        try:
            os.kill(int(pid), 9)
        except (ProcessLookupError, ValueError):
            pass


def kill_by_port(port: str) -> bool:
    """Kill whatever is LISTENING on the port; re-poll to confirm it's freed.

    Retries a couple of times with short backoff. Returns True if the port is
    free at the end, False if it is still bound.
    """
    pids = _listening_pids(port)
    if not pids:
        print(f'No process found listening on port {port}')
        return True

    for attempt in range(1, _KILL_ATTEMPTS + 1):
        for pid in pids:
            print(f'Killing PID {pid} (port {port}, attempt {attempt})...')
            _kill_pid(pid)
        time.sleep(_VERIFY_DELAY * attempt)
        pids = _listening_pids(port)
        if not pids:
            print(f'Port {port} is now free')
            return True

    print(f'WARNING: port {port} still bound by PID(s) {", ".join(pids)} after '
          f'{_KILL_ATTEMPTS} attempts')
    return False


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

    port_freed = True
    if args.port:
        port_freed = kill_by_port(args.port)

    if args.pattern:
        kill_by_pattern(args.pattern)
    elif not port_freed:
        # Port still bound and no explicit pattern given: nothing more we can do
        # safely, so signal failure to the caller.
        sys.exit(1)


if __name__ == '__main__':
    main()
