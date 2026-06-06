# watch — Unattended Operations Supervisor

A Claude Code plugin for zero-touch server and long-running task supervision.

## Quick Start

```bash
# 1. Install plugin
claude plugins install watch

# 2. Python environment is auto-managed — first run creates:
#    ~/.local/share/claude/watch/venv/   (uv venv)

# 3. Scaffold config in your project
/watch:setup

# 4. Edit .claude/watch.yaml

# 5. Start the lightweight daemon (git poll + health ping, every 5 min)
python ${CLAUDE_PLUGIN_ROOT}/watchd/daemon.py --project-dir .

# 6. Start the AI supervision loop (full check + auto-repair, every 12h)
/loop 12h /watch:watch

# Or one-shot check
/watch:check
```

## Architecture

```
watchd.js (lightweight daemon, runs 24/7)
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

## Config Schema (`.claude/watch.yaml`)

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
Custom: defined in `actions.custom[]` with `command` and optional `kill`.

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
