"""Checker discovery — built-in + project custom."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

_CHECKERS_DIR = Path(__file__).resolve().parent


def load(names: list[str], project_dir: str | Path) -> list[Any]:
    """Load checkers by name. Tries built-in first, then project custom."""
    project = Path(project_dir)
    checkers = []

    for name in names:
        name = name.strip()
        if not name:
            continue

        # Built-in
        builtin = _CHECKERS_DIR / f'{name}.py'
        if builtin.exists():
            mod = _load_module(f'watchd_{name}', builtin)
            if mod:
                checkers.append(mod)
                continue

        # Project custom: .claude/watchd-checkers/<name>.py
        custom = project / '.claude' / 'watchd-checkers' / f'{name}.py'
        if custom.exists():
            mod = _load_module(f'watchd_custom_{name}', custom)
            if mod:
                checkers.append(mod)
                continue

        print(f'[watchd] Checker "{name}" not found')

    return checkers


def _ensure_parent_packages() -> None:
    """Ensure watchd and watchd.checkers are registered so relative imports work."""
    for pkg_name in ('watchd', 'watchd.checkers'):
        if pkg_name not in sys.modules:
            m = type(sys)('placeholder')
            m.__package__ = pkg_name
            m.__path__ = [str(_CHECKERS_DIR.parent if pkg_name == 'watchd' else _CHECKERS_DIR)]
            sys.modules[pkg_name] = m


def _load_module(name: str, path: Path) -> Any | None:
    try:
        _ensure_parent_packages()
        spec = importlib.util.spec_from_file_location(f'watchd.checkers.{name}', str(path))
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = 'watchd.checkers'
        sys.modules[f'watchd.checkers.{name}'] = mod
        spec.loader.exec_module(mod)
        return mod
    except Exception as e:
        print(f'[watchd] Failed to load {path}: {e}')
        return None
