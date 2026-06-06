"""State persistence — consecutive failures, escalation tracking."""

from __future__ import annotations

import json
from pathlib import Path


def load(project_dir: str | Path) -> dict:
    file = Path(project_dir) / '.claude' / 'watchd-state.json'
    if file.exists():
        try:
            return json.loads(file.read_text(encoding='utf-8'))
        except (json.JSONDecodeError, OSError):
            pass
    return {'last_ok': None, 'fails': 0, 'checkers': {}}


def save(project_dir: str | Path, state: dict) -> None:
    file = Path(project_dir) / '.claude' / 'watchd-state.json'
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps(state, ensure_ascii=False) + '\n', encoding='utf-8')


def track_fail(state: dict, checker: str) -> None:
    state['fails'] = state.get('fails', 0) + 1
    state.setdefault('checkers', {}).setdefault(checker, {'fails': 0})
    state['checkers'][checker]['fails'] += 1


def track_ok(state: dict) -> None:
    from datetime import datetime, timezone
    state['fails'] = 0
    state['last_ok'] = datetime.now(timezone.utc).isoformat()


def should_escalate(state: dict, threshold: int = 2) -> bool:
    return state.get('fails', 0) >= threshold
