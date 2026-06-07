---
name: sharp-review-2026-06-07
description: Sharp review findings — 26 total
metadata:
  type: project
created: 2026-06-07
accessed: 2026-06-07
tier: short
---

# Sharp Review — 2026-06-07

Architecture refactor: sharp-review → single memory entry per session, managed by rem. Eliminated individual SR-*.md files, resolved.txt, and .claude/sharp-review/ directory. 26 findings, all resolved.

Key fixes applied:
- SKILL.md files updated to post-review.js flow
- AGENTS.md files rewritten
- reviewFrontmatter simplified (total count only)
- post-review.js --rescan added
- writeBackMemoryRefs section-based insertion
- Same-day merge logic in post-review.js
- parseFindingsFromMarkdown extracted to lib.mjs
- task-engine.js --add for manual tasks
- Arg parsing improved, temp dir uses os.tmpdir()
- Memory path restructured to YYYY/MM/DD
- /tasks skill renamed to /todo

Tests: 109 pass. 26/26 findings resolved.
