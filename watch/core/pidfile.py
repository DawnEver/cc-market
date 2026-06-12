#!/usr/bin/env python3
"""Cross-platform single-instance pidfile guard.

Shared by watchd (watchd/daemon.py) and trigger-watch (scripts/trigger-watch.py).
Both re-exec into a managed venv via ``bootstrap.ensure()`` *before* calling
``acquire()``, so the PID written here is the real, post-exec worker PID — which is
what makes external start/stop tooling deterministic.

Why this matters on Windows: ``os.execv`` has no native equivalent and CPython
emulates it with a CRT ``P_OVERLAY`` spawn. The launching process becomes a waiting
stub and the actual worker receives a *fresh* PID. Any PID captured at spawn time
(e.g. from a launcher's ``Popen``) is therefore stale the instant bootstrap re-execs.
Writing the pidfile from the worker itself is the only reliable handle. Killing that
worker also unblocks and ends the Windows wait-stub parent.
"""
from __future__ import annotations

import atexit
import os
import sys
from pathlib import Path

_STATE_DIR = ('.claude', 'watch', 'state')


def pid_alive(pid: int) -> bool:
    """True if a process with this PID is currently running (cross-platform)."""
    try:
        import psutil
        return psutil.pid_exists(pid)
    except ImportError:
        if sys.platform == 'win32':
            import ctypes
            SYNCHRONIZE = 0x100000
            WAIT_TIMEOUT = 0x00000102
            h = ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE, False, pid)
            if not h:
                return False
            alive = ctypes.windll.kernel32.WaitForSingleObject(h, 0) == WAIT_TIMEOUT
            ctypes.windll.kernel32.CloseHandle(h)
            return alive
        else:
            try:
                os.kill(pid, 0)
                return True
            except (OSError, ProcessLookupError):
                return False


def path(project_dir: Path, name: str) -> Path:
    """Absolute path of pidfile ``name`` under the project's watch state dir."""
    p = project_dir.joinpath(*_STATE_DIR, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def read(project_dir: Path, name: str) -> int | None:
    """Return the PID stored in the pidfile, or None if absent/unreadable."""
    try:
        return int(path(project_dir, name).read_text(encoding='utf-8').strip())
    except (ValueError, OSError):
        return None


def acquire(project_dir: Path, name: str) -> bool:
    """Claim the pidfile for the current process.

    Returns False if a *different* live process already holds it (single-instance
    guard); otherwise writes our PID, registers cleanup, and returns True. A stale
    pidfile (owner dead) is silently taken over.
    """
    p = path(project_dir, name)
    owner = read(project_dir, name)
    if owner is not None and owner != os.getpid() and pid_alive(owner):
        return False
    p.write_text(str(os.getpid()), encoding='utf-8')
    atexit.register(release, project_dir, name)
    return True


def release(project_dir: Path, name: str) -> None:
    """Remove the pidfile, but only if it still points at the current process."""
    try:
        if read(project_dir, name) == os.getpid():
            path(project_dir, name).unlink()
    except OSError:
        pass


def terminate(project_dir: Path, name: str, timeout: float = 5.0) -> bool:
    """Kill whatever process holds the pidfile (cross-platform).

    Returns True if a live owner was found and signalled. Used by ``--force``
    takeover and by external stop tooling.
    """
    pid = read(project_dir, name)
    if pid is None or not pid_alive(pid):
        return False
    try:
        import psutil
    except ImportError:
        import signal
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            return False
        return True
    try:
        proc = psutil.Process(pid)
        proc.terminate()
        proc.wait(timeout=timeout)
    except psutil.NoSuchProcess:
        return False
    except psutil.TimeoutExpired:
        proc.kill()  # type: ignore[possibly-unbound]
    return True
