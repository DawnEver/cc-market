---
name: access-count-promotion
description: access_count frontmatter field replaces broken git-commit-count promotion heuristic in rem-prep.js
metadata:
  type: project
---

## Problem

Two related issues with the memory promotion/access-tracking mechanism:

1. `rem-prep.js` promoted short-term memories to `tier: long` based on `git log --oneline`
   commit count (`>= 3` commits on the file). Memory files are typically committed once
   when created, so this threshold was almost never reached — promotion to long-term
   essentially never happened automatically.
2. `accessed` was only bumped for memory files read *before* `/rem` started (rem-prep
   step 0). Files read/edited *during* `/rem` itself (e.g. consolidated during crystallize)
   never got their `accessed`/`access_count` updated.

## Fix

- `lib.mjs`: `bumpAccessed(content, date)` now increments a new `access_count` frontmatter
  field (default 1) whenever `accessed` actually advances to a new date — same-day
  re-touches don't count. New helper `getAccessCount(content)`.
- `scripts/rem-prep.js`: removed all `execFileSync('git', ['log', ...])` promotion logic
  (and now-unused `execFileSync`/`relative`/`repoRoot` imports). Promotion candidates are
  now `getTier(content) !== 'long' && getAccessCount(content) >= 3`.
- `skills/rem/SKILL.md`: documented `access_count` in the memory file format/promotion
  sections, and added a new Standard step 4 — re-run
  `rem-prep.js --transcript ... --promote` at the END of the `/rem` flow, after
  steps 1-3 (summarize/update memory/crystallize), to catch memory files touched during
  `/rem` itself.
- `lib.mjs` `INDEX_HEADER`, `.claude/rules/invariants.md`, `README.md` updated to document
  `access_count`.
- Tests added to `tests/frontmatter.test.mjs`: `bumpAccessed` increments `access_count` on
  date-advance, doesn't increment on same-day re-touch, compounds across repeated advances;
  `getAccessCount` defaults to 1.

## Verification

- `node --test tests/*.test.mjs`: 98 pass (frontmatter/lib/date-path/rem-hook) + 5 pass
  (migrations.test.mjs). Only pre-existing unrelated `check-docs.test.mjs` EPERM sandbox
  failures (19, environment-only — `/tmp/mkdtemp` denied).
- End-to-end scratch repo test: file with `accessed: 2026-05-01, tier: short,
  access_count: 2` + a transcript referencing it via `Read` → after
  `rem-prep.js --promote`: `accessed: 2026-06-10`, `access_count: 3`, `tier: long`,
  and `MEMORY.md` index `accessed` updated to match.

## Note: index has no separate long-term section

`MEMORY.md` is a flat list under one `## Short-term (90d eviction window)` heading.
`tier` lives only in each memory file's frontmatter — `prune-memory.js` classifies by
reading each file, not by index section. Manually-promoted long-term entries
(e.g. `api_proxy.md`, `macos_notify_swift.md` in the main repo's index) currently sit
under the "Short-term" heading, which is visually misleading but functionally fine.
Considered adding a separate `## Long-term (immune to 90d eviction)` section
(pure display change, `parseIndex` doesn't care about headings) — not yet done.
