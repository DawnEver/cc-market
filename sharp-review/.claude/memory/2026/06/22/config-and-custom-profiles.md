---
name: config-and-custom-profiles
description: sharp-review review config moved out of gitignored runtime state into tracked .claude/sharp-review.json; new config-driven customProfiles extension point; architecture profile has built-in file-size thresholds
metadata:
  type: design
---

# sharp-review config externalized + custom profiles + file-size thresholds (2026-06-22)

## 1. Separating config from runtime state (key design)
The review **static config** (`profileWeights`, `customProfiles`, `thresholds`, `inlineDiffLimit`,
`docsThreshold`, `codebaseIntervalMin`) moved from the gitignored `.claude/.rem-state.json → reviewGate`
to the **tracked `.claude/sharp-review.json`** — so team decisions like "this repo leans on architecture cleanup / a custom review template"
travel with the repo, no longer device-local.

- Read entry: `scripts/lib/config.mjs` `loadReviewConfig(root)` (returns {}; each caller supplies defaults).
- Readers switched: `pick-profile.js`, `diff-manifest.js`, `hooks/sharp-review-hook.js`. Runtime state
  (sessionId/wave/lastReviewRef…) stays in `.rem-state.json reviewGate`; **the hook no longer writes config keys back
  into runtime state** (avoids drift).
- Migration: `migrations/migrate.mjs` moves the config keys in the old reviewGate into `sharp-review.json` (idempotent;
  existing config keys are not overwritten). `.gitignore` adds a `!**/.claude/sharp-review.json` exception (cc-market
  this repo ignores all of `**/.claude/**`, so it must be let through).

## 2. Config-driven custom profiles (extension point)
A repo can declare review templates in `customProfiles` (array), **without changing plugin code**. `pick-profile.js` via
`mergeProfiles`/`normalizeCustomProfile` merges them into `PROFILES`, taking part in selection by source gating + weight.
Entry: `{ key, source (required, a known trigger), weight?, mode?, promptKind?, framing?, reviewScope? }`.
Reusing a built-in key overrides that built-in. First use in cc-market's own `.claude/sharp-review.json`: `arch-hygiene`
(hygiene review) hangs off the `codebase` source, and the `architecture` weight is lowered, so this repo leans on hygiene review.

## 3. File-size thresholds (global, built into the architecture profile)
The built-in `architecture` profile's reviewScope now has hard thresholds, effective in **every repo**:
- Code: > 300 lines is worth a warning; > 600 lines **must** be split.
- Docs: a single SKILL.md / AGENTS.md / CLAUDE.md > 100 lines is worth a warning → push mechanism/schema/edge cases down into
  `reference/*` (progressive disclosure).
The diff-review default scope, formerly "~400 lines", is aligned to 300/600, so the two profiles do not contradict.

## Related
- Tests: `profiles.test.mjs` (normalizeCustomProfile/mergeProfiles), `pick-profile.test.mjs`
  (config file read + custom profile selection), `migrations.test.mjs` (config migration idempotent / no overwrite).
- Progressive disclosure in the same batch: SKILL.md 295→168, rem SKILL 157→114, mechanism moved into `reference/profiles-and-modes.md`
  and `reference/crystallize.md`.

> Amended 2026-11-17: translated to English (D26) -- approved: "(user, translated) .claude/memory/ and .claude/tasks/ should also be English only"
