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

For one-off manual triggers, run `/watch:watch` directly.
