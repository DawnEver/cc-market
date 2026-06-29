# Sharp Review — profiles, modes & gating (reference)

On-demand detail behind the lean Step 1/2 commands in `SKILL.md`. Read this when you need the
*why* — the selection math, the mode internals, or the per-project config keys. The skill's
happy path only needs the commands and their JSON output, not this file.

## Configuration file (`.claude/sharp-review.json`)

All static, per-project review config lives in a **tracked, committed** `.claude/sharp-review.json`
— so a repo's tuning ("this codebase leans on architecture surveys", custom review templates)
travels with it, the same for everyone. Do NOT put it in `.claude/.rem-state.json`: that file is
gitignored runtime state (sessionId, wave, lastReviewRef …) and would make the config device-local.

Every key is optional (defaults apply when absent):
```json
{
  "profileWeights":      { "architecture": 0.35, "diff": 0.45 },
  "customProfiles":      [ /* see "Custom profiles" below */ ],
  "thresholds":          { "wave0": { "lines": 300, "files": 5 }, "wave1": { "lines": 1000, "files": 15 } },
  "inlineDiffLimit":     20000,
  "docsThreshold":       3,
  "codebaseIntervalMin": 10080
}
```

## Wave Gate (trigger thresholds)

The skill is normally invoked *by* the Stop hook (`sharp-review-hook.js`) after enough change
accumulates; a manual `/sharp-review` bypasses the gate entirely. Gate logic, for reference:

- **Wave 0** (new commit): triggers at ≥300 lines changed OR ≥5 files — catch issues early.
- **Wave 1+** (same ref already reviewed): ≥1000 lines OR ≥15 files — only re-trigger after
  substantial new changes.
- Wave resets to 0 when HEAD moves to a new commit. Skipped sessions keep accumulating.

Config — `.claude/sharp-review.json` → `thresholds` (see the config file section above).

### Implementation: delta comparison

The hook's `reviewGate` state prevents the "one more file re-triggers" problem:

- `lastReviewRef` — the commit last reviewed. Skipped sessions do NOT update it; changes keep
  accumulating until the threshold is crossed.
- `lastReviewDiff` — the diff stat at the time of the last review. On same-ref checks, only the
  **delta** (current diff minus last reviewed diff) is compared against the threshold.
- Ref vanished (rebase/gc): falls back to `HEAD~1`.

## Profile selection (weighting math)

A *profile* is the unit of selection; a *source* is the named trigger it reacts to (diff and
security share the `diff` trigger). Each round picks **2 profiles** via weighted random draw
**without replacement** from the profiles whose source fired. Each profile stands on its own
weight — no orphan-mass folding. Provider selection is unaffected; profiles never bind a
provider. Reviewer-to-profile assignment is shuffled so no profile is predictably bound to a
specific reviewer model.

| Profile | Source | Weight | Mode | Reviews |
|---|---|---|---|---|
| `diff` | `diff` | 0.5 | honors diff-manifest | the git diff — bugs & cleanup (default) |
| `architecture` (架构锐评) | `codebase` | 0.2 | agent | whole codebase architecture |
| `security` (安全锐评) | `diff` | 0.05 | honors diff-manifest | the diff for security vulnerabilities |
| `adversarial` (对抗性审查) | `diff` | 0.1 | honors diff-manifest | blind spots, edge cases, implicit assumptions |
| `docs` (文档锐评) | `docs` | 0.1 | agent | docs vs. current code |
| `deps` (依赖锐评) | `deps` | 0.05 | agent | dependency risk (CVEs, licenses) |

If fewer than 2 profiles are eligible (e.g. only `codebase` source fires → only `architecture`),
the round runs with a single profile. Set a weight to 0 in `profileWeights` to opt a profile out.
Each reviewer receives its own profile's framing and scope — two reviewers review through two
different lenses, producing complementary (not cross-validated) findings.

**File-size convention** (built into the `architecture` profile's scope, every repo): code files
> 300 lines warrant scrutiny and > 600 lines **must** be split; a single SKILL.md / AGENTS.md /
CLAUDE.md > 100 lines warrants scrutiny — push mechanism into `reference/*` (progressive disclosure).

Sources fire on: `diff` = wave gate; `codebase` = time interval; `docs` = ≥N doc files changed;
`deps` = a lockfile changed. `architecture`/`docs`/`deps` run in **agent mode** with no diff
payload — reviewers explore the repo. `profileWeights`, `docsThreshold`, `codebaseIntervalMin`
all live in `.claude/sharp-review.json` (config file section above).

### Custom profiles

A repo can add its own review templates in `customProfiles` (array) without touching plugin code
— `pick-profile.js` merges them into the registry so they compete on weight like any built-in.
Each entry attaches its framing/scope to an existing `source` trigger (usually `codebase`, agent
mode):

```json
{
  "key": "arch-hygiene",          // required; unique (reusing a built-in key overrides it)
  "source": "codebase",           // required; a known trigger: diff | codebase | docs | deps
  "weight": 0.3,                  // default 0.1
  "mode": "agent",                // "agent" (default) | "review" | null (honor diff-manifest)
  "promptKind": "architecture",   // "architecture" (default, explore — no diff) | "diff"
  "framing": "…one-line intent…",
  "reviewScope": ["bullet a", "bullet b"],  // string or string[]; keep it TIGHT — verbose framing wastes reviewer attention
  "label": "整洁锐评"
}
```

Keep custom framings/scopes concise — low-signal instruction text degrades review quality.

## Dual review modes

`diff-manifest.js` picks the mode automatically from filtered diff size:

| Mode | Condition | Behavior |
|---|---|---|
| `review` | Filtered diff ≤ `inlineDiffLimit` chars | Full diff inlined into reviewer prompts — best signal |
| `agent` | Filtered diff > `inlineDiffLimit` chars | Manifest only (file table + hunk headers); reviewers explore via `git diff -- <path>` |
| `empty` | No reviewable files after filtering | Skill exits early — no review |

**Smart filtering** (both modes): lockfiles, minified/sourcemap, generated/vendored paths,
binary files, and pure renames (R100) are excluded so noise doesn't inflate diff size.

Config — `.claude/sharp-review.json` → `inlineDiffLimit` (chars, default 20000; chars not lines,
because chars track context-window cost).

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
