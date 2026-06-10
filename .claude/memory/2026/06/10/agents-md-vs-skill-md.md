---
name: agnets-md-vs-skill-md
description: AGENTS.md is dev-only; SKILL.md is what users actually see
metadata:
  type: feedback
created: 2026-06-10
accessed: 2026-06-10
tier: short
---

# AGENTS.md is Dev-Only — Use SKILL.md for User-Visible Changes

When making changes that affect plugin/skill behavior visible to end users,
always edit `SKILL.md` (the skill definition loaded by the plugin system),
NOT `AGENTS.md`. `AGENTS.md` is only visible in the dev environment (source
repo); the installed plugin cache loads `SKILL.md`.

**Why:** Claude Code's plugin system loads skills from the installed cache
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md`).
Changes to `AGENTS.md` in the source repo won't propagate to the user-facing
skill definition. The user explicitly corrected this on 2026-06-10.

**How to apply:** When updating plugin behavior, documentation, or instructions
that users should see, always modify `SKILL.md` in the plugin's skills directory.
Similarly, for hooks, modify the actual hook script (e.g., `scripts/hooks/*.js`),
not just documentation about the hook.
