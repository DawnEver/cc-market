# watch — Plugin Architecture

A generic Claude Code plugin for unattended supervision of servers and long-running tasks.

## Modes (config-driven, not code-branched)

All three data sources coexist in one config. Declare what you need:

- `endpoints` — HTTP GET → JSON → JSONPath extraction
- `processes` — built-in psutil (name match, RSS/CPU%/count thresholds)
- `probes` — arbitrary shell commands → parse output (numeric, boolean, delta)

## Scripts

| Script | Role |
|--------|------|
| `watch.py` | Unified CLI: load config, run all checks, output JSON report |
| `config_loader.py` | YAML parse, schema validate, defaults, `WATCH_*` env override |
| `anomaly_engine.py` | Threshold comparison, delta/staleness detection |
| `action_runner.py` | Execute restart/rollback/custom actions from config |
| `send_alert.py` | SMTP email + HTTP webhook dispatch |
| `log_writer.py` | Append structured JSONL log, rotate if needed |

## Skill

`skills/watch/SKILL.md` — decision tree: load config → run monitor → apply remedies → escalate → schedule.

## Hooks

`hooks/hooks.json` — registers `alert-hook.js` on Notification + Stop events. Tracks fail streaks with cooldown.

## Config

Per-project `.claude/watch.yaml` (or `ops-supervisor.yaml` for backward compat). See README for full schema.

## Conventions

- Use `${CLAUDE_PLUGIN_ROOT}` for all intra-plugin paths.
- Use `${CLAUDE_PROJECT_DIR}` for project paths (config, state files, working dir).
- `watch.py` has zero dependency on any project package — works even when project code is broken.
