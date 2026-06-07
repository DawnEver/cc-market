---
name: sharp-review-rem-unification
description: Sharp-review findings become single memory entry per session, fully managed by rem — eliminated 14 individual SR-*.md files, resolved.txt, and .claude/sharp-review/ directory
metadata:
  type: project
created: 2026-06-07
accessed: 2026-06-07
tier: short
---

# Sharp-Review → Rem Unification

One file per session: `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter.
Resolution = in-place edit. `post-review.js --rescan` rereads file, parses statuses, regenerates tasks.md.

Deleted: .claude/sharp-review/, resolved.txt, 14 SR-*.md files, 6 lib.mjs functions.
Added: reviewFrontmatter(), parseFindingsFromMarkdown(), post-review.js --rescan.
Tests: 109 pass (sharp-review + rem).
