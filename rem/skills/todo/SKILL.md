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

Report options (work on `report` / `check`):

- `--module <name>` — show only one module's open tasks.
- `--severity` (or `--sort`) — sort each module by severity (HIGH→MEDIUM→LOW).
- `--auto-close-resolved [all]` — flip high-confidence resolved findings (file no longer
  exists) to `fixed`. Add `all` to also close medium-confidence ones (file modified after
  the finding was discovered).

The report groups open tasks by `module` (derived from the finding's file path when no
explicit `**Module:**` line is present), shows a per-scope severity breakdown, truncates long
summaries (use `show` for the full text), and lists copy-paste `mark … fixed` commands for any
likely-resolved findings.

### `/todo show <id>` — Show a finding's full detail

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" show SR-20260610-003
```

### `/todo check` — Quick status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" check
```

### `/todo remove <id>` — Remove a manual task / close an SR finding

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" remove MANUAL-20260620-001
```

Deletes a `MANUAL-*` task line from `manual.md`; for an `SR-*` id it sets the finding's
`**Status:**` to `CLOSED` (findings are append-only, never deleted). Aliases: `rm`, `-r`.

### `/todo mark <id> <open|fixed|closed>` — Set a finding's status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js" mark SR-20260610-003 fixed
```

- `SR-*` IDs: flips `**Status:**` in `sharp-review.md`. Marking `fixed` also re-derives the
  frontmatter — equivalent to hand-editing + `post-review.js --rescan`.
- `MANUAL-*` IDs: toggles the `- [ ]` / `- [x]` checkbox in `manual.md` (`open` → unchecked,
  `fixed`/`closed` → checked).
- Status aliases: `done` and `resolved` both map to `fixed`.

Agents should run this immediately after fixing AND verifying a finding (tests pass,
behavior confirmed) — don't leave it for the next review to rediscover.

## Architecture

```
/todo (hosted by rem)
  ├── /todo          → task-engine.js report (scans memory directly)
  ├── /todo check    → task-engine.js report (alias)
  ├── /todo add      → task-engine.js add --summary "..." (writes manual.md)
  ├── /todo show     → task-engine.js show <id>   (full finding/task detail)
  ├── /todo mark     → task-engine.js mark <id> <open|fixed|closed>
  └── /todo remove   → task-engine.js remove <id> (delete MANUAL / close SR)
```

**Rem** owns the task engine: report, add, check, show, mark, remove.

**Sharp-review** owns findings: it writes the finding file (`.claude/memory/YYYY/MM/DD/sharp-review.md`).
