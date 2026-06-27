---
name: investigate
description: >
  Research a question or proposal thoroughly, write a detailed memory file with findings,
  and add a task to rem:todo. Do NOT execute any code changes — pure investigation mode.
  Use when the user wants to understand feasibility, explore options, or document a
  decision before acting.
---

# Investigate

Research-only mode — understand before acting. When invoked:

## Process

1. **Research thoroughly** — read relevant files, trace dependencies, check architecture,
   look at precedents, compare alternatives. Leave no obvious question unanswered.

2. **Write a detailed memory file** at `.claude/memory/YYYY/MM/DD/<slug>.md` with:
   - Proper YAML frontmatter (`name`, `description`, `metadata.type: research`)
   - Clear conclusion up top (not buried)
   - Current-state breakdown (what exists, what doesn't)
   - Analysis (pros/cons, technical blockers, alternatives considered)
   - Recommendation with reasoning
   - List of files checked

3. **Add to rem:todo** via:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/task-engine.js add \
     --summary "调研：<topic> — <one-line conclusion>" \
     --severity LOW --module research
   ```

4. **Index the new memory file:**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/stamp-memory.js
   ```

## Constraints

- **Do NOT execute any code changes** — no edits, no writes beyond the memory file and
  todo entry. This is pure investigation.
- **Do NOT create new files outside `.claude/memory/`** — no scripts, no config changes,
  no refactoring.
- **Do NOT commit** — leave the memory file and todo as uncommitted changes for the user
  to review.
- If the investigation reveals that action IS needed, state it clearly in the memory
  file's recommendation section but do NOT act on it.
