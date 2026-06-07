"""State persistence — probe deltas, escalation counters, known-good versions."""

from __future__ import annotations

import json
from pathlib import Path


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
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False) + '\n', encoding='utf-8')


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
