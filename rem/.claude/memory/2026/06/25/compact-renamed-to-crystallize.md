---
name: compact-renamed-to-crystallize
description: Renamed compact → crystallize across REM plugin to disambiguate from Claude Code's built-in context compaction
metadata:
  type: project
---

# compact → crystallize (2026-06-25)

Renamed the REM memory distillation feature from "compact" to "crystallize" to avoid
naming collision with Claude Code's own context compaction (`pre_compact`/`post_compact`).

## Changes

- `scripts/compact.js` → `scripts/crystallize.js` — all `[compact]` → `[crystallize]`, drop reason `'compacted'` → `'crystallized'`
- `skills/rem/reference/compact.md` → `skills/rem/reference/crystallize.md`
- Updated references in SKILL.md, AGENTS.md, README.md, invariants.md, lib.mjs (INDEX_HEADER), rem-prep.js, check-docs.js, scope-split.js, scope-split.md, scripts.md, memory-conventions.md
- Updated cc-market root: AGENTS.md, README.md, marketplace.json
- Updated main repo: README.md
- Updated memory files referencing "compact"/"compaction"
- REM version: 1.0.37 → 1.1.0
- Marketplace version: 2.2.5 → 2.3.0

## Not changed
- Test names "compact date format" — refers to YYMMDD representation, not the feature
- Historical `_meta.json` entries with `"dropped":"compacted"` — accurate records
- Claude Code hook events `pre_compact`/`post_compact` — CC's own mechanism

## Verified
- All 234 REM tests pass
- No remaining `compact.js`/`compact.md`/`[compact]` references in codebase
