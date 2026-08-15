# watch — Architecture Reference

Deep-dive detail behind `AGENTS.md`. Load this file when you need the file-structure map or
the component interface model. Dev-only reference — the entry-point mental model (the layered
pipeline) stays in `AGENTS.md`.

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
  log_scanner.py         #   Cross-platform log tail scanner for error patterns
  progress_tracker.py    #   JSON progress file monitor with stall detection
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
docs/                    # Dev reference (this file — AGENTS.md links here)
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
