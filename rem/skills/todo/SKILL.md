---
name: todo
description: View and manage the one backlog — task open items, the repo backlog (issue tracker or .claude/todo/ files), stale docs. Backed by rem/scripts/todo.js.
---

# Todo — one backlog, no second store

| What | Where it lives | Closed by |
|---|---|---|
| A task's open item | a line `O<n> open:` in `.claude/tasks/<slug>/JOURNAL.md` | a later `O<n> closed:` line (`task.js close-item`) |
| A repo backlog item, repo with a tracker | an ISSUE; `.claude/rem.json` says `{"backlog": "issues"}` | closing the issue |
| A repo backlog item, no tracker | one file `.claude/todo/<id>.md` (status in frontmatter) | `todo.js close`, which archives it into memory |
| A stale bound doc | virtual `DOC-<path>` row (git drift) | `/refresh-docs` |

Nothing writes a checkbox, and nothing writes into `.claude/memory/` except the archive move.

## `/todo` — the report (read-only)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/todo.js" [--module <name>] [--severity]
```

Lists the open items of every open task, then the backlog (or a pointer to the issue tracker),
then stale docs. `--severity` sorts each module HIGH→LOW. It writes nothing.

## `/todo add <summary>` — a new item (no tracker)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/todo.js" add "Fix login timeout" --severity HIGH --module auth [--file src/auth.js]
```

Writes ONE new file `.claude/todo/T<yyyymmdd>-<hex>.md` (unique name — concurrent adds never
collide). With `backlog: issues` it is refused: file an issue instead. A task's own open item is
`task.js open-item "<text>"`, not a todo.

## `/todo show <id>` · `/todo close <id> ["<how>"]`

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/todo.js" show T20261031-a1b2c3
node "${CLAUDE_PLUGIN_ROOT}/scripts/todo.js" close T20261031-a1b2c3 "fixed in abc123"
```

`close` records how, sets `status: closed`, and writes the whole closed item to
`.claude/memory/<date>/todo-<id>.md` — hidden from recall and the index, never deleted. A task's
`O<n>` is closed in its journal: `task.js close-item O<n> "<how>"`.

Run it right after fixing AND verifying an item — don't leave it for the next review.

## `/todo adopt <legacy.md>...` — leave the checkbox files behind

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/todo.js" adopt .claude/memory/2026/06/20/manual.md .claude/memory/2026/06/21/sharp-review.md
```

Each OPEN checkbox (`- [ ] MANUAL-…`) or OPEN finding (`### [SR-…]`, `**Status:** OPEN`) of a
legacy file becomes its own item file with `from: memory/<path>#<id>`. The legacy file stays
byte-identical (it is memory); adopting twice adds nothing.

## Sharp-review findings

Sharp-review writes its report under `output/logs/` (never memory). A finding worth keeping
becomes an issue (`backlog: issues`) or a `todo add` item.
