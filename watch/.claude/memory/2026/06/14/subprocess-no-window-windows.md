---
name: subprocess-no-window-windows
description: all watch subprocess calls need CREATE_NO_WINDOW on Windows or they flash console windows
metadata:
  type: project
---

## Problem

On Windows, every `subprocess.run`/`Popen`/`check_output` started without
`creationflags=CREATE_NO_WINDOW` flashes a transient cmd/mingw64 console window
that opens and immediately closes. A cron-triggered `/watch:watch` run fires
several children per poll (git fetch per repo, shell probes, helper scripts), so
each poll flickered 3–5 windows — visible noise even though functionally fine.

## Fix (2026-06-14, watch v1.0.37)

Centralized constant in `components/base.py`:
```python
NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
```
`creationflags=0` is a valid no-op on POSIX, so passing `NO_WINDOW` everywhere
stays cross-platform. Threaded through every subprocess call in the check/remedy
path: `base.run_command`, `git_version.py`, `git_version_deploy.py`,
`actions.py` (helper-script runner), `kill-server.py`, `start-server.py`
(OR'd with `DETACHED_PROCESS`), `trigger-watch.py`, `bootstrap.py`.

`http_health.py` uses urllib (no window) — not affected.

## How to apply

Any NEW subprocess call added to watch MUST pass `creationflags=NO_WINDOW`
(import it from `components.base`, or define the one-liner locally in standalone
helper scripts). See related [[watch-hang-windows]] for other Windows-specific
subprocess gotchas.
