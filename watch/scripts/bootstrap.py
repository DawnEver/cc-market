#!/usr/bin/env python3
"""Ensure watch plugin has its own uv venv at ~/.local/share/claude/watch/venv/.

All plugin scripts import this first: import bootstrap; bootstrap.ensure()
This guarantees pyyaml/psutil/resend are available in an isolated environment.
"""

from __future__ import annotations
import os, subprocess, sys
from pathlib import Path

WATCH_VENV = Path.home() / '.local' / 'share' / 'claude' / 'watch' / 'venv'
REQUIREMENTS = Path(__file__).resolve().parent.parent / 'requirements.txt'
PLUGIN_ROOT = str(Path(__file__).resolve().parent.parent)


def _venv_python() -> Path:
    name = 'python.exe' if sys.platform == 'win32' else 'python3'
    p = WATCH_VENV / 'bin' / name
    return p if p.exists() else WATCH_VENV / 'bin' / 'python'


def _in_venv() -> bool:
    return os.environ.get('WATCH_VENV') == '1' or 'watch/venv' in sys.executable


def ensure() -> None:
    """Create venv if missing, install deps, re-exec into it."""
    if _in_venv():
        if PLUGIN_ROOT not in sys.path:
            sys.path.insert(0, PLUGIN_ROOT)
        return

    py = _venv_python()
    if not py.exists():
        print(f'[watch] Creating venv: {WATCH_VENV}')
        WATCH_VENV.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['uv', 'venv', str(WATCH_VENV), '--python', '3.12'], check=False)
        if REQUIREMENTS.exists():
            print(f'[watch] Installing dependencies...')
            subprocess.run(['uv', 'pip', 'install', '-r', str(REQUIREMENTS)], check=False,
                           env={**os.environ, 'VIRTUAL_ENV': str(WATCH_VENV),
                                'PATH': f'{WATCH_VENV}/bin:{os.environ["PATH"]}'})

    # Re-exec into venv
    os.environ['WATCH_VENV'] = '1'
    os.execv(str(py), [str(py)] + sys.argv)


if __name__ == '__main__':
    ensure()
