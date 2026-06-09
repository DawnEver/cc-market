---
name: todo
description: Manage the project task list — view, add, check, and resolve tasks. Hosted by rem, backed by rem/scripts/task-engine.js.
---

# Tasks

Manage the project task list. Findings live in `.claude/memory/YYYY/MM/DD/sharp-review.md` (sole source of truth). Manual tasks live in `manual.md` alongside. No derived `tasks.md` — the report scans memory directly.

## Usage

### `/todo` — View open tasks (default)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" report
```

### `/todo add <summary>` — Add a manual task

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" add --summary "Fix login timeout" --severity MEDIUM --module auth
```

Options: `--severity` (HIGH|MEDIUM|LOW, default MEDIUM), `--module` (default 'manual').

Generates a `MANUAL-YYYYMMDD-NNN` ID and writes to `.claude/memory/YYYY/MM/DD/manual.md` with rem frontmatter.

### `/todo check` — Quick status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" check
```

### `/todo resolve <SR-ID>` — Resolve a finding

1. Edit `.claude/memory/YYYY/MM/DD/sharp-review.md`: `**Status:** OPEN` → `**Status:** FIXED`
2. Run `post-review.js --rescan --date YYYY-MM-DD` to archive the finding

```bash
node "${CLAUDE_PLUGIN_ROOT}/../sharp-review/scripts/post-review.js" --rescan --date YYYY-MM-DD
```

## Architecture

```
/todo (hosted by rem)
  ├── /todo          → task-engine.js report (scans memory directly)
  ├── /todo add      → task-engine.js add --summary "..." (writes manual.md)
  ├── /todo check    → task-engine.js check
  └── /todo resolve  → edit sharp-review.md → post-review.js --rescan
```

**Rem** owns the task engine: report, add, check.

**Sharp-review** owns findings: post-review.js writes `sharp-review.md` and archives resolved findings to `.claude/tasks/archive/YYYY/MM/DD.md`.
