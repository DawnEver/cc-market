---
name: check
description: "One-shot health check — runs the monitor and prints a report, no loop, no auto-repair"
argument-hint: "[--config .claude/watch/config.yaml]"
---

# /watch:check — One-shot health check

Run the monitor once and display results. No scheduling, no auto-repair.

## Execution

```bash
python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/watch.py \
  --project-dir ${CLAUDE_PROJECT_DIR} \
  --json
```

Parse the JSON output and display a human-readable summary:

1. Status (healthy/degraded/unreachable) with icon.
2. Each endpoint: reachable/unreachable, HTTP status.
3. Each process: count, RSS, CPU%.
4. Each probe: value.
5. Anomalies: type, severity, message.
6. Version info if available.

If `status != "healthy"`, list the applicable remedies from config (read `remedies` section) so the user knows what `/watch:watch` would do.
