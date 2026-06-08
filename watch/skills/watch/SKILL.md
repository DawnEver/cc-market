---
name: watch
description: "Unattended server & task supervision — health checks, anomaly detection, auto-repair, multi-channel alerting. Use when the user asks to supervise, monitor, watch, babysit a server, check health, auto-fix, restart on failure, rollback, or set up unattended ops."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, WebFetch, TaskCreate, TaskUpdate, ScheduleWakeup]
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
- ScheduleWakeup with `delaySeconds` from `report.watch.intervals.normal` (parsed to seconds).

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
- ScheduleWakeup with `delaySeconds` from `report.watch.intervals.anomaly`.

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

## ScheduleWakeup Logic

- Healthy → `report.watch.intervals.normal` (default 12h)
- Degraded → `report.watch.intervals.anomaly` (default 30m)
- After 3+ consecutive degraded checks, keep 30m interval but escalate alerts

## Multi-Repo Deploy Awareness

When the project tracks multiple repositories (check `report.watch.version_tracking.repos`):

1. Each repo is independently checked for new commits. Read `report.components.git_version.metrics`
   for per-repo commit counts (e.g., `wdg-lab_new_commits: 2`, `wdg-lab-webui_new_commits: 0`).
2. The `deploy` action only deploys repos that have new commits. Unchanged repos are skipped.
3. Each changed repo gets its own isolated worktree and runs its own `test_command` (if configured)
   or falls back to the global `deploy.test_command`.
4. If any repo's tests fail, **all** deploy branches are reverted to known-good
   (best-effort rollback — repos are reverted sequentially).
5. Service repos (e.g., a frontend on port 7000) can have their own `test_health_url`
   configured per-repo to verify after deploy.
6. Repos without services (data repos, shared libs) skip the test port gate —
   their deploy is just: worktree → test → fast-forward deploy branch.

## Logging & Temp File Convention

All temporary logs and detached process output go under `.claude/watch/logs/`:

- `daemon.jsonl` — watchd poll history
- `health.jsonl` — AI loop check history
- `backend.log` — backend detached process stdout/stderr
- `frontend.log` — frontend detached process stdout/stderr

When starting detached processes, always use the `--log` flag:
```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/start-server.py \
  --project-dir ${CLAUDE_PROJECT_DIR} \
  --log .claude/watch/logs/backend.log \
  --cmd "uv run python -m wdg_lab"
```

**Never create log files in the project root.** They are git-ignored inside
`.claude/watch/` by default.

## Deploy Branch History Hygiene

The `deploy` branch is the production branch — it must have a clean, linear history:

1. **Never commit fixes during automated deploy.** If tests fail, the deploy is
   aborted and the failure is reported. The deploy branch stays at the last known-good commit.
2. **Hotfixes go through the normal PR workflow**: branch from `main` → fix → PR → merge.
   The next deploy cycle will pick up the fix automatically.
3. **The deploy branch is updated by `git reset --hard <tested-commit>`** —
   a single linear pointer, never a merge, never a fixup commit.
4. **The main service runs from the deploy branch**, not from `main`.
   `main` is for active development; `deploy` is for production.
5. If you need to verify what's running in production, check
   `.claude/watch/known-good.json` for the last deployed commit SHAs.
