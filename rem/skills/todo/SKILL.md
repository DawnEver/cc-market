---
name: todo
description: List, add, mark, or remove entries in the persisted `/todo` task backlog. Only for explicit operations on that stored list — not for "go do X" requests to act ("去做", "做一下"). Backed by rem/scripts/task-engine.js.
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

### `/todo mark <id> <open|fixed|closed>` — Set a finding's status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" mark SR-20260610-003 fixed
```

- `SR-*` IDs: flips `**Status:**` in `sharp-review.md`. Marking `fixed` also re-derives the
  frontmatter — equivalent to hand-editing + `post-review.js --rescan`.
- `MANUAL-*` IDs: toggles the `- [ ]` / `- [x]` checkbox in `manual.md` (`open` → unchecked,
  `fixed`/`closed` → checked).

Agents should run this immediately after fixing AND verifying a finding (tests pass,
behavior confirmed) — don't leave it for the next review to rediscover.

## Architecture

```
/todo (hosted by rem)
  ├── /todo          → task-engine.js report (scans memory directly)
  ├── /todo add      → task-engine.js add --summary "..." (writes manual.md)
  ├── /todo mark     → task-engine.js mark <id> <open|fixed|closed>
  └── /todo check    → task-engine.js check
```

**Rem** owns the task engine: report, add, check, mark.

**Sharp-review** owns findings: post-review.js writes `sharp-review.md` with rem frontmatter.
