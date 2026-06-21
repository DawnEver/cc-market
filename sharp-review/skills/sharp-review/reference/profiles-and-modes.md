# Sharp Review — profiles, modes & gating (reference)

On-demand detail behind the lean Step 1/2 commands in `SKILL.md`. Read this when you need the
*why* — the selection math, the mode internals, or the per-project config keys. The skill's
happy path only needs the commands and their JSON output, not this file.

## Wave Gate (trigger thresholds)

The skill is normally invoked *by* the Stop hook (`sharp-review-hook.js`) after enough change
accumulates; a manual `/sharp-review` bypasses the gate entirely. Gate logic, for reference:

- **Wave 0** (new commit): triggers at ≥300 lines changed OR ≥5 files — catch issues early.
- **Wave 1+** (same ref already reviewed): ≥1000 lines OR ≥15 files — only re-trigger after
  substantial new changes.
- Wave resets to 0 when HEAD moves to a new commit. Skipped sessions keep accumulating.

Per-project config — `.claude/.rem-state.json` → `reviewGate.thresholds`:
```json
{ "wave0": { "lines": 300, "files": 5 }, "wave1": { "lines": 1000, "files": 15 } }
```

## Profile selection (weighting math)

A *profile* is the unit of selection; a *source* is the named trigger it reacts to (diff and
security share the `diff` trigger). Selection is a single **global** weighted draw over the
profiles whose source fired this round — no pick-source-then-profile two-step. Provider
selection is unaffected; profiles never bind a provider.

| Profile | Source | Weight | Mode | Reviews |
|---|---|---|---|---|
| `diff` | `diff` | 0.6 | honors diff-manifest | the git diff — bugs & cleanup (default) |
| `architecture` (架构锐评) | `codebase` | 0.2 | agent | whole codebase architecture |
| `security` (安全锐评) | `diff` | 0.05 | honors diff-manifest | the diff for security vulnerabilities |
| `docs` (文档锐评) | `docs` | 0.1 | agent | docs vs. current code |
| `deps` (依赖锐评) | `deps` | 0.05 | agent | dependency risk (CVEs, licenses) |

Default weights sum to 1.0 and are **global probabilities** — across reviews each profile runs
at roughly its weight. A profile is only *eligible* when its source fired; the weight of any
profile whose source is cold this round (its "orphan mass") folds into the catch-all `diff`
review, so each eligible specialist keeps its **exact global share** and `diff` absorbs the
slack (its effective rate rises above 0.6 when specialists are idle). If `diff` itself is cold
(e.g. a doc-only change, so only the `docs` source fired), the orphan mass spreads across
whatever is eligible. Set a weight to 0 in `profileWeights` to opt a profile out.

Sources fire on: `diff` = wave gate; `codebase` = time interval; `docs` = ≥N doc files changed;
`deps` = a lockfile changed. `architecture`/`docs`/`deps` run in **agent mode** with no diff
payload — reviewers explore the repo. Source config (`docsThreshold`, `codebaseIntervalMin`,
`profileWeights`) lives under `reviewGate` in `.claude/.rem-state.json`.

## Dual review modes

`diff-manifest.js` picks the mode automatically from filtered diff size:

| Mode | Condition | Behavior |
|---|---|---|
| `review` | Filtered diff ≤ `inlineDiffLimit` chars | Full diff inlined into reviewer prompts — best signal |
| `agent` | Filtered diff > `inlineDiffLimit` chars | Manifest only (file table + hunk headers); reviewers explore via `git diff -- <path>` |
| `empty` | No reviewable files after filtering | Skill exits early — no review |

**Smart filtering** (both modes): lockfiles, minified/sourcemap, generated/vendored paths,
binary files, and pure renames (R100) are excluded so noise doesn't inflate diff size.

Per-project config — `.claude/.rem-state.json` → `reviewGate.inlineDiffLimit` (chars, default
20000; chars not lines, because chars track context-window cost):
```json
{ "reviewGate": { "inlineDiffLimit": 20000 } }
```

## diff-manifest.js output payload

Size-bounded by construction — every field is guaranteed under safe limits:
```json
{
  "mode": "review" | "agent" | "empty",
  "range": "HEAD",
  "seed": 29345678,               // minutes since epoch; seeds reviewer-pair pick
  "path": "src/components",       // only when --path is provided
  "stats": { "files": 42, "insertions": 1234, "deletions": 567, "excluded": 9, "diffChars": 183421 },
  "diff": "...",            // only review mode (≤ inlineDiffLimit chars)
  "manifestText": "...",    // only agent mode (≤ 12k chars)
  "excludedSummary": "9 files excluded: 3 lockfile, 4 generated, 2 binary"
}
```

## Reviewer schema (what each reviewer must return)

2 of 3 reviewers run, picked by `seed mod 3` (combos AB/AC/BC) so same-day rounds rotate the
pair: A (Codex), B (DeepSeek), C (Opus). Each is JSON-Schema-constrained to a finding with:
`severity` (HIGH|MEDIUM|LOW|INFO), `file`, `summary` (one line), `category`
(Bug|Feature|Performance), `status` (OPEN|FIXED), `suggestion` (one line).

## Attention boundary (Step 6, consumer-aware)

The Step 6 report **is** the attention gate, and the skill is consumer-aware by construction:

- **AI consumer** (e.g. `evolve`, or any parent orchestrator): consumes findings from the
  backlog/return programmatically. The skill **never prompts** — no human attention to protect,
  so findings go to backlog, not chat. This is the default.
- **Human consumer**: findings land in the `sharp-review.md` backlog for *async* triage via
  `todo`, kept out of chat so a review never floods attention. Only the one-line `summary` reaches you.

When a human wants to **triage now** (not later via `todo`), route OPEN findings through the
shared attention gate (`shared/attention.mjs`) instead of reading them all: `route(items, {
consumer: 'human' })` compresses to *what you must decide / consequence of not deciding*,
coalesces into one `AskUserQuestion` (≤4, highest-severity first), and defers the low-stakes
rest. Map each finding to `{ id, title: summary, detail: 'file: summary', stakes: severity,
reversible: !arch, default: 'defer', options: [Fix now / Won't-fix / Defer] }`. For an AI
consumer pass `consumer: 'ai'` — resolves by policy, no prompt.
