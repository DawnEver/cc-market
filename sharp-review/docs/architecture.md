# Sharp Review — Architecture (dev reference)

The deep-detail reference behind `../AGENTS.md`. Load it when a task reaches into file layout
or the method/executor split.

## Method vs executor

The review METHOD is pure data owned by ai-lab (`ai_lab/review/method_data/`, one `schema_version`
in its `method.json`; it moved there from this plugin under PLAN-a-short-robust-toolchain P4). Its rules
have one implementation each, ai-lab's: the planner (`python -m ai_lab.review.plan`: profiles, pick,
providers, rendered prompts, reviewer statuses) and the merge (`python -m ai_lab.review.merge`). The
conformance fixtures ship with the method and run in ai-lab's suite. Two executors do the I/O:

- **Node (this plugin)** — in-host sessions: `plan.js` collects the manifest (git) and has ai-lab plan
  the run → host fan-out via fabric → `post-review.js`, which pipes the run record to ai-lab's merge →
  memory sink or stdout findings JSON. Both calls go through `lib/ai-lab.mjs`; the interpreter is the
  one fabric setup pinned in `provider-cache.json`, and an absent or too-old one is `AiLabUnavailable`
  naming the remedy, never a fallback.
- **Python (headless, ai-lab)** — `python -m ai_lab.review` runs its reviewers through a one-shot
  model call and the same merge, and prints the findings JSON.

## File Structure

```
sharp-review/
├── agents/sharp-review.md        Worker subagent: reads SKILL.md and runs it
├── hooks/sharp-review-hook.js    Stop hook: wave gate, sources, dispatch
├── skills/sharp-review/          SKILL.md (procedure) + reference/*.md
├── scripts/
│   ├── plan.js                   Collect the manifest, have ai-lab plan the run → plan file
│   ├── post-review.js            Merge raw results through ai-lab, write the memory sink; --rescan
│   ├── gate.mjs                  Atomic review-claim lifecycle; only successful completion credits content
│   ├── sources.mjs               Trigger adapters (pure): diff | codebase | deps | docs
│   ├── lib.mjs                   Barrel: findings, manifest, config + shared frontmatter helpers
│   └── lib/
│       ├── ai-lab.mjs            The planner and the merge: `python -m ai_lab.review.plan` / `.merge`
│       ├── findings.mjs          Memory sink: markdown render + same-day follow-up renumber
│       ├── manifest.mjs          Diff classification, git -z parsing, manifest render (pure)
│       ├── git-manifest.mjs      Runs git and builds the manifest
│       └── config.mjs            loadReviewConfig — tracked .claude/sharp-review.json
└── tests/                        node:test
```

## Config vs runtime state

Static review config (`profileWeights`, `customProfiles`, `thresholds`, `inlineDiffLimit`,
`docsThreshold`, `codebaseIntervalMin`) lives in the tracked `.claude/sharp-review.json`;
volatile runtime state stays in the gitignored `.claude/.rem-state.json` under `reviewGate`.
`migrations/migrate.mjs` relocates legacy config out of `reviewGate`.
