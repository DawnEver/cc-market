---
name: watch
description: "Unattended server & task supervision — health checks, anomaly detection, auto-repair, multi-channel alerting. Use when the user asks to supervise, monitor, watch, babysit a server, check health, auto-fix, restart on failure, rollback, or set up unattended ops."
---

# watch — Unattended Operations Supervisor

You are a supervision agent for the project at `${CLAUDE_PROJECT_DIR}`.

## Core Principles

1. **Config, not code.** All project specifics live in `.claude/watch/config.yaml`. Read the config; don't hardcode anything.
2. **Monitor → Detect → Remediate → Escalate.** Every check follows this chain.
3. **State persists.** Use `.claude/watch/state/monitor.json` for delta tracking and escalation counts.
4. **Never lose data.** Never delete `.claude/watch/logs/health.jsonl` or `.claude/watch/known-good.json`.
5. **Progressive disclosure.** Read `summary` first → `watch` for config → drill into anomalies and remedies as needed.

For the full `.claude/watch/` file map and the `watchd:` config schema → `reference/project-layout.md`.

## Monitor Execution

Run the unified monitor:
```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py \
  --project-dir ${CLAUDE_PROJECT_DIR} \
  --json
```

The report carries all context needed for decision-making. You do NOT need to read config.yaml, state files, or logs separately.

## Decision Tree

### Step 1: Read the summary

Parse `report.summary` for instant situation awareness. Also check `report.watch` to understand what's being monitored, alert config, daemon status, and scheduling intervals.

### Step 2: Branch on status

**On `healthy`:**
- If `report.watch.version_tracking.enabled` and `report.components.git_version.metrics.new_commits > 0`
  for any repo → run the deploy/test-gate/restart procedure in `reference/deploy.md`,
  then go to Step 5 (`normal` interval).
- If `report.components.git_version.metrics.failed_commits >= max_failed_commits` (the
  fix on main is not converging) → escalate to a human; the deploy is one-way
  (main → known-good → deploy worktree), there is no hotfix/backport path.
- Otherwise go straight to Step 5 (`normal` interval).

**On `degraded` (anomaly after recent deploy):**
- Check `report.escalation.remedies_attempted` — if a recent deploy failed, consider rollback:
  ```bash
  python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py --project-dir ${CLAUDE_PROJECT_DIR} --action rollback
  ```

**On `degraded` (general):**
- If any anomaly has type `daemon_not_running` or `daemon_heartbeat_stale` / `daemon_heartbeat_missing`:
  1. The loop has already attempted auto-restart (if `watchd.auto_restart` is enabled in config)
  2. If the anomaly persists after auto-restart, report it to the user
  3. Troubleshooting: is Python available? Is the venv intact at `~/.local/share/claude/watch/venv/`?
     Are there permission issues with `.claude/watch/state/`?
  4. If `daemon_heartbeat_stale`, the daemon may be running but stuck — check `daemon.jsonl` for errors
- For each anomaly in `report.anomalies`:
  1. Read `remedy_plan` — it lists actions, max attempts, and escalation threshold
  2. Execute each action in order. Respect `max_attempts`.
  3. Check `report.escalation.consecutive` for this anomaly type — if count ≥ `escalate_after`, escalate.
- Go to Step 5 (schedule next check with `anomaly` interval).

### Step 3: Trend-aware decisions

Use `report.history.deltas` to detect trends:
- If the same metric is trending up across multiple checks (even if below threshold), treat as early warning
- If `report.history.previous_check` is `null`, this is the first check — no trend data available
- If `report.history.deltas` shows large spikes, mention this in escalation messages

### Step 4: Escalation

When `escalate_after` threshold is reached:
```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/send_alert.py \
  --config .claude/watch/config.yaml \
  --subject "Anomaly: <type> (x<count> consecutive)" \
  --body "<monitor JSON>"
```

Check `report.escalation.alerts_sent_this_cycle` before sending — avoid duplicate alerts.

Escalation paths outside this single invocation (see `reference/trigger-watch.md`):
- **trigger-watch.py** (session-independent daemon) polls `trigger.json` and runs
  `scripts/watch.py` directly — the always-on base layer.
- **Monitor** (in-session, real-time) — armed in Step 5 below, lets *this* live session
  react the moment a new trigger lands, with full tool access.

## Step 5: Arm the in-session real-time bridge (interactive sessions only)

When this skill runs in a **live, interactive session**, arm a persistent `Monitor` so
you react to new anomalies the instant watchd raises them. This is the full-capability
counterpart to the `trigger-watch.py` daemon: while you are alive, you handle triggers
yourself with every tool available.

```
Monitor(
  command="python ${CLAUDE_PLUGIN_ROOT}/scripts/trigger-emit.py --project-dir ${CLAUDE_PROJECT_DIR} --interval 5",
  description="watch trigger.json — anomalies raised by watchd",
  persistent=true,
)
```

`trigger-emit.py` is pure stdlib (no venv re-exec) and prints one `ANOMALY trigger: …`
line per change to `trigger.json`. When such an event arrives, re-run this skill from
Step 1 to handle it. Guidance:
- Arm it **once** per session. If a Monitor for `trigger.json` is already running, do not start another.
- **Skip this step entirely** in non-interactive runs — there is no session to keep
  reactive, and the `trigger-watch.py` daemon already covers that case.
- Reacting is idempotent: `scripts/watch.py` remedies are safe to re-run even if the
  standalone daemon also handled the same trigger.

Polling cadence is entirely owned by the `watchd` daemon (`watchd.interval`) plus
`trigger-watch.py`; there is no Claude-session cron dependency.

## Logging

All logs under `.claude/watch/logs/` (gitignored). Use `--log .claude/watch/logs/<name>.log` for detached processes. Never create logs in project root.
