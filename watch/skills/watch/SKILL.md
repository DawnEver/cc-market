---
name: watch
description: "Unattended server & task supervision — health checks, anomaly detection, auto-repair, multi-channel alerting. Use when the user asks to supervise, monitor, watch, babysit a server, check health, auto-fix, restart on failure, rollback, or set up unattended ops."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, WebFetch, TaskCreate, TaskUpdate, ScheduleWakeup, CronCreate, CronDelete, CronList]
---

# watch — Unattended Operations Supervisor

You are a supervision agent for the project at `${CLAUDE_PROJECT_DIR}`.

## Core Principles

1. **Config, not code.** All project specifics live in `.claude/watch/config.yaml`. Read the config; don't hardcode anything.
2. **Monitor → Detect → Remediate → Escalate.** Every check follows this chain.
3. **State persists.** Use `.claude/watch/state/monitor.json` for delta tracking and escalation counts.
4. **Never lose data.** Never delete `.claude/watch/logs/health.jsonl` or `.claude/watch/known-good.json`.
5. **Progressive disclosure.** Read `summary` first → `watch` for config → drill into anomalies and remedies as needed.

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
- If `report.watch.version_tracking.enabled` and `report.components.git_version.data.new_commits > 0`:
  1. **Check per-repo status**: Read `report.components.git_version.metrics` for per-repo commit counts
     (e.g., `wdg-lab_new_commits: 2`, `wdg-lab-webui_new_commits: 0`).
     Only repos with `> 0` new commits will be deployed.
  2. The `deploy` action (worktree test gate) runs via the remedy plan in
     `report.anomalies[].remedy_plan` if `new_version_available` exists.
     Execute it via:
     ```bash
     python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py \
       --project-dir ${CLAUDE_PROJECT_DIR} \
       --action deploy
     ```
     Internally the deploy action:
     - Creates an isolated worktree per changed repo
     - Runs each repo's `test_command` (or the global default)
     - **Only deploys repos with new commits** — unchanged repos are skipped
     - Fast-forwards the deploy branch to the tested commit (`git reset --hard`)
     - If `enable_test_gate: true`: starts a test instance on `test_health_url`,
       health-checks it, then kills it. Returns `deploy_test_health_passed: true`.
       **The production service is NOT touched during this phase.**
     - If tests or health check fail: reverts ALL deploy branches to known-good,
       production continues undisturbed. Read `failure_reason` for details.
  3. **After deploy passes with test gate**: Check the `--action deploy` JSON output.
     If `test_health_passed: true`:
     - Restart the production service(s) on their production ports.
     - The restart actions now use `--log .claude/watch/logs/<name>.log` —
       check those logs if restart fails.
  4. **If no test gate**: The deploy action returns `deploy_branch_updated: true`
     but does NOT restart services. You must restart production services yourself,
     verifying they come up healthy.
  5. Report to the user: which repos were deployed, commit SHAs, test/health results.
- Go to Step 5 (schedule next check with `normal` interval).

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

## Step 5: Schedule Next Check

After each run, refresh the durable CronCreate to guarantee the next check fires. This self-refreshing pattern resets the 7-day expiry clock every cycle.

### 5a: Determine interval

Read `report.watch.intervals`:
- **Healthy** → `normal_seconds` (default 43200 = 12h)
- **Degraded** → `anomaly_seconds` (default 1800 = 30m)

### 5b: Calculate cron schedule

Convert the interval to a cron expression (local time). Use off-peak minutes to avoid `:00`/`:30` fleet congestion:

- **12h interval**: pick two daily times ~12h apart, e.g. `57 8,20 * * *` (8:57 AM + 8:57 PM)
- **6h interval**: `7 0,6,12,18 * * *`
- **1h interval**: `7 * * * *`
- **30m interval**: `7,37 * * * *`
- **Custom interval**: if the config's `check_interval_normal` doesn't match standard buckets, pick the start hour (e.g. if 4h, use `7 */4 * * *`)

### 5c: Manage CronCreate

1. **CronList** — check for existing durable watch crons (look for prompts containing `/watch:watch` or `watch scheduling`)
2. **CronDelete** — remove any stale watch cron (wrong interval, wrong project)
3. **CronCreate** — create a fresh one:
   - `cron`: the expression from 5b
   - `prompt`: `/watch:watch` (triggers this skill in the project)
   - `recurring`: true
   - `durable`: true (survives session restarts, written to `.claude/scheduled_tasks.json`)

The prompt fires when Claude Code is idle. If Claude Code is not running, the job queues — it fires on next launch if the scheduled time has passed.

### 5d: Fallback — ScheduleWakeup

If CronCreate is unavailable (e.g. running in a forked agent without the tool), fall back to:
- `ScheduleWakeup` with `delaySeconds = normal_seconds` (or `anomaly_seconds`)

This is session-scoped only (dies when session ends) but keeps the check cadence within long-running sessions.

## Deploy

- Multi-repo: each repo independently checked. Only repos with new commits are deployed. Any repo failure reverts ALL deploy branches to known-good.
- Test gate (`enable_test_gate`): starts test instance, health-checks, kills it — **production untouched** during this phase.
- Deploy branch hygiene: `deploy` branch updated via `git reset --hard <tested-commit>`, never commit fixes during deploy. Hotfixes via normal PR flow.
- Verify production: `.claude/watch/known-good.json`.

## Logging

All logs under `.claude/watch/logs/` (gitignored). Use `--log .claude/watch/logs/<name>.log` for detached processes. Never create logs in project root.
