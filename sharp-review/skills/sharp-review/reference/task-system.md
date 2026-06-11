# Task System — File Ownership

Sharp-review owns findings end-to-end. `post-review.js` writes `sharp-review.md`
and stamps memory — no delegation to `task-engine.js`. The `todo` CLI (owned by
rem) scans memory files on the fly for reporting, and `todo mark <id>
<open|fixed|closed>` (also owned by rem, via `task-lib.mjs`'s `markFinding`)
flips a finding's status in `sharp-review.md` — for `fixed`, it also re-derives
the frontmatter, the same as `post-review.js --rescan`.

| File | Purpose |
|---|---|
| `.claude/memory/YYYY/MM/DD/sharp-review.md` | Single session review file with rem frontmatter — sole source of truth |
| `.claude/rules/MEMORY.md` | Memory index — `stamp-memory.js` is sole maintainer (no separate Tasks section) |
| `.claude/memory/YYYY/MM/DD/manual.md` | Manual tasks (MANUAL-*) — created by `todo add`, rem frontmatter |
