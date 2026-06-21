# watch — Unattended Operations Supervisor

A Claude Code plugin for zero-touch server and long-running task supervision.

## Quick Start

```bash
# 1. Install plugin
/plugin install watch@cc-market

# 2. Python environment is auto-managed — first run creates:
#    ~/.local/share/claude/watch/venv/   (uv venv)

# 3. Scaffold config in your project
/watch:setup

# 4. Edit .claude/watch/config.yaml

# 5. /watch:setup already started the daemon. Verify:
python ${CLAUDE_PLUGIN_ROOT}/scripts/daemon/daemon.py --project-dir . --once

# 6. Start the AI supervision loop (full check + auto-repair, every 12h)
/loop 12h /watch:watch

# Or one-shot check
/watch:check
```

## Architecture

```
scripts/daemon/daemon.py (lightweight Python daemon, runs 24/7)
  │  Every 5 min: git fetch + health ping
  │  Only wakes AI on anomaly or new commits
  │
  ▼
/watch:watch (Claude Code AI loop, 12h or on-demand)
  │  Full component check + anomaly detection
  │  Remedies: restart, rollback, worktree deploy
  │  Alert escalation: email/webhook
```

**Why two layers?** Frequent polling with AI would be expensive. `watchd` is a lightweight Python daemon that burns zero AI tokens — it only triggers `/watch:watch` when something actually needs attention.

**Language**: All Python except `hooks/alert-hook.js` (must be a standalone executable for Claude Code hook system).

## Config Schema (`.claude/watch/config.yaml`)

**Merge priority:** `env vars` > `config.local.yaml` > `config.yaml` > `defaults`.

- `config.yaml` — structural config, safe to commit (instance, endpoints, thresholds, remedies).
- `config.local.yaml` — sensitive overrides, **gitignored** (email `from`/`to`, SMTP credentials, webhook URLs). Optional — only create it if you have secrets.
- `WATCH_*` env vars — highest priority, good for CI/CD injection.

Example `config.local.yaml` for email alerts:

```yaml
alerts:
  email:
    from: "My App<no-reply@my-domain.com>"
    to: "admin@example.com"
  webhook:
    url: "https://hooks.slack.com/T.../B.../..."
```

Values from `config.local.yaml` are deep-merged on top of `config.yaml` — you only need to write the fields you're overriding.

### Minimal HTTP server config

```yaml
instance:
  name: "my-server"

endpoints:
  - name: backend
    url: "http://127.0.0.1:8000"
    health_path: "/health/"
    version_path: "/version/"

thresholds:
  - name: cpu
    source: endpoint.backend.$.system.cpu_percent
    critical: 95
  - name: ram
    source: endpoint.backend.$.system.ram_percent
    critical: 95

actions:
  restart:
    kill: "pkill -f uvicorn"
    start: "python -m my_server"
    wait: 3

remedies:
  high_cpu:    [{action: restart}]
  high_memory: [{action: restart}]
  unreachable: [{action: restart, max_attempts: 3}]
```

### Process monitoring config

```yaml
instance:
  name: "fea-runner"

processes:
  - name: workers
    match: "python.*workflow"
    min_count: 1
    max_rss_mb: 40000

probes:
  - name: output_lines
    command: "wc -l < output/results.jsonl"
    check: delta
    stale_rounds: 6

thresholds:
  - name: ram
    source: process.workers.rss_mb
    critical: 40000
  - name: stall
    source: probe.output_lines
    critical: 0

actions:
  kill_workers:
    command: "pkill -f workflow"

remedies:
  high_ram: [{action: kill_workers}, {action: restart}]
  stall:    [{action: kill_workers}, {action: restart}]
```

## Full Schema Reference

See `/watch:setup` for an annotated template with all fields.

### Top-level fields

| Field | Required | Description |
|-------|----------|-------------|
| `instance.name` | yes | Used in alerts, logs |
| `instance.check_interval_normal` | no | Seconds (default: 43200 = 12h) |
| `instance.check_interval_anomaly` | no | Seconds (default: 1800 = 30m) |
| `endpoints` | no | HTTP health check targets |
| `processes` | no | Process monitoring targets |
| `probes` | no | Shell command probes |
| `thresholds` | yes | Metric → threshold map |
| `actions` | no | Restart/rollback/custom |
| `remedies` | yes | Anomaly type → action chain |
| `alerts` | no | Email + webhook config |
| `version_tracking` | no | known-good commit management |
| `logging` | no | Log file path + rotation |

