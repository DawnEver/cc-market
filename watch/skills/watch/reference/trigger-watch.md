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

- **trigger-watch.py** — daemon-driven: watchd writes `trigger.json` on anomaly →
  trigger-watch runs the AI check immediately
- **CronCreate** — interval-driven: durable cron calls `/watch:watch` every 12h
  (configurable), self-refreshes to reset 7-day TTL

## AI-only anomalies and headless escalation

Most anomalies are fixed by shell-executable remedies (restart, rollback, deploy) —
`scripts/watch.py` handles these without any LLM involved. A small set of anomaly
types have **no shell remedy**, because the only fix requires agent-only tools
(CronCreate/CronList): `cron_stale` and `cron_marker_missing`, raised by
`components/cron_freshness.py` (see `scheduling.md` Step 5).

When `trigger-watch.py` handles a trigger:
1. It always runs `scripts/watch.py` first (pure script, as before).
2. If the resulting health report still contains an `AI_ONLY_ANOMALY_TYPES` anomaly
   AND `watchd.enable_headless_ai_escalation: true` is set, it additionally spawns
   `claude -p "/watch:watch"` (`cwd` = project dir) — a real agent session that can
   run CronList/CronCreate and rewrite `state/cron_refresh.json`.
3. If `enable_headless_ai_escalation` is false (default) or the `claude` CLI isn't on
   PATH, this step is skipped — the anomaly still escalates via email/webhook
   (`cron_freshness` remedy `escalate_after: 1`), so a human is notified to run
   `/watch:watch` manually.

For one-off manual triggers, run `/watch:watch` directly.
