---
name: watch-hang-windows
description: watch.py --json hangs with no output on Windows — root causes and fixes applied
metadata:
  type: project
---

## Problem

`watch.py --json` produces no output and hangs indefinitely on Windows. Same behavior with system Python or watch venv Python.

## Root Causes

1. **`http_health` — urllib timeout unreliable on Windows**: `urllib.request.urlopen(timeout=N)` socket timeout may not reliably interrupt TCP connection attempts when Windows firewall silently drops SYN packets (no RST). Replaced with `socket.create_connection` + manual HTTP/1.0 GET.

2. **No per-component timeout**: One hanging component's `check()` blocks the entire run loop forever. Fixed by wrapping each `comp.check()` with `ThreadPoolExecutor` + 60s hard timeout.

3. **No intermediate output in `--json` mode**: All print output is buffered; if a component hangs, user sees nothing. Fixed by routing progress messages to stderr with `flush=True`.

## Fixes Applied (2026-06-07)

| File | Change |
|------|--------|
| `components/http_health.py` | Replaced `urllib` with `socket.create_connection` + manual HTTP. Catches `ConnectionRefusedError`, `socket.timeout`, `socket.gaierror` separately. |
| `core/loop.py` | Added `CHECK_TIMEOUT = 60`, `ThreadPoolExecutor` wrapper per component, all progress prints → stderr with flush. |
