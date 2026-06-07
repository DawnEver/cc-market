---
name: new-components-from-supervise
description: Added LogScanner and ProgressTracker components, enhanced ProcessMonitor — extracted from supervise-jmag-task skill
metadata:
  type: project
created: 2026-06-08
accessed: 2026-06-08
tier: short
---

# New components extracted from supervise-jmag-task

## Added
- `LogScanner` — cross-platform log tail scanner (Path.glob + read_text, no shell)
- `ProgressTracker` — JSON progress file monitor with stall detection via state dict

## Enhanced
- `ProcessMonitor` — peak RSS/CPU tracking (state-persisted), system resource snapshot (track_system)

## Config
All three components accept config via the `components:` section in project config.yaml.
`${OUTPUT_DIR}` template resolved from `.claude/watch/active-run.json` at runtime.