### Threshold source syntax

```
endpoint.<name>.$.<jsonpath>   — value from HTTP health JSON
process.<name>.<field>         — rss_mb, cpu_pct, count
probe.<name>                   — parsed probe output
```

### Actions

Built-in: `restart`, `rollback`, `check_commits`, `log`.

Custom actions live under `actions:` and take one of these forms:

```yaml
actions:
  # 1. Shell form — run/kill arbitrary commands yourself.
  restart:
    kill: "pkill -f uvicorn"          # str or list
    start: "python -m my_server"      # str or list
    wait: 3

  # 2. Managed-service form — the executor resolves the bundled, cross-platform
  #    kill-server.py / start-server.py itself; no inline plugin-path glob, no
  #    OS-specific kill/spawn. start_dir / start_log are relative to project-dir.
  restart_backend:
    kill_port: 8000                   # int | str | list — port(s) to free
    kill_pattern: "uvicorn"           # optional process-name pattern
    setup_cmd: "yarn install"         # optional one-shot init, run once per
                                      # start_dir before the first start_cmd
                                      # (e.g. install deps in a fresh worktree)
    start_cmd: "python -m my_server --port 8000"  # spawned detached
    start_dir: "../deploy"            # cwd (default: project dir)
    start_dir_env: "WATCH_STAGING"    # optional — env var naming an absolute
                                      # cwd; overrides start_dir when set (e.g.
                                      # a deploy gate exports a dynamic staging
                                      # path). Falls back to start_dir if unset.
    start_log: ".claude/watch/logs/backend.log"
    verify_port: 8000                 # after start, confirm the process is
                                      # actually LISTENing here — catches a
                                      # start_cmd that bound the wrong port
    verify_timeout: 10                # seconds to wait for verify_port
    wait: 3

  # 3. Composition form — run other named actions in order (no duplicated commands).
  restart_all:
    steps: ["restart_backend", "restart_frontend"]
```

### Remedies

```yaml
remedies:
  <anomaly_type>:
    - action: <action_name>
      on: critical | warning | always   # default: always
      if: "<expression>"                 # optional condition
      max_attempts: 3                    # optional
      escalate_after: 3                  # consecutive rounds before alerting
```

## Environment Variables

All config values can be overridden with `WATCH_<PATH>` env vars:
- `WATCH_ENDPOINTS_BACKEND_URL`
- `WATCH_THRESHOLDS_CPU_CRITICAL`
- `WATCH_ALERTS_EMAIL_TO`
- etc.

## Alerts

Two email methods: `resend` (Resend API) or `smtp` (default).

### Resend API (recommended)

Set `RESEND_API_KEY` environment variable, configure `method: "resend"`:

```yaml
alerts:
  email:
    enabled: true
    method: "resend"
    from: "Your Name<no-reply@your-domain.com>"
    to: "admin@example.com"
    subject_prefix: "[my-project]"
    cooldown_minutes: 10
```

Requires: domain verified in Resend dashboard + valid API key.

### SMTP

```yaml
alerts:
  # Stop re-sending an escalated alert once this many *identical* ones have fired
  # in a row (same anomaly type + signature — e.g. the same unchanged dirty commit).
  # Suppression releases when the signature changes or the anomaly clears. 0 = off.
  suppress_after_n_identical: 3

  email:
    enabled: true
    host: localhost
    port: 25
    to: admin@example.com
    from: watch@localhost
    subject_prefix: "[my-project]"
    cooldown_minutes: 10

  webhook:
    enabled: false
    url: "https://hooks.slack.com/..."
    cooldown_minutes: 5
```

The plugin also registers a Claude Code hook that emails on `Notification` events (usage/quota/error) and on `Stop` events (consecutive failure streaks ≥ 3).

> **On Codex:** install with `codex plugin add watch@cc-market`. Codex has no `Notification`
> hook event, so the alert hook degrades to `Stop`-only there (failure-streak alerts still
> fire; usage/quota/error notifications do not). `/watch:*` are Claude slash-commands; on
> Codex invoke the underlying skill directly (the Python daemon is host-independent either way).
