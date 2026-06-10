# Step 5: Schedule Next Check

**Run 5a–5e on every single `/watch:watch` invocation, unconditionally** — not just
"when needed". This self-refreshing pattern resets the 7-day expiry clock every cycle.
The `cron_freshness` component (checked by watchd every 5 minutes) reads the marker
written in 5e; if this step is skipped or fails, the marker goes stale and the
anomaly escalates independently of this skill — so treat 5a–5e as mandatory, not
best-effort.

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

## 5d: Verify

**CronList** again — confirm the entry from 5c is now registered (correct prompt and
cron expression). If it's missing, retry 5c once. Only proceed to 5e once verified —
the marker in 5e is the audit trail that this verification passed.

## 5e: Write refresh marker

Write `.claude/watch/state/cron_refresh.json` (only after 5d verification succeeds):

```json
{
  "ts": "<now, ISO 8601 UTC>",
  "interval_seconds": <the interval used in 5a>,
  "cron_expr": "<the expression from 5b>",
  "mode": "normal"
}
```

The `cron_freshness` component compares `ts` + `interval_seconds` against the next
expected refresh, so this file must be rewritten every cycle.

## 5f: Fallback — ScheduleWakeup

If CronCreate is unavailable (e.g. running in a forked agent without the tool), fall back to:
- `ScheduleWakeup` with `delaySeconds = normal_seconds` (or `anomaly_seconds`)

This is session-scoped only (dies when session ends) but keeps the check cadence
within long-running sessions. Still write the marker from 5e, but with
`"mode": "fallback"` — `cron_freshness` applies a tighter staleness threshold for
fallback markers since they don't survive a restart.
