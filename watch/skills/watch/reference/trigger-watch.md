# Escalation: trigger.json / trigger-watch.py

watchd writes `trigger.json` when `state['fails'] >= fail_threshold`.

`scripts/trigger-watch.py` is a standalone Python process that polls `trigger.json`
independently of any Claude Code session:

```bash
# In a separate terminal (survives session restarts):
python ${CLAUDE_PLUGIN_ROOT}/scripts/trigger-watch.py --project-dir .
```

On trigger change it runs `scripts/watch.py` (the full AI check loop) directly — same venv,
no `claude -p` dependency. All context lives in filesystem state (`state/*.json`,
`logs/*.jsonl`) read fresh each run; no conversation history needed. After completion writes
`trigger_ack.json`. Supports `--interval 15` (default), `--once`, and `--dry-run`. Logs to
`.claude/watch/logs/trigger-watch.jsonl`.

## Two complementary mechanisms

- **trigger-watch.py** — daemon-driven, session-independent base layer: watchd writes
  `trigger.json` on anomaly → trigger-watch runs the AI check (`scripts/watch.py`)
  immediately. Always-on, no LLM, survives session death. Single-instance guarded via
  `state/trigger-watch.pid`; supports `--force`.
- **Monitor + trigger-emit.py** — in-session real-time layer: while a live `/watch:watch`
  session is alive, it arms a `Monitor` whose command is `scripts/trigger-emit.py`
  (pure stdlib; prints one line per `trigger.json` change). The session then handles the
  trigger itself with full tool access. Armed in SKILL.md Step 5; skipped in
  non-interactive runs.

These layer rather than compete: trigger-watch covers "no session alive", Monitor upgrades
"session alive" to real-time full-capability handling. The periodic polling floor is the
`watchd` daemon itself (`watchd.interval`). Reacting twice is harmless — `scripts/watch.py`
remedies are idempotent.

### Process-identity note (cross-platform)

`trigger-watch.py` and `watchd/daemon.py` call `bootstrap.ensure()`, which re-execs into the
managed venv via `os.execv`. On **Windows** `os.execv` is emulated as a CRT `P_OVERLAY` spawn:
the launcher becomes a waiting stub and the real worker gets a *fresh* PID. So a PID captured
at spawn time (e.g. from a launcher's `Popen`) is stale immediately. Both daemons therefore
write their own pidfile (`state/watchd.pid`, `state/trigger-watch.pid`) *after* bootstrap via
`core/pidfile.py` — that is the authoritative handle for start/stop tooling. Killing the
worker also reaps the Windows wait-stub parent. `trigger-emit.py` sidesteps this entirely by
not importing bootstrap (pure stdlib, no re-exec).

When `trigger-watch.py` handles a trigger it runs `scripts/watch.py` (the full check loop),
then writes `trigger_ack.json` on success. All remedies are shell-executable (restart,
rollback, deploy) — no LLM involvement is required. For one-off manual triggers, run
`/watch:watch` directly.
