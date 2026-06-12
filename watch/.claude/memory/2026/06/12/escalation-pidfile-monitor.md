---
name: escalation-pidfile-monitor
description: Three-layer escalation (trigger-watch daemon / Monitor in-session / cron), cross-platform pidfile fix, os.execv Windows gotcha
metadata:
  type: project
---

## Escalation architecture & the os.execv pidfile fix (2026-06-12)

### Three complementary escalation layers
watchd writes `state/trigger.json` when `state['fails'] >= fail_threshold`. Three independent
consumers, layered (not competing — `scripts/watch.py` remedies are idempotent):
1. **trigger-watch.py** — session-independent daemon, default `--interval 15`. Runs
   `scripts/watch.py` directly (deterministic remedies + alert, no LLM). The always-on base.
2. **Monitor + trigger-emit.py** — in-session real-time layer. A live `/watch:watch` session
   arms a persistent `Monitor` whose command is `scripts/trigger-emit.py` (pure stdlib, no
   bootstrap/venv re-exec; prints one `ANOMALY trigger: …` line per `trigger.json` change).
   The session then handles the trigger with full tool access — strictly better than headless
   `claude -p`, which can't answer permission prompts. Wired in `skills/watch/SKILL.md` Step 6
   (+ `Monitor` added to `allowed-tools`); skipped in headless/cron runs.
3. **CronCreate** — durable interval floor (12h, self-refreshing to reset 7-day TTL).

Docs: `skills/watch/reference/trigger-watch.md` ("Three complementary mechanisms").

### Root cause fixed: os.execv invalidates spawn PID on Windows
`bootstrap.ensure()` re-execs into the managed venv via `os.execv`. On **Windows** `os.execv`
is emulated as a CRT `P_OVERLAY` spawn → the launcher becomes a *waiting stub* and the real
worker gets a *fresh* PID. So any PID captured at spawn time (a launcher's `Popen`) is stale
immediately; you see 2 processes (uv-python stub + venv-python worker). watchd was already
immune (daemon.py writes `os.getpid()` to `state/watchd.pid` *after* re-exec); trigger-watch
had NO pidfile and NO single-instance guard.

Fix:
- NEW `core/pidfile.py` — cross-platform single-instance guard: `acquire`/`release`/`read`/
  `terminate`/`pid_alive` (psutil, with ctypes `OpenProcess` / POSIX `os.kill(0)` fallback).
- `watchd/daemon.py` refactored onto it (behavior unchanged).
- `scripts/trigger-watch.py` now `pidfile.acquire(project, 'trigger-watch.pid')` after
  bootstrap + `--force` takeover + single-instance guard (skipped for `--once`/`--dry-run`).
- Tests: `tests/test_pidfile.py` (9), `tests/test_trigger_emit.py` (3). Full suite 124 passing.

Authoritative handle for start/stop tooling is the pidfile (NOT the spawn PID, NOT command-line
matching). Killing the worker also reaps the Windows wait-stub parent (verified 0 orphans).
`trigger-emit.py` deliberately avoids bootstrap (pure stdlib) so a Monitor feed stays one cheap
long-lived process with no re-exec.

### Note
`trigger-watch.jsonl` shows only ONE line — `append_report(..., max_entries=0)` truncates to the
latest entry; a lone "Initial mtime" line means healthy & sleeping, not dead.

Downstream consumer wdg-lab keeps project-specific launch tooling (`start-watch.ps1` /
`stop-watch.ps1`) in its own repo; this entry is the plugin-general knowledge.
