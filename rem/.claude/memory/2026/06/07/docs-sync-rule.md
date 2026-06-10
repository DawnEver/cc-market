---
name: docs-sync-rule
description: When memory structure changes, update all documentation files in the progressive-disclosure chain
metadata:
  type: feedback
created: 2026-06-07
accessed: 2026-06-10
tier: short
access_count: 2
---

# Documentation Sync Rule

When memory or code structure changes (files added/removed/split, new modules created), update ALL of:

- `MEMORY.md` — index of memory entries
- `AGENTS.md` — architecture and file structure
- `README.md` — user-facing documentation
- `CLAUDE.md` — entry point

**Why:** These files form a progressive-disclosure chain and MUST stay consistent. Outdated AGENTS.md causes confusion for future agents working on the plugin.

**How to apply:** After any structural change, read the affected doc files and update them to reflect the current state. Don't add this to invariants directly — let compaction promote it when the rule has proven stable.
