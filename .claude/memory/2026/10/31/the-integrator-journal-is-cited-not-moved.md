---
name: the-integrator-journal-is-cited-not-moved
description: "The integrator's DECISIONS entry stays in memory untouched; the new task JOURNAL starts by citing it -- corrects the plan's 'moves'"
metadata:
  type: entry
created: 2026-10-31
corrects: .claude/memory/2026/10/31/PLAN-rem-four-layers-rules-docs-memory-tasks.md
---

The plan (`PLAN-rem-four-layers-rules-docs-memory-tasks.md`, P7 line) says the D1..D121 journal "moves to
`.claude/tasks/integrator/JOURNAL.md`". That wording is wrong under the plan's own rulings: memory is never
deleted, and a `git mv` out of `.claude/memory/` is a deletion that dev-lab's MEMORY-SHAPE change check
(`dev_lab.dev.memoryadds`) refuses. The one allowed move is the other way, a closed task archived into memory.

Integrator ruling 2026-10-31: the journal is neither copied nor moved. The entry
`.claude/memory/2026/10/28/DECISIONS-integrator-bulk-merge-and-architecture-2026-10-28.md` stays in memory
untouched. After the user's `/rem:task open integrator`, the new `.claude/tasks/integrator/JOURNAL.md` starts
with one line citing it -- `from: .claude/memory/2026/10/28/DECISIONS-integrator-bulk-merge-and-architecture-2026-10-28.md`
-- and later decisions are appended there.

The migration (`rem/migrations/migrate.mjs`) does not touch the entry: it only lists DECISIONS- files as history.
