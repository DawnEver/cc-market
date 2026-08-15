# Sharp Review — Architecture (dev reference)

This is the deep-detail reference behind `../AGENTS.md`. Load it only when a task reaches
into file layout or the profiles/modes design seam; `AGENTS.md` is the slim entry point.

## File Structure

```
sharp-review/
├── .claude-plugin/plugin.json    Plugin manifest
├── .codex-plugin/plugin.json     Codex plugin manifest (generated)
├── agents/
│   └── sharp-review.md           Dedicated subagent: focused system prompt, runs Steps 1-6
├── .claude/rules/invariants.md   Always-injected constraints
├── docs/                         Dev reference (this file) — AGENTS.md links here for detail
├── hooks/
│   ├── hooks.json                Hook registration (Stop)
│   └── sharp-review-hook.js      Stop hook: classify review depth
├── skills/sharp-review/SKILL.md /sharp-review skill definition
├── scripts/
│   ├── lib.mjs                   Barrel: re-exports lib/* + shared frontmatter helpers (stable `./lib.mjs`/`../scripts/lib.mjs` import path)
│   ├── lib/                      Concern modules:
│   │   ├── findings.mjs          Category inference, same-day follow-up renumber, host-agnostic mergeFindings/renderReviewMarkdown
│   │   ├── profiles.mjs          Profile registry (PROFILES) + weighted selection (resolveWeights/globalWeightsForSources/pickProfileKey)
│   │   ├── manifest.mjs          Diff-manifest: isLockfile/isDoc/classifyLowValue, git -z parsing, buildManifest, renderManifestText
│   │   └── config.mjs            loadReviewConfig — reads tracked .claude/sharp-review.json (profileWeights, customProfiles, thresholds, inlineDiffLimit, …)
│   ├── sources.mjs               Source-adapter registry (pure): diff | codebase | deps | docs trigger logic + evaluateSources
│   ├── pick-profile.js               Source-constrained weighted profile pick (--sources); stateless
│   ├── diff-manifest.js              Analyze git diff → produce size-bounded manifest (review/agent/empty mode)
│   ├── post-review.js                Write memory entry → stamp. `--raw` merges+renders raw per-reviewer findings via lib (host-agnostic — same output on Claude worker subagent and Codex); `--rescan` re-derives frontmatter from an edited memory file
│   └── merge-findings.js             External seam: merge raw per-reviewer findings via the SAME lib engine and print `{ reviewFile, markdown, merged, summary }` to stdout — writes NO memory. For content-review callers (ai-post 三方会审) that own their own persistence
├── tests/                        Tests (node:test)
│   ├── lib.test.mjs              Frontmatter, category inference, markdown parsing
│   ├── merge-render.test.mjs     Host-agnostic mergeFindings/renderReviewMarkdown/buildDedupKey
│   ├── post-review-raw.test.mjs  post-review.js --raw end-to-end (raw fan-out → memory entry)
│   ├── merge-findings-cli.test.mjs  merge-findings.js stdout seam (content-review merge, no memory write)
│   ├── manifest.test.mjs         Diff manifest: parsing, filtering, mode decision, rendering
│   ├── hook.test.mjs             Git root resolution
│   └── migrations.test.mjs       Legacy format migration
├── CLAUDE.md                     Entry point
├── AGENTS.md                     Slim entry point — links here for detail
└── README.md                     User-facing docs
```

## Review Profiles & Modes (design seam only)

Runtime facts — the profile table, weights, the orphan-mass weighting math, the mode
table/thresholds, and config keys — live in `skills/sharp-review/reference/profiles-and-modes.md`
(don't restate them here; they drift). What's dev-only:

- A profile is a review *template* (scope + prompt framing + forced mode) in `PROFILES`
  (`lib/profiles.mjs`), orthogonal to providers (dynamic 2-of-N reviewer rotation, seeded by
  diff-manifest). The
  **profile is the single unit of selection**; a `source` (`sources.mjs`) is just its trigger —
  no pick-source-then-profile two-step.
- `pick-profile.js --sources <fired>` does one global weighted draw via `globalWeightsForSources`.
- The seam is **additive**: the engine was already source-agnostic; only the entry layer
  (profiles + pick-profile + hook gate) was lifted onto it, so all profiles still write the same
  `sharp-review.md` with `SR-` ids and zero downstream changes.
- **Config vs runtime state are separate files** (don't merge them): static review config
  (`profileWeights`, `customProfiles`, `thresholds`, `inlineDiffLimit`, `docsThreshold`,
  `codebaseIntervalMin`) lives in the **tracked** `.claude/sharp-review.json` via
  `loadReviewConfig` (`lib/config.mjs`) so it's shareable; volatile runtime state stays in the
  gitignored `.claude/.rem-state.json` under `reviewGate`. `migrations/migrate.mjs` relocates
  legacy config out of `reviewGate` into the config file. `customProfiles` are config-declared
  review templates merged into `PROFILES` at pick time (`mergeProfiles`/`normalizeCustomProfile`)
  — a repo adds a profile without touching plugin code.
