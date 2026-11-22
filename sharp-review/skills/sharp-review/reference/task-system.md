# Task System — File Ownership

Sharp-review owns findings end-to-end. `post-review.js` writes the run's report
`output/logs/YY/MM/DD/sharp-review/sharp-review.md` (regenerable output, never memory). A
finding worth keeping becomes a forge issue. Sharp-review never writes memory or issues itself.

| File | Purpose |
|---|---|
| `output/logs/YY/MM/DD/sharp-review/sharp-review.md` | The run's report (regenerable) |
| `.claude/memory-index.md` | Memory index — derived from the tree by rem's `rebuildIndex()`; nothing upserts into it |
