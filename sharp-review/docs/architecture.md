# Sharp Review — Architecture (dev reference)

The deep-detail reference behind `../AGENTS.md`. Load it when a task reaches into file layout
or the method/executor split.

## Method vs executor

The review METHOD is pure data in `method/` (one `schema_version` in `method/method.json`).
An executor reads it and does I/O; executors share NO code, only the method directory and its
conformance fixtures:

- **Node (this plugin)** — in-host sessions: `plan.js` → host fan-out via fabric →
  `post-review.js` → memory sink (sessions) or stdout findings JSON.
- **Python (headless, outside this plugin)** — reads the same `method/` directory, runs its
  reviewers through a one-shot model call, applies the same merge rules, prints the findings
  JSON. It is tested against the same `method/conformance/` fixtures.

What could not be data is named in `method/method.json` by a fixed vocabulary that every
executor implements: the pick `algorithm`, the `reviewer_status.precedence` conditions, the
`merge.validate` JSON-Schema subset (object, required, type string, enum), dedup-key
normalisation (lowercase, truncate by code point), and the template substitution rules. The
conformance fixtures pin each of them.

## File Structure

```
sharp-review/
├── method/                       The review method as data (see table in reference/profiles-and-modes.md)
│   ├── method.json               schema_version, pick, contexts, template, run_modes, reviewer_status, merge
│   ├── profiles.json             Built-in profiles
│   ├── finding.schema.json       Reviewer finding schema
│   ├── findings-output.schema.json  The findings JSON contract (versioned by schema_version)
│   ├── prompts/*.md              Prompt templates + output_contract partial
│   └── conformance/{merge,pick,prompt}/*.json   input → expected, for every executor
├── agents/sharp-review.md        Worker subagent: reads SKILL.md and runs it
├── hooks/sharp-review-hook.js    Stop hook: wave gate, sources, dispatch
├── skills/sharp-review/          SKILL.md (procedure) + reference/*.md
├── scripts/
│   ├── plan.js                   Plan a run: profiles, manifest, providers, rendered prompts → plan file
│   ├── post-review.js            Merge raw results by the method, write the memory sink; --rescan
│   ├── sources.mjs               Trigger adapters (pure): diff | codebase | deps | docs
│   ├── lib.mjs                   Barrel: findings, manifest, config + shared frontmatter helpers
│   └── lib/
│       ├── method.mjs            Load method/ and refuse an unknown schema_version
│       ├── pick.mjs              Effective profiles (method + project config), eligibility, weighted pick
│       ├── prompt.mjs            Template rendering, context → template + call mode
│       ├── plan.mjs              buildPlan (pure)
│       ├── merge.mjs             Reviewer status, finding validation, dedup, confidence, ids
│       ├── findings.mjs          Memory sink: markdown render + same-day follow-up renumber
│       ├── manifest.mjs          Diff classification, git -z parsing, manifest render (pure)
│       ├── git-manifest.mjs      Runs git and builds the manifest
│       └── config.mjs            loadReviewConfig — tracked .claude/sharp-review.json
└── tests/                        node:test; conformance.test.mjs runs the fixtures
```

## Config vs runtime state

Static review config (`profileWeights`, `customProfiles`, `thresholds`, `inlineDiffLimit`,
`docsThreshold`, `codebaseIntervalMin`) lives in the tracked `.claude/sharp-review.json`;
volatile runtime state stays in the gitignored `.claude/.rem-state.json` under `reviewGate`.
`migrations/migrate.mjs` relocates legacy config out of `reviewGate`.
