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

# Suppress the console window `uv` would otherwise flash on Windows during the
# one-time venv creation. 0 (no-op) on POSIX.
NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0


def _force_utf8_io() -> None:
    """Reconfigure stdio to UTF-8 so report glyphs (✓, —) never raise
    UnicodeEncodeError on Windows consoles, which default to cp1252. Output to a
    pipe/file inherits the same encoding. errors='replace' keeps output flowing
    for any unmappable char; no-op on streams that lack reconfigure()."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError):
            pass


def _venv_python() -> Path:
    name = 'python.exe' if sys.platform == 'win32' else 'python3'
    subdir = 'Scripts' if sys.platform == 'win32' else 'bin'
    p = WATCH_VENV / subdir / name
    return p if p.exists() else WATCH_VENV / subdir / 'python'


def _in_venv() -> bool:
    if os.environ.get('WATCH_VENV') == '1':
        return True
    # Normalize to forward slashes for cross-platform comparison
    return 'watch/venv' in sys.executable.replace('\\', '/')


def ensure() -> None:
    """Create venv if missing, install deps, re-exec into it."""
    _force_utf8_io()
    if _in_venv():
        if PLUGIN_ROOT not in sys.path:
            sys.path.insert(0, PLUGIN_ROOT)
        return

    py = _venv_python()
    if not py.exists():
        print(f'[watch] Creating venv: {WATCH_VENV}')
        WATCH_VENV.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(['uv', 'venv', str(WATCH_VENV), '--python', '3.12'], check=False,
                       creationflags=NO_WINDOW)
        if REQUIREMENTS.exists():
            print(f'[watch] Installing dependencies...')
            subprocess.run(['uv', 'pip', 'install', '-r', str(REQUIREMENTS)], check=False,
                           creationflags=NO_WINDOW,
                           env={**os.environ, 'VIRTUAL_ENV': str(WATCH_VENV),
                                'PATH': f'{WATCH_VENV}/{"Scripts" if sys.platform == "win32" else "bin"}{os.pathsep}{os.environ["PATH"]}'})

    # Re-exec into venv
    os.environ['WATCH_VENV'] = '1'
    os.execv(str(py), [str(py)] + sys.argv)


if __name__ == '__main__':
    ensure()
