# Task System — File Ownership

Sharp-review owns findings end-to-end. `post-review.js` writes `sharp-review.md`,
stamps memory, and directly archives resolved findings — no delegation to
`task-engine.js`. The `todo` CLI (owned by rem) scans memory files on the fly for
reporting.

| File | Purpose |
|---|---|
| `.claude/memory/YYYY/MM/DD/sharp-review.md` | Single session review file with rem frontmatter — sole source of truth |
| `.claude/tasks/archive/YYYY/MM/DD.md` | Resolved finding archive (daily files) |
| `.claude/rules/MEMORY.md` | Memory index — `stamp-memory.js` is sole maintainer (no separate Tasks section) |
| `.claude/memory/YYYY/MM/DD/manual.md` | Manual tasks (MANUAL-*) — created by `todo add`, rem frontmatter |
