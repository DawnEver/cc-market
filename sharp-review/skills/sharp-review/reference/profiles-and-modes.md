# Sharp Review — profiles & modes (reference)

On-demand detail behind SKILL.md. The METHOD itself is ai-lab's data, in the directory
`python -m ai_lab.review.method` prints (with the interpreter fabric setup pinned in `provider-cache.json`)
— read the files there for the actual values; this page explains how they are used.

| file | holds |
|---|---|
| `method.json` | `schema_version`; pick rule; contexts → template + call mode; run modes (providers, models, synthesis, sink); reviewer-status rules; merge and id spec |
| `profiles.json` | every built-in profile: `key`, `label`, `source`, `weight`, `context`, `framing`, `scope` |
| `prompts/*.md` | the prompt templates (`{{name}}` placeholders) |
| `finding.schema.json` | what each reviewer finding must satisfy |
| `findings-output.schema.json` | the merged findings JSON contract; its `description`s define every field, status and the versioning rule |
| `conformance/` | inputs paired with expected outputs; ai-lab's planner and merge are tested against them |

## Configuration file (`.claude/sharp-review.json`)

Static, per-project config lives in a **tracked, committed** `.claude/sharp-review.json` so it
travels with the repo. It is the only file the plugin reads for config.
Every key is optional:

```json
{
  "profileWeights":      { "architecture": 0.35, "diff": 0.45 },
  "customProfiles":      [ /* see "Custom profiles" */ ],
  "inlineDiffLimit":     20000,
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

## Sources and profile selection

A *profile* names the *source* it reacts to: `diff` (the change under review), `codebase`
(an architecture survey), `docs` (documentation) or `deps` (dependency lockfiles). Each run
draws `pick.count` profiles by weighted draw without replacement among the profiles whose
source `plan.js --sources` names (all of them when it names none); the draw order is then
shuffled against the provider order. Set a weight to 0 in `profileWeights` to opt a profile out.

A profile's `context` decides its prompt: `diff` profiles review the diff (inline when it fits
`inlineDiffLimit`, else a manifest the reviewer explores, skipped when nothing reviewable is
left); `explore` profiles (`architecture`, `docs`, `deps`) explore the repo with no diff. Every
prompt renders the `rules` partial: judge against the reviewed project's principles
(its `.claude/rules/principles.md`, passed to ai-lab as `--principles`; the ids a finding's `rule` may name), and the repository's own CLAUDE.md / AGENTS.md /
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
  "framing": "…one-line intent…", "scope": ["bullet a", "bullet b"], "label": "clean-code sharp review" }
```

Keep framings and scopes tight — low-signal instruction text degrades review quality.

## Diff filtering

Lockfiles, minified/sourcemap, generated/vendored paths, binaries and pure renames (R100) are
excluded before the size decision. `inlineDiffLimit` is in chars (default 20000) because chars
track context cost. The plan reports `stats` and `excludedSummary`.

## Attention boundary (Step 4, consumer-aware)

- **AI consumer** (e.g. `evolve`): reads findings from the backlog; the skill never prompts.
- **Human consumer**: findings land in `sharp-review.md` for async triage; only the
  one-line summary reaches chat.

To **triage now**, route OPEN findings through `shared/attention.mjs`: `route(items, {
consumer: 'human' })` compresses to *what you must decide / consequence of not deciding*,
coalesces into one `AskUserQuestion` (≤4, highest severity first) and defers the rest. Map each
finding to `{ id, title: summary, detail: 'file: summary', stakes: severity, reversible: !arch,
default: 'defer', options: [Fix now / Won't-fix / Defer] }`; an AI consumer passes
`consumer: 'ai'`.
