# watch — Plugin Architecture

A generic Claude Code plugin for unattended supervision of servers and long-running tasks.
Single YAML config per project. Pluggable components. Isolated uv venv.

## Layers

```
watchd (Python daemon, runs 24/7)
  │  Every poll: git fetch + health ping + disk + process checks
  │  Zero AI tokens. Only wakes AI on anomaly.
  │  On fail_threshold exceeded → writes trigger.json
  │
  ▼
trigger-watch.py (standalone poller, always-on terminal)
  │  Polls trigger.json every 15s. On change → runs watch.py directly.
  │  No Claude Code dependency. Survives session restarts.
  │
  ▼
/watch:watch (Claude Code AI loop, on-demand or in-session)
  │  Full component check + anomaly detection
  │  Remedies: restart, rollback, worktree deploy
  │  Alert escalation: email/webhook
  │
  ▼
alert-hook.js (Claude Code hook)
  │  Notification + Stop events → fail streak detection → email
```

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File structure** map (every module) → `docs/architecture.md` § File Structure.
- **Component interface** (the `Component` ABC; `CheckResult`/`Anomaly`/`RemedyStep`/
  `Action` model; the daemon reuses `check()` via the same registry) →
  `docs/architecture.md` § Component Interface.
- **Per-project layout** (`watchd:` config schema, the `trigger.json`/`trigger-watch.py`
  escalation mechanism) → `skills/watch/reference/project-layout.md` and
  `skills/watch/reference/trigger-watch.md`.

## Testing

```shell
python -m unittest discover watch/tests/
```

Pre-commit hook runs the Python suite when `watch/` files are staged (skipped if `python`
is absent).

## Standard

- Use `${CLAUDE_PLUGIN_ROOT}` for intra-plugin paths.
- Use `${CLAUDE_PROJECT_DIR}` for project paths.
- All Python except `hooks/alert-hook.js` (Claude Code requires standalone hooks).
- `bootstrap.py` ensures `~/.local/share/claude/watch/venv/` exists at first run.
- Plugin has zero dependency on host project packages.
