---
name: todo
description: Manage the project task list — view, sync, and resolve tasks. Hosted by rem, backed by rem/scripts/task-engine.js.
---

# Tasks

Manage the project task list. The task engine is owned by `rem` — a generic engine that generates `tasks.md`, archives resolved tasks, and updates `MEMORY.md`. Sharp-review writes findings as a single memory entry via `post-review.js`.

## Usage

### `/todo` — View summary

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" --report
```

### `/todo add <summary>` — Add a manual task

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" --add --summary "Fix login timeout" --severity MEDIUM --module auth
```

Options: `--severity` (HIGH|MEDIUM|LOW, default MEDIUM), `--module` (default 'manual'), `--category` (Bug|Feature|Performance, default Bug).

Generates a `MANUAL-YYYYMMDD-NNN` ID and appends to tasks.md. Manual tasks are preserved across syncs.

### `/todo sync` — Full sync from review file

Reads `.claude/memory/YYYY/MM/DD/sharp-review.md`, regenerates tasks.md:

```bash
node "${CLAUDE_PLUGIN_ROOT}/../sharp-review/scripts/post-review.js" --date YYYY-MM-DD --findings <json> --markdown <md>
```

### `/todo resolve <id...>` — Resolve tasks

Edit the memory file directly: change `**Status:** OPEN` → `**Status:** FIXED`. Then re-run `/todo sync` to update tasks.md.

### `/todo check` — Check if up to date

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" --check
```

## Architecture

```
/todo (hosted by rem)
  ├── /todo          → rem/scripts/task-engine.js --report
  ├── /todo add      → rem/scripts/task-engine.js --add --summary "..." --severity ... --module ...
  ├── /todo sync     → sharp-review/scripts/post-review.js        (writes memory entry → task-engine)
  ├── /todo resolve  → edit .claude/memory/YYYY/MM/DD/sharp-review.md in-place
  └── /todo check    → rem/scripts/task-engine.js --check
```

**Rem** owns the generic task engine: `tasks.md` generation, archive, `MEMORY.md` update, check/report.

**Sharp-review** owns the finding pipeline: post-review.js writes a single memory entry per session, cross-links SR-IDs, stamps. Delegates to rem for final output.
