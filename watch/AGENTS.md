# watch — Plugin Architecture

A generic Claude Code plugin for unattended supervision of servers and long-running tasks.
Single YAML config per project. Pluggable components. Isolated uv venv.

## Layers

```
watchd (Python daemon, runs 24/7)
  │  Every 5 min: git fetch + health ping + disk + process
  │  Zero AI tokens. Only wakes AI on anomaly.
  │
  ▼
/watch:watch (Claude Code AI loop, 12h or on-demand)
  │  Full component check + anomaly detection
  │  Remedies: restart, rollback, worktree deploy
  │  Alert escalation: email/webhook
  │
  ▼
alert-hook.js (Claude Code hook)
  │  Notification + Stop events → fail streak detection → email
```

## File Structure

```
core/                    # Engine
  config.py               #   Config loader, defaults, deep merge, env override
  state.py                #   State persistence, anomaly tracking
  alert.py                #   Email (SMTP + Resend) and webhook dispatch
  log.py                  #   JSONL structured logging, ring-buffer rotation
  loop.py                 #   Main supervision loop — check, remedy, escalate
  actions.py              #   Action executor, condition evaluator, serializer
  report.py               #   Report enrichment, summary, history, escalation
  daemon_helpers.py       #   Daemon liveness check, auto-restart, escalation
components/              # Pluggable health checks — flat Python modules
  base.py                #   Component, CheckResult, Anomaly, RemedyStep, Action
  registry.py            #   Discovery: built-in + YAML + project custom
  http_health.py         #   HTTP endpoint check
  process_monitor.py     #   Process check (psutil)
  shell_probe.py         #   Shell command probe
  git_version.py         #   Multi-repo version tracking + worktree deploy
  disk_usage.py          #   Disk usage check
  watchd_heartbeat.py    #   Daemon heartbeat freshness check
watchd/
  daemon.py              # Config-driven poller (reuses Component.check() directly)
scripts/                 # CLI entry points
  watch.py               #   One-shot /watch:check
  send_alert.py          #   Email dispatch
  bootstrap.py           #   uv venv lifecycle
hooks/                   # Claude Code hooks (JS required by CC)
  hooks.json             #   Event registration
  alert-hook.js          #   Stop + Notification handler
skills/watch/SKILL.md    # AI decision tree
```

## Project Layout (per-project `.claude/watch/`)

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
  logs/                  # Runtime logs (gitignored)
    health.jsonl         #   AI loop check history
    daemon.jsonl         #   Daemon poll history
  trigger.json           #   Escalation trigger (gitignored)
```

**Config merge priority:** env vars > config.local.yaml > config.yaml > defaults.
config.local.yaml is optional — use it for email from/to, SMTP credentials, and webhook URLs that shouldn't be committed.

**`watchd` config section** (all paths relative to project root):
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

## Component Interface

```python
class Component(ABC):
    name: str
    description: str

    def check(self, comp_cfg, global_cfg, state) -> CheckResult:
        """Run health check. Returns metrics + anomalies."""

    def remedies(self) -> dict[str, list[RemedyStep]]:
        """anomaly_type → ordered remedy chain."""

    def actions(self) -> dict[str, Action]:
        """Actions this component provides."""
```

The daemon reuses `check()` directly via the same registry — no duplicate check logic.

## Conventions

- Use `${CLAUDE_PLUGIN_ROOT}` for intra-plugin paths.
- Use `${CLAUDE_PROJECT_DIR}` for project paths.
- All Python except `hooks/alert-hook.js` (Claude Code requires standalone hooks).
- `bootstrap.py` ensures `~/.local/share/claude/watch/venv/` exists at first run.
- Plugin has zero dependency on host project packages.
