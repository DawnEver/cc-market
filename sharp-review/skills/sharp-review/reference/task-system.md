# Task System — File Ownership

Sharp-review owns findings end-to-end. `post-review.js` writes the run's report
`output/logs/YY/MM/DD/sharp-review/sharp-review.md` (regenerable output, never memory) — no delegation to `task-engine.js`. The `todo` CLI (owned by
rem) scans memory files on the fly for reporting, and `todo mark <id>
<open|fixed|closed>` (also owned by rem, via `task-lib.mjs`'s `markFinding`)
flips a finding's status in `sharp-review.md` — for `fixed`, it also re-derives
the frontmatter, the same as `post-review.js --rescan`.

| File | Purpose |
|---|---|
| `output/logs/YY/MM/DD/sharp-review/sharp-review.md` | The run's report; a finding a person keeps is moved into `.claude/memory/`, where `todo` sees it |
| `.claude/rules/MEMORY.md` | Memory index — derived from the tree by rem's `rebuildIndex()`; nothing upserts into it |
| `.claude/memory/YYYY/MM/DD/manual.md` | Manual tasks (MANUAL-*) — created by `todo add`, rem frontmatter |
