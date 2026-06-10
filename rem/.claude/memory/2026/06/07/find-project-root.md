---
name: find-project-root
description: findProjectRoot() is the canonical project-root resolver — never use CLAUDE_PROJECT_DIR directly
metadata:
  type: feedback
created: 2026-06-07
accessed: 2026-06-07
tier: short
---

# Project Root Resolution

`findProjectRoot()` walks up from `CLAUDE_PROJECT_DIR` to the nearest `.git` directory.

**Why:** `CLAUDE_PROJECT_DIR` may point to a plugin subdirectory (e.g., `cc-market/watch/`) when Claude Code is launched there. Using it directly would write state files (`[[.rem-state.json-leak]]`) into the wrong location. `findProjectRoot()` resolves this by always returning the git repo root.

**How to apply:** All code that needs the project root MUST use `findProjectRoot()` — never read `CLAUDE_PROJECT_DIR` directly. Both `rem/lib.mjs` and `sharp-review/hooks/sharp-review-hook.js` now export this function.
