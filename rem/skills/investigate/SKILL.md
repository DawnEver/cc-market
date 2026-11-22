---
name: investigate
description: Research a question, write findings to memory, file a follow-up. No code changes — pure investigation.
---

# Investigate

Research-only mode — understand before acting. When invoked:

## Process

1. **Research thoroughly** — read relevant files, trace dependencies, check architecture,
   look at precedents, compare alternatives. Leave no obvious question unanswered.

2. **Write a detailed memory file** at `.claude/memory/YYYY/MM/DD/<slug>.md` with:
   - Proper YAML frontmatter (`name`, `description`, `metadata.type: research`)
   - Written in English unless `.claude/rem.json` sets `"language": "unrestricted"` (see `../rem/reference/memory-conventions.md` § Language)
   - Clear conclusion up top (not buried)
   - Current-state breakdown (what exists, what doesn't)
   - Analysis (pros/cons, technical blockers, alternatives considered)
   - Recommendation with reasoning
   - List of files checked

3. **Record the follow-up:** inside a bound task, `task.js open-item "Research: <topic> — <one-line conclusion>"`;
   otherwise draft an issue with that title for the user to file in the repo's tracker.

4. **Index the new memory file:**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/index-memory.js
   ```

## Constraints

- **Do NOT execute any code changes** — no edits, no writes beyond the memory file and
  the follow-up. This is pure investigation.
- **Do NOT create new files outside `.claude/memory/`** — no scripts, no config changes,
  no refactoring.
- **Do NOT commit** — leave the memory file as uncommitted changes for the user
  to review.
- If the investigation reveals that action IS needed, state it clearly in the memory
  file's recommendation section but do NOT act on it.
