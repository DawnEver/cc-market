---
name: tasks
description: Manage the project task list — view, sync, and resolve findings tracked by rem
---

# Tasks

Manage the project task list backed by rem's task engine. Findings originate from `/sharp-review` and are tracked in `.claude/memory/tasks/tasks.md`.

## Usage

### `/tasks` — View summary

Show current open tasks:

```bash
node cc-market/rem/scripts/sync-tasks.js --report
```

### `/tasks sync` — Full sync

Sync tasks from sharp-review findings. This parses all `.claude/sharp-review/YYYY-MM-DD.md` files, cross-references with memory, and rebuilds the task list.

```bash
node cc-market/sharp-review/scripts/sync-tasks.js
```

### `/tasks resolve <SR-ID...>` — Resolve findings

Mark one or more findings as resolved. The IDs are persisted and applied on the next sync.

```bash
node cc-market/rem/scripts/sync-tasks.js --resolve SR-YYYYMMDD-NNN ...
```

### `/tasks check` — Check if up to date

```bash
node cc-market/rem/scripts/sync-tasks.js --check
```

## Architecture

```
/tasks (this skill)
  ├── /tasks report    → rem/scripts/sync-tasks.js --report
  ├── /tasks sync      → sharp-review/scripts/sync-tasks.js (parse → rem engine)
  ├── /tasks resolve   → rem/scripts/sync-tasks.js --resolve
  └── /tasks check     → rem/scripts/sync-tasks.js --check
```

Task management is owned by `rem`. Sharp-review's `sync-tasks.js` is a thin wrapper that parses its own review files, then delegates to rem's engine.
