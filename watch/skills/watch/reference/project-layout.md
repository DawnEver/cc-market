# Per-Project Layout (`.claude/watch/`)

```
.claude/watch/
  config.yaml            # Structural config (tracked in git)
  config.local.yaml      # Sensitive overrides: email from/to, webhook URLs (gitignored)
  known-good.json        # Multi-repo version snapshot (tracked in git)
  components/            # Project custom components (tracked in git)
    my_check.py          #   Subclass Component, auto-discovered
  state/                 # Runtime state (gitignored)
    monitor.json         #   AI loop state
    daemon.json          #   Daemon state
    alert.json           #   Hook state
    heartbeat.json       #   Daemon heartbeat timestamp + PID
    trigger_ack.json     #   Trigger consumption acknowledgement
  logs/                  # Runtime logs (gitignored)
    health.jsonl         #   AI loop check history
    daemon.jsonl         #   Daemon poll history
    trigger-watch.jsonl  #   Trigger watch poller log
  trigger.json           #   Escalation trigger (gitignored)
```

**Config merge priority:** env vars > config.local.yaml > config.yaml > defaults.
config.local.yaml is optional — use it for email from/to, SMTP credentials, and webhook URLs
that shouldn't be committed.

## `watchd` config section

(all paths relative to project root):
```yaml
watchd:
  interval: 300            # polling interval in seconds
  fail_threshold: 2        # consecutive fails before waking Claude
  auto_restart: true       # AI loop auto-restarts dead daemon
  log_file: .claude/watch/logs/daemon.jsonl
  state_file: .claude/watch/state/daemon.json
  trigger_file: .claude/watch/trigger.json
  heartbeat_file: .claude/watch/state/heartbeat.json
```
