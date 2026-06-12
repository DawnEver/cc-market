---
name: setup
description: "Scaffold a .claude/watch/config.yaml config file with annotated defaults for this project"
argument-hint: "[--template http|process|full]"
---

# /watch:setup — Generate watch config for this project

Scaffold a `.claude/watch/config.yaml` in `${CLAUDE_PROJECT_DIR}/.claude/` with all fields documented as comments.

## Execution

1. Check if `.claude/watch/config.yaml` already exists → ask before overwriting.
2. Determine template based on `--template` arg or auto-detect:
   - **http**: HTTP server monitoring (endpoints + thresholds). Default for projects with a web server.
   - **process**: Long-running process monitoring (processes + probes + delta).
   - **full**: All sections enabled, everything commented.
3. Write the config file with the project name from git or directory name as `instance.name`.
   When scaffolding the `actions:` section, use one of the three documented forms (see
   README "Actions"): **shell** (`kill`/`start`/`wait`), **managed-service**
   (`kill_port`/`kill_pattern`/`start_cmd`/`start_dir`/`start_log`/`wait`), or
   **composition** (`steps: [...]`). Named actions are run by the supervision loop and can
   also be invoked directly with
   `python ${CLAUDE_PLUGIN_ROOT}/scripts/cli/watch.py --action <name> --project-dir ${CLAUDE_PROJECT_DIR}`.
4. Remind about Python dependencies:
   - `pip install pyyaml` (required)
   - `pip install psutil` (only if using process_monitor component)
   - `pip install resend` (only if using Resend email alerts)
5. **Start the watchd daemon:**
   - Check if watchd is already running by reading `.claude/watch/logs/daemon.jsonl` — if the last entry timestamp is within 600 seconds (2 × 300s default interval), the daemon is alive.
   - If NOT running, spawn it detached:
     ```
     python ${CLAUDE_PLUGIN_ROOT}/scripts/helpers/start-server.py \
       --project-dir ${CLAUDE_PROJECT_DIR} \
       --cmd "python ${CLAUDE_PLUGIN_ROOT}/scripts/daemon/daemon.py --project-dir ${CLAUDE_PROJECT_DIR}"
     ```
   - Wait 2 seconds, then verify `daemon.jsonl` has a new entry with a recent timestamp.
   - Report: "watchd daemon is running (PID from heartbeat)" or "WARNING: watchd failed to start — check Python and venv."
6. **Create the interval cron:**
   - Read the configured `check_interval_normal` from config (default 43200 = 12h).
   - Convert to a cron expression using off-peak minutes:
     - 12h → `57 <hour>,<hour+12> * * *` (pick the current hour and its 12h counterpart, e.g. `57 8,20 * * *` for 8:57 AM/PM)
     - 6h → `7 */6 * * *`
     - 4h → `7 */4 * * *`
     - 1h → `7 * * * *`
   - CronCreate with:
     - `cron`: the expression
     - `prompt`: `/watch:watch`
     - `recurring`: true
     - `durable`: true
   - This creates `.claude/scheduled_tasks.json` — survives restarts. The watch skill refreshes the cron on each run to reset the 7-day TTL.
7. Print next steps: "Watchd is running. Cron scheduled for <interval>. Edit .claude/watch/config.yaml to adjust thresholds, then run /watch:watch to verify."

## Template: http

```yaml
# watch.yaml — Unattended supervision config for <project-name>
# Docs: /watch:check

instance:
  name: "<project-name>"
  check_interval_normal: 43200   # 12 hours
  check_interval_anomaly: 1800   # 30 minutes

# HTTP endpoints to monitor
endpoints:
  - name: backend
    url: "http://127.0.0.1:8000"
    health_path: "/health/"
    version_path: "/version/"
    timeout: 5
    # optional: false               # set true for non-critical endpoints

# Metric thresholds (JSONPath source from health endpoint response)
thresholds:
  - name: cpu
    source: endpoint.backend.$.system.cpu_percent
    warning: 80
    critical: 95
    unit: "%"
  - name: ram
    source: endpoint.backend.$.system.ram_percent
    warning: 80
    critical: 95
    unit: "%"
  - name: error_rate
    source: endpoint.backend.$.requests.error_rate
    critical: 0.20
    unit: "ratio"
  - name: response_time
    source: endpoint.backend.$.requests.avg_response_time_ms
    critical: 5000
    unit: "ms"

actions:
  restart:
    kill: ""                        # e.g. "pkill -f uvicorn"
    start: ""                       # e.g. "python -m my_server"
    wait: 3

components:
  watchd_heartbeat:
    enabled: true
    max_age_seconds: 600

remedies:
  high_cpu:       [{action: restart}]
  high_memory:    [{action: restart}]
  high_error_rate: [{action: restart}]
  slow_response:  [{action: restart}]
  unreachable:    [{action: restart, max_attempts: 3}]

# alerts:
#   email:
#     enabled: false
#     method: "resend"              # "resend" (needs RESEND_API_KEY) or "smtp"
#     from: "Name<no-reply@domain.com>"
#     to: "admin@example.com"
#     subject_prefix: "[my-project]"
#     cooldown_minutes: 10

# version_tracking:
#   enabled: true
#   known_good_file: ".claude/watch/known-good.json"
#   auto_update_after_checks: 2    # consecutive clean checks before trusting version
#   repositories:                   # multi-repo: record version combination
#     - name: "main"
#       path: "."
#       remote: "origin"
#       branch: "main"
#     # - name: "submodule-1"
#     #   path: "lib/submodule-1"
```

## Template: process

Same structure but with `processes` and `probes` sections instead of `endpoints`.
