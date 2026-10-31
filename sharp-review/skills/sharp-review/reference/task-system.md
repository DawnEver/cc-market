# Task System — File Ownership

Sharp-review owns findings end-to-end. `post-review.js` writes the run's report
`output/logs/YY/MM/DD/sharp-review/sharp-review.md` (regenerable output, never memory). A
finding worth keeping enters rem's one backlog: an issue where the repo has a tracker
(`.claude/rem.json` `{"backlog": "issues"}`), else `todo.js add` (one file per item in
`.claude/todo/`). Sharp-review never writes memory or the backlog itself.

| File | Purpose |
|---|---|
| `output/logs/YY/MM/DD/sharp-review/sharp-review.md` | The run's report (regenerable) |
| `.claude/todo/<id>.md` | A kept finding as a rem backlog item (repos without a tracker) |
| `.claude/memory-index.md` | Memory index — derived from the tree by rem's `rebuildIndex()`; nothing upserts into it |
