# Sharp Review — profiles, modes & gating (reference)

On-demand detail behind SKILL.md. The METHOD itself is data in `<root>/method/` — read the
files there for the actual values; this page explains how they are used.

| file | holds |
|---|---|
| `method/method.json` | `schema_version`; pick rule; contexts → template + call mode; run modes (providers, models, synthesis, sink); reviewer-status rules; merge and id spec |
| `method/profiles.json` | every built-in profile: `key`, `label`, `source`, `weight`, `context`, `framing`, `scope` |
| `method/prompts/*.md` | the prompt templates (`{{name}}` placeholders) |
| `method/finding.schema.json` | what each reviewer finding must satisfy |
| `method/conformance/` | inputs paired with expected outputs; every executor is tested against them |

## Configuration file (`.claude/sharp-review.json`)

Static, per-project config lives in a **tracked, committed** `.claude/sharp-review.json` so it
travels with the repo. Do NOT put it in `.claude/.rem-state.json` (gitignored runtime state).
Every key is optional:

```json
{
  "profileWeights":      { "architecture": 0.35, "diff": 0.45 },
  "customProfiles":      [ /* see "Custom profiles" */ ],
  "thresholds":          { "wave0": { "lines": 300, "files": 5 }, "wave1": { "lines": 1000, "files": 15 } },
  "inlineDiffLimit":     20000,
  "docsThreshold":       3,
  "codebaseIntervalMin": 10080
}
```

## Wave Gate (trigger thresholds)

The Stop hook (`sharp-review-hook.js`) invokes the skill once enough change accumulates; a
manual `/sharp-review` bypasses the gate.

- **Wave 0** (new commit): ≥300 lines OR ≥5 files. **Wave 1+** (same ref already reviewed):
  ≥1000 lines OR ≥15 files. The wave resets when HEAD moves; skipped sessions accumulate.
- `lastReviewRef` / `lastReviewDiff` in `reviewGate` make a same-ref check compare only the
  delta since the last review; a vanished ref (rebase/gc) falls back to `HEAD~1`.

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
prompt tells the reviewer to judge against the repository's own CLAUDE.md / AGENTS.md /
`.claude/rules/` — the plugin carries no project principles of its own.

### Custom profiles

`customProfiles` entries have the `method/profiles.json` shape and add to (or replace, by
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
