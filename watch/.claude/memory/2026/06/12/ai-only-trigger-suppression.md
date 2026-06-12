---
name: ai-only-trigger-suppression
description: watchd suppresses parked AI-only anomalies (cron_stale/cron_marker_missing) from trigger.json + Monitor so they stop flooding the real-time layers (v1.0.23)
metadata:
  type: project
---

Follow-up to [[escalation-pidfile-monitor]]. The Monitor/trigger layers treated every
anomaly alike and got drowned by `cron_stale`-type anomalies that always exist but have
**no shell remedy**.

## Design
- `core/anomalies.py` (new, pure stdlib — importable from trigger-emit without a venv
  re-exec) = single source of truth: `AI_ONLY_ANOMALY_TYPES = {cron_stale,
  cron_marker_missing}` + `is_ai_only(types)` (true only if non-empty AND every type is
  AI-only; mixed batch → False so a real failure still wakes the deterministic path).
  `trigger-watch.py` imports it instead of its private copy.
- `watchd/daemon.py` `_poll` collects per-poll anomaly types → `trigger.json` now carries
  `anomaly_types` + `ai_only`. When all-AI-only and `watchd.suppress_ai_only_triggers`
  (default true), **no trigger is written** — the live /watch:watch loop handles cron on
  its own cadence.
- `trigger-emit.py` `--ignore-ai-only` flag (payload flag first, else infer from types);
  SKILL.md Step 6 arms the Monitor with it.

## Tests / deploy
136/136 pass (test_anomalies.py new; test_daemon/test_trigger_emit extended). Plugin
commits on main: code + version bump 1.0.22→1.0.23. Runtime is the cache mirror
`~/.claude/plugins/cache/cc-market/watch/<ver>` — was hand-mirrored to 1.0.23 +
installed_plugins.json repointed for wdg-lab. NOTE: 1.0.23 commits are NOT pushed to the
`DawnEver/cc-market` remote yet, so a future `/plugin update` will overwrite the mirror.
