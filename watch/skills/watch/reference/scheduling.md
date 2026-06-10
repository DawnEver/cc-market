# Step 5: Schedule Next Check

After each run, refresh the durable CronCreate to guarantee the next check fires. This self-refreshing pattern resets the 7-day expiry clock every cycle.

## 5a: Determine interval

Read `report.watch.intervals`:
- **Healthy** → `normal_seconds` (default 43200 = 12h)
- **Degraded** → `anomaly_seconds` (default 1800 = 30m)

## 5b: Calculate cron schedule

Convert the interval to a cron expression (local time). Use off-peak minutes to avoid `:00`/`:30` fleet congestion:

- **12h interval**: pick two daily times ~12h apart, e.g. `57 8,20 * * *` (8:57 AM + 8:57 PM)
- **6h interval**: `7 0,6,12,18 * * *`
- **1h interval**: `7 * * * *`
- **30m interval**: `7,37 * * * *`
- **Custom interval**: if the config's `check_interval_normal` doesn't match standard buckets, pick the start hour (e.g. if 4h, use `7 */4 * * *`)

## 5c: Manage CronCreate

1. **CronList** — check for existing durable watch crons (look for prompts containing `/watch:watch` or `watch scheduling`)
2. **CronDelete** — remove any stale watch cron (wrong interval, wrong project)
3. **CronCreate** — create a fresh one:
   - `cron`: the expression from 5b
   - `prompt`: `/watch:watch` (triggers this skill in the project)
   - `recurring`: true
   - `durable`: true (survives session restarts, written to `.claude/scheduled_tasks.json`)

The prompt fires when Claude Code is idle. If Claude Code is not running, the job queues — it fires on next launch if the scheduled time has passed.

## 5d: Fallback — ScheduleWakeup

If CronCreate is unavailable (e.g. running in a forked agent without the tool), fall back to:
- `ScheduleWakeup` with `delaySeconds = normal_seconds` (or `anomaly_seconds`)

This is session-scoped only (dies when session ends) but keeps the check cadence within long-running sessions.
