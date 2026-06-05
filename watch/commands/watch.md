---
name: watch
description: "Run the supervision loop — health checks, anomaly detection, auto-repair, alerts"
argument-hint: "[--interval-normal 12h] [--config .claude/watch.yaml]"
---

# /watch:watch — Run the supervision loop

Load config from `.claude/watch.yaml`, run the health monitor, apply remedies for any anomalies, and schedule the next check via ScheduleWakeup.

## Execution Steps

### Step 1: Run the monitor

```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py \
  --project-dir ${CLAUDE_PROJECT_DIR} \
  --json
```

Parse the JSON output. Key fields: `status`, `anomalies`, `endpoints`, `processes`, `probes`, `version`.

### Step 2: Decision Tree

**If `status == "healthy"`:**
- Check version_tracking: if known-good commit is older than `auto_update_interval_hours`, update it:
  ```bash
  python ${CLAUDE_PLUGIN_ROOT}/scripts/action_runner.py --action update_known_good \
    --project-dir ${CLAUDE_PROJECT_DIR}
  ```
  (Implement by reading config and calling action_runner's function directly)
- Report: all clear.
- ScheduleWakeup with `delaySeconds = config.instance.check_interval_normal` (default 43200).

**If `status == "degraded"` or `status == "unreachable"`:**

For each anomaly in `report.anomalies`:
  1. Look up `config.remedies[anomaly.type]`. If not found, use `[{action: "log"}]`.
  2. For each remedy step (in order):
     - Skip if `step.on` is set and doesn't match `anomaly.severity`.
     - Skip if `step.if` condition evaluates to false (evaluate with context vars like `$new_commits`).
     - Execute the action:
       ```
       python ${CLAUDE_PLUGIN_ROOT}/scripts/action_runner.py \
         --project-dir ${CLAUDE_PROJECT_DIR} \
         --action <step.action>
       ```
     - If `step.max_attempts` is set and action failed, retry up to that count.
     - If action succeeded, move to next anomaly (remedies for this one are done).
  3. If `step.escalate_after` is set, check `.claude/watch-state.json` for consecutive anomaly count. If threshold reached → send alert.

After all remedies applied: wait 10 seconds, re-run monitor to verify. If still degraded → send alert. ScheduleWakeup with `delaySeconds = config.instance.check_interval_anomaly` (default 1800).

### Step 3: Alert (if needed)

When escalating, send alert:
```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/send_alert.py \
  --config .claude/watch.yaml \
  --subject "Anomaly detected: <type>" \
  --body "$(python ${CLAUDE_PLUGIN_ROOT}/scripts/watch.py --project-dir ${CLAUDE_PROJECT_DIR} --json)"
```

## Context Variables

The action runner maintains a context dict for condition evaluation:
- `$new_commits` — set by `check_commits` action (count of commits since known-good)
- Variables from `reduce_parallelism` etc. are interpolated into command strings

## State File

`.claude/watch-state.json` persists across wakeups:
- `_probe_state` — for delta/staleness detection
- `consecutive_anomalies` — `{anomaly_type: count}` for escalation tracking
