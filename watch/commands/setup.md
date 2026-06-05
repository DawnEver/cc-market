---
name: setup
description: "Scaffold a .claude/watch.yaml config file with annotated defaults for this project"
argument-hint: "[--template http|process|full]"
---

# /watch:setup — Generate watch config for this project

Scaffold a `.claude/watch.yaml` in `${CLAUDE_PROJECT_DIR}/.claude/` with all fields documented as comments.

## Execution

1. Check if `.claude/watch.yaml` already exists → ask before overwriting.
2. Determine template based on `--template` arg or auto-detect:
   - **http**: HTTP server monitoring (endpoints + thresholds). Default for projects with a web server.
   - **process**: Long-running process monitoring (processes + probes + delta).
   - **full**: All sections enabled, everything commented.
3. Write the config file with the project name from git or directory name as `instance.name`.
4. Print next steps: "Edit .claude/watch.yaml, then run /watch:check to test."

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

remedies:
  high_cpu:       [{action: restart}]
  high_memory:    [{action: restart}]
  high_error_rate: [{action: restart}]
  slow_response:  [{action: restart}]
  unreachable:    [{action: restart, max_attempts: 3}]

# alerts:
#   email:
#     enabled: false
#     to: "admin@example.com"

# version_tracking:
#   enabled: true
#   known_good_file: ".claude/known-good-versions.json"
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
