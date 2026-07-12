---
name: watch
description: "Unattended supervision: health checks, anomaly detection, auto-repair, alerts"
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
python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/watch.py \
  --project-dir ${CLAUDE_PROJECT_DIR} \
  --json
```

The report carries all context needed for decision-making. You do NOT need to read config.yaml, state files, or logs separately.

## Decision Tree

### Step 1: Read the summary

Parse `report.summary` for instant situation awareness. Also check `report.watch` to understand what's being monitored, alert config, daemon status, and scheduling intervals.

### Step 2: Branch on status

**On `healthy` (the common path):**
- Run the **plugin self-update check** (Step 3) — the watch plugin loads from a
  versioned cache dir that the marketplace can bump silently.
- If `report.watch.version_tracking.enabled` and `report.components.git_version.metrics.new_commits > 0`
  for any repo → run the deploy/test-gate/restart procedure in `reference/deploy.md`,
  then go to Step 4 (refresh the adaptive sweep cron).
- If `report.components.git_version.metrics.failed_commits >= max_failed_commits` (the
  fix on main is not converging) → escalate to a human; the deploy is one-way
  (main → known-good → deploy worktree), there is no hotfix/backport path.
- Otherwise go straight to Step 4 (refresh the adaptive sweep cron).

**On any other status** (`complete`, `degraded`, `deploy_worktree_dirty`) → see
`reference/decision-tree.md` for the full anomaly-handling branches, trend-aware
decisions, and escalation procedures, then return here to Step 4.

### Step 3: Plugin self-update check

On a `healthy` sweep, check whether the watch plugin's own versioned cache dir drifted (the
marketplace can bump it out-of-band). No drift → nothing to do (the common case). On drift,
reload the plugin and re-exec watchd against the new version. Full procedure (drift detect →
`/reload-plugins` → detached re-exec → record baseline) → **`reference/plugin-update.md`**.

### Step 4: Refresh the adaptive AI-sweep cron

The periodic Claude wake-up is a **safety net layered on top of** watchd's
event-driven triggers — it backs off the longer things stay healthy and snaps back
to the shortest rung on any anomaly. The cadence is pre-computed for you in
`report.watch.ai_sweep`:

- `next_cron_expr` — the cron expression for the next sweep (already off the `:00`
  minute mark to avoid fleet-wide collisions).
- `next_interval` / `rung` / `healthy_streak` — for human-readable context.

Refresh this skill's own recurring schedule to that cadence:
```
CronDelete(<previous sweep job id, if any>)
CronCreate(cron=<report.watch.ai_sweep.next_cron_expr>, prompt="/watch:watch", durable=true)
```
- The ladder lives in config (`instance.ai_sweep.ladder` / `promote_after`) — never
  hardcode interval numbers here; always read `next_cron_expr` from the report.
- On `complete` (a monitored task finished): **stop** the schedule (`CronDelete`) per
  the `complete` branch in `reference/decision-tree.md` instead of refreshing — there
  is nothing left to sweep.

### Step 5: Arm the in-session real-time bridge (interactive sessions only)

When this skill runs in a **live, interactive session**, arm a persistent `Monitor` so
you react to new anomalies the instant watchd raises them. This is the full-capability
counterpart to the `trigger-watch.py` daemon: while you are alive, you handle triggers
yourself with every tool available.

```
Monitor(
  command="python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/trigger-emit.py --project-dir ${CLAUDE_PROJECT_DIR} --interval 5",
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
- Reacting is idempotent: `scripts/cli/watch.py` remedies are safe to re-run even if the
  standalone daemon also handled the same trigger.

Real-time anomaly response is owned by the `watchd` daemon (`watchd.interval`) plus
`trigger-watch.py` — that path needs no Claude session. The adaptive sweep cron
(Step 4) is a separate, low-frequency safety net that periodically wakes Claude for a
full sanity pass + plugin self-update check, even when no anomaly has fired.

## Logging

All logs under `.claude/watch/logs/` (gitignored). Use `--log .claude/watch/logs/<name>.log` for detached processes. Never create logs in project root.
