"""Run state tracking — single-file resume via run_state.json.

Replaces the old pattern of checking 6+ artifact files for resume decisions.
One file, one source of truth for pipeline progress.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def default_state(topic: str = "") -> dict[str, Any]:
    """Return a fresh run_state dict."""
    now = datetime.now(UTC).isoformat()
    return {
        "topic": topic,
        "created_at": now,
        "updated_at": now,
        "steps": {
            "define": {"status": "pending"},
            "search": {"status": "pending"},
            "acquire": {"status": "pending"},
            "ingest": {"status": "pending"},
        },
    }


def _state_path(topic_dir: Path) -> Path:
    return topic_dir / "run_state.json"


def load_state(topic_dir: Path) -> dict[str, Any]:
    """Load run_state.json from a topic directory. Returns default if missing."""
    path = _state_path(topic_dir)
    if not path.exists():
        return default_state(str(topic_dir.name))
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(topic_dir: Path, state: dict[str, Any]) -> Path:
    """Persist run_state.json, auto-stamping updated_at."""
    state["updated_at"] = datetime.now(UTC).isoformat()
    path = _state_path(topic_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def mark_step(
    topic_dir: Path,
    step: str,
    status: str,  # pending | in_progress | done | failed
    **extra: Any,
) -> dict[str, Any]:
    """Update a single step's status and optional extra fields in run_state.json."""
    state = load_state(topic_dir)
    step_entry = state.setdefault("steps", {}).setdefault(step, {})
    step_entry["status"] = status
    step_entry.update(extra)
    save_state(topic_dir, state)
    return state


def resume_hint(topic_dir: Path) -> str:
    """Return the next suggested step based on run_state.json.

    Returns one of: 'define', 'search', 'acquire', 'ingest', 'options', 'fresh'
    """
    state = load_state(topic_dir)
    steps = state.get("steps", {})

    order = ["define", "search", "acquire", "ingest"]
    for step in order:
        s = steps.get(step, {})
        if s.get("status") != "done":
            return step
    return "options"  # all core steps done → options menu


def is_step_done(topic_dir: Path, step: str) -> bool:
    """Check if a specific pipeline step is complete."""
    state = load_state(topic_dir)
    return state.get("steps", {}).get(step, {}).get("status") == "done"
