# watch — Decision Tree: Anomaly & Edge-Case Branches

Read this when the monitor report status is anything other than `healthy`.
For the healthy path → back to `SKILL.md` Step 2.

## Status Branches (from Step 2)

### On `complete`

A monitored task finished successfully (`report.completions` lists them;
`report.summary` starts with `COMPLETE`). Terminal success — do NOT remediate
or escalate.

- Report completion to the user.
- **Stop the recurring schedule**: delete the durable cron (`CronDelete`) rather than
  refreshing it per Step 4 (Refresh the adaptive AI-sweep cron).
- Optionally clear/rename `.claude/watch/active-run.json` so later manual checks are quiet.

### On `degraded` (after recent deploy)

Check `report.escalation.remedies_attempted` — if a recent deploy failed, consider rollback:
```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/watch.py --project-dir ${CLAUDE_PROJECT_DIR} --action rollback
```

### On `deploy_worktree_dirty`

The deploy worktree must be read-only (watchd resets it to known-good; nobody edits
it by hand). The anomaly message names which repo and why — uncommitted changes or
commit(s) made directly on the deploy branch.

- Do NOT auto-`reset --hard` it: that silently destroys the work. Tell the user, and
  if the change is wanted, port it to `main` (the source of truth) so the next deploy
  carries it. The next deploy/rollback will overwrite the worktree regardless.

### On `degraded` (general)

**Daemon anomalies** (type `daemon_not_running`, `daemon_heartbeat_stale`, or `daemon_heartbeat_missing`):

1. The loop has already attempted auto-restart (if `watchd.auto_restart` is enabled in config).
2. If the anomaly persists after auto-restart, report it to the user.
3. Troubleshooting: is Python available? Is the venv intact at `~/.local/share/claude/watch/venv/`?
   Are there permission issues with `.claude/watch/state/`?
4. If `daemon_heartbeat_stale`, the daemon may be running but stuck — check `daemon.jsonl` for errors.

**General anomaly loop** (for each anomaly in `report.anomalies`):

1. Read `remedy_plan` — it lists actions, max attempts, and escalation threshold.
2. Execute each action in order. Respect `max_attempts`.
3. Check `report.escalation.consecutive` for this anomaly type — if count >= `escalate_after`, escalate.
4. Go to Step 4 (Refresh the adaptive AI-sweep cron). Any anomaly resets `_healthy_streak` to 0,
   so the sweep cron snaps back to the shortest rung (`report.watch.ai_sweep.next_cron_expr`)
   automatically.

## Trend-Aware Decisions (Step 3)

Use `report.history.deltas` to detect trends:

- If the same metric is trending up across multiple checks (even if below threshold), treat as early warning.
- If `report.history.previous_check` is `null`, this is the first check — no trend data available.
- If `report.history.deltas` shows large spikes, mention this in escalation messages.

## Escalation (Step 4)

When `escalate_after` threshold is reached:
```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/send_alert.py \
  --config .claude/watch/config.yaml \
  --subject "Anomaly: <type> (x<count> consecutive)" \
  --body "<monitor JSON>"
```

Check `report.escalation.alerts_sent_this_cycle` before sending — avoid duplicate alerts.

Escalation paths outside this single invocation (see `reference/trigger-watch.md`):

- **trigger-watch.py** (session-independent daemon) polls `trigger.json` and runs
  `scripts/cli/watch.py` directly — the always-on base layer.
- **Monitor** (in-session, real-time) — armed in SKILL.md Step 5, lets *this* live session
  react the moment a new trigger lands, with full tool access.
