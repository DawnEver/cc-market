"""State persistence — probe deltas, escalation counters, known-good versions.

Also home to two cross-platform primitives reused across YOUR deploy-safety files:
``file_lock`` (an advisory ``O_CREAT|O_EXCL`` lockfile with bounded backoff) and
``atomic_write_text`` (temp file in the same dir + ``os.replace``). Both are stdlib
only and behave identically on Win/POSIX.
"""

from __future__ import annotations

import contextlib
import json
import os
import threading
import time
import uuid
from pathlib import Path


_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()


def _thread_lock_for(key: str) -> threading.Lock:
    with _THREAD_LOCKS_GUARD:
        lk = _THREAD_LOCKS.get(key)
        if lk is None:
            lk = threading.Lock()
            _THREAD_LOCKS[key] = lk
        return lk


@contextlib.contextmanager
def file_lock(target: Path, timeout: float = 10.0, poll: float = 0.05):
    """Advisory cross-platform lock guarding read-modify-write of ``target``.

    Two layers: a per-path in-process ``threading.Lock`` (the file lockfile is keyed
    on PID, so it can't serialize threads of the *same* process), plus a
    ``<target>.lock`` created with ``O_CREAT|O_EXCL`` (atomic on Win+POSIX) to
    serialize across processes. Retries with exponential backoff up to ``timeout``;
    a stale lock whose owner PID is dead is taken over; always released in
    ``finally``. On total cross-process timeout it proceeds *unlocked* rather than
    dropping the write — losing serialization is preferable to losing the update
    (and far rarer than a crashed holder leaving a stale file).
    """
    lock = target.with_name(target.name + '.lock')
    lock.parent.mkdir(parents=True, exist_ok=True)
    tlock = _thread_lock_for(str(lock))
    tlock.acquire()
    deadline = time.monotonic() + timeout
    delay = poll
    acquired = False
    try:
        while True:
            try:
                fd = os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode('ascii'))
                os.close(fd)
                acquired = True
                break
            except FileExistsError:
                if _lock_owner_dead(lock):
                    with contextlib.suppress(OSError):
                        lock.unlink()
                    continue
                if time.monotonic() >= deadline:
                    break
                time.sleep(min(delay, max(0.0, deadline - time.monotonic())))
                delay = min(delay * 2, 0.5)
        yield acquired
    finally:
        if acquired:
            with contextlib.suppress(OSError):
                lock.unlink()
        tlock.release()


def _lock_owner_dead(lock: Path) -> bool:
    """True if the lockfile records a PID that is no longer alive."""
    try:
        owner = int(lock.read_text(encoding='ascii').strip())
    except (ValueError, OSError):
        return False
    if owner == os.getpid():
        return False
    from core.pidfile import pid_alive
    return not pid_alive(owner)


def atomic_write_text(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically (temp file in same dir + os.replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp')
    try:
        with open(tmp, 'w', encoding='utf-8', newline='') as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(OSError):
            if tmp.exists():
                tmp.unlink()


def load_state(project_dir: Path, state_file: str = '.claude/watch/state/monitor.json') -> dict:
    path = project_dir / state_file
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(project_dir: Path, state: dict,
               state_file: str = '.claude/watch/state/monitor.json') -> None:
    path = project_dir / state_file
    with file_lock(path):
        atomic_write_text(path, json.dumps(state, ensure_ascii=False) + '\n')


def track_anomaly(state: dict, anomaly_type: str) -> int:
    """Increment consecutive count for an anomaly type. Returns new count."""
    key = f'consecutive_{anomaly_type}'
    count = state.get(key, 0) + 1
    state[key] = count
    return count


def reset_anomaly(state: dict, anomaly_type: str) -> None:
    state.pop(f'consecutive_{anomaly_type}', None)


def record_last_healthy(state: dict, timestamp: str) -> None:
    """Record timestamp of last healthy check."""
    state['last_healthy'] = timestamp


def record_remedy_attempt(state: dict, anomaly_type: str, action: str,
                          result: str, attempts: int) -> None:
    """Append a remedy attempt to the state's remedy log (last 20)."""
    entry = {
        'anomaly': anomaly_type,
        'action': action,
        'result': result,
        'attempts': attempts,
    }
    remedies = state.setdefault('_remedies', [])
    remedies.append(entry)
    if len(remedies) > 20:
        state['_remedies'] = remedies[-20:]


def set_alert_sent(state: dict, timestamp: str) -> None:
    """Mark that an alert was sent at the given timestamp."""
    state['_alert_sent'] = timestamp
