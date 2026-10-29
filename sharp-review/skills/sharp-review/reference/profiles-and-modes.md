# Sharp Review — profiles, modes & gating (reference)

On-demand detail behind SKILL.md. The METHOD itself is ai-lab's data, in the directory
`python -m ai_lab.review.method` prints (with the interpreter fabric setup pinned in `provider-cache.json`)
— read the files there for the actual values; this page explains how they are used.

| file | holds |
|---|---|
| `method.json` | `schema_version`; pick rule; contexts → template + call mode; run modes (providers, models, synthesis, sink); reviewer-status rules; merge and id spec |
| `profiles.json` | every built-in profile: `key`, `label`, `source`, `weight`, `context`, `framing`, `scope` |
| `prompts/*.md` | the prompt templates (`{{name}}` placeholders) |
| `principles.json` | the principles reviewers judge against; with the family rule registry (`dev_lab.dev.rules`, read at load) the ids a finding's `rule` may name |
| `finding.schema.json` | what each reviewer finding must satisfy |
| `findings-output.schema.json` | the merged findings JSON contract; its `description`s define every field, status and the versioning rule |
| `conformance/` | inputs paired with expected outputs; ai-lab's planner and merge are tested against them |

## Configuration file (`.claude/sharp-review.json`)

Static, per-project config lives in a **tracked, committed** `.claude/sharp-review.json` so it
travels with the repo. Do NOT put it in `.claude/.rem-state.json` (gitignored runtime state).
Every key is optional:

```json
{
  "profileWeights":      { "architecture": 0.35, "diff": 0.45 },
  "customProfiles":      [ /* see "Custom profiles" */ ],
  "thresholds":          { "wave0": { "lines": 1000, "files": 15 }, "wave1": { "lines": 3000, "files": 45 } },
  "inlineDiffLimit":     20000,
  "docsThreshold":       3,
  "codebaseIntervalMin": 10080,
  "providers":           { "interactive": ["claude", "codex"], "headless": ["anthropic"] }
}
```

## Run modes and providers

`method.json` `run_modes` declares two: **interactive** (sessions: the providers fabric
`list_providers` reports as `callable:`, alphabetical, rotated by the minute seed, two of them; report sink)
and **headless** (no session: `["anthropic"]`, diff-context profiles and one-shot calls only,
findings JSON on stdout). Neither synthesises or summarises reviewer output. The provider set
resolves `--providers` → `providers.<mode>` here → the run mode default. Reviewer *i* takes
provider *i mod n*; a requested provider the host cannot run is `unavailable`, a call mode the
run mode cannot execute is `unsupported` — neither is ever replaced by another provider.

## Wave Gate (trigger thresholds)

The Stop hook (`sharp-review-hook.js`) invokes the skill once enough change accumulates; a
manual `/sharp-review` bypasses the gate.

- **Wave 0** (new commit): ≥1000 lines OR ≥15 files. **Wave 1+** (same ref already reviewed):
  ≥3000 lines OR ≥45 files. The wave resets when HEAD moves; skipped sessions accumulate.
- `lastReviewRef` / `lastReviewDiff` in `reviewGate` make a same-ref check compare only the
  delta since the last review; a vanished ref (rebase/gc) falls back to `HEAD`, the range the review itself reads (a `HEAD~1` base fired on a commit the review then found empty, every Stop).
- **Content-hash gate:** a fired source dispatches only when the content it reviews changed
  since its last successful review (`reviewGate.reviewedHashes`: sha256 over each covered file's path
  and bytes; `codebase` hashes HEAD). Sessions sharing one checkout alternate on the same state,
  so without it an unchanged dirty tree re-fired the same profile every turn.
- Every eligible Stop reevaluates thresholds, even within a session whose first turn was
  below threshold. No model classifies depth: a fired source requests one planned pass.
- `reviewGate.pending` is a checkout-wide, 30-minute claim carrying token, session/turn,
  source hashes, head and diff stat. It is reserved atomically, not counted as a review.
  Pass its token to `plan.js --gate-token`; post-review credits hashes only after a sink
  write with at least one successful reviewer. `--release-gate` cancels without credit.
- A session's pending REM, user-input wait, active project deferral, or Stop continuation
  suppresses dispatch. REM checks the same locked review claim so both cannot request
  competing continuations from one Stop. Manual review bypasses the trigger thresholds.

## Sources and profile selection

A *source* is a trigger: `diff` = the wave gate; `codebase` = time since the last review
(`codebaseIntervalMin`); `docs` = ≥`docsThreshold` doc files changed; `deps` = a lockfile
changed. A *profile* names the source it reacts to. Each run draws `pick.count` profiles by
weighted draw without replacement among the profiles whose source fired (all of them on a
manual run); the draw order is then shuffled against the provider order. Set a weight to 0 in
`profileWeights` to opt a profile out.

A profile's `context` decides its prompt: `diff` profiles review the diff (inline when it fits
`inlineDiffLimit`, else a manifest the reviewer explores, skipped when nothing reviewable is
left); `explore` profiles (`architecture`, `docs`, `deps`) explore the repo with no diff. Every
prompt renders the `rules` partial: judge against the principles in the method's
`principles.json`, the family registry rule ids, and the repository's own CLAUDE.md / AGENTS.md /
`.claude/rules/`, and tag each finding (findings v3) with `severity` (HIGH/MEDIUM/LOW), `security`
and the ONE `rule` id it violates (an unknown id drops the finding), plus the verbatim `anchor` line.
The finding id is `F-<12 hex>` of rule, file and anchor -- the same in every run. The report lists
the tags per finding, the blocking (HIGH or security) ids, and indexes the run `By rule`.

### Custom profiles

`customProfiles` entries have the method's `profiles.json` shape and add to (or replace, by
`key`) the built-in set. `key`, `source`, `context` and `scope` are required — an entry lacking
one is refused by name; `label` defaults to the key, `weight` to 0.1, `framing` to none.

```json
{ "key": "arch-hygiene", "source": "codebase", "context": "explore", "weight": 0.3,
  "framing": "…one-line intent…", "scope": ["bullet a", "bullet b"], "label": "整洁锐评" }
```

Keep framings and scopes tight — low-signal instruction text degrades review quality.

## Diff filtering

Lockfiles, minified/sourcemap, generated/vendored paths, binaries and pure renames (R100) are
excluded before the size decision. `inlineDiffLimit` is in chars (default 20000) because chars
track context cost. The plan reports `stats` and `excludedSummary`.

## Attention boundary (Step 4, consumer-aware)

- **AI consumer** (e.g. `evolve`): reads findings from the backlog; the skill never prompts.
- **Human consumer**: findings land in `sharp-review.md` for async triage via `todo`; only the
  one-line summary reaches chat.

To **triage now**, route OPEN findings through `shared/attention.mjs`: `route(items, {
consumer: 'human' })` compresses to *what you must decide / consequence of not deciding*,
coalesces into one `AskUserQuestion` (≤4, highest severity first) and defers the rest. Map each
finding to `{ id, title: summary, detail: 'file: summary', stakes: severity, reversible: !arch,
default: 'defer', options: [Fix now / Won't-fix / Defer] }`; an AI consumer passes
`consumer: 'ai'`.
