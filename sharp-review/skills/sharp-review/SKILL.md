---
name: sharp-review
description: Post-feature sharp review (锐评) —parallel reviewers, merge findings, sync task list
---

# Sharp Review (锐评)

Workflow-driven post-feature review. multiple reviewers, each constrained by JSON Schema, then cross-checked and merged. Result is written as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter.

## Triggering (Wave Gate)

Reviews are gated by change accumulation, not per-session. The Stop hook (`sharp-review-hook.js`) diffs from the last-reviewed ref:

- **Wave 0** (new commit): triggers at ≥300 lines changed OR ≥5 files — catch issues early
- **Wave 1+** (same ref already reviewed): triggers at ≥1000 lines changed OR ≥15 files — only re-trigger after substantial new changes
- Wave resets to 0 when HEAD moves to a new commit
- Skipped sessions keep accumulating — changes add up across stops until threshold met

Per-project threshold config in `.claude/.rem-state.json` → `reviewGate.thresholds`:
```json
{
  "wave0": { "lines": 300, "files": 5 },
  "wave1": { "lines": 1000, "files": 15 }
}
```

## Dual Review Modes

Sharp review operates in one of two modes, determined automatically by `diff-manifest.js` based on filtered diff size:

| Mode | Condition | Behavior |
|---|---|---|
| `review` | Filtered diff ≤ `inlineDiffLimit` chars | Full diff inlined into reviewer prompts — best signal quality |
| `agent` | Filtered diff > `inlineDiffLimit` chars | Manifest only (file table + hunk headers); reviewers explore autonomously via `git diff -- <path>` |
| `empty` | No reviewable files after filtering | Skill exits early — no review produced |

**Smart filtering** applies in both modes: lockfiles, minified/sourcemap files, generated/vendored paths, binary files, and pure renames (R100) are automatically excluded. This prevents noise from inflating the diff size and wasting reviewer attention.

Per-project config in `.claude/.rem-state.json` → `reviewGate.inlineDiffLimit` (chars, default 20000):
```json
{
  "reviewGate": {
    "inlineDiffLimit": 20000
  }
}
```
Units are **chars** (not lines) because chars track actual context window cost.

## Execution

### Step 1 — Pick profile

Each run rotates between review **profiles** (templates), chosen probabilistically. Profile
selection is **source-aware**: the Stop hook records which trigger source(s) fired in
`reviewGate.firedSources` (e.g. `["diff"]`, `["docs"]`). Pass them to `pick-profile.js` via
`--sources` so the pick is constrained to profiles whose source fired; capture its JSON:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/pick-profile.js" --sources diff,docs
```

```json
{ "key": "diff", "label": "diff review", "mode": null, "promptKind": "diff", "framing": null, "reviewScope": null }
```

If `firedSources` is absent (manual run), omit `--sources` for the full default rotation.
Manual override (no weighting): `pick-profile.js --profile architecture`. Selection is
stateless — weights only, no persisted rotation index. Per-project tuning — set weights in
`.claude/.rem-state.json`: `{ "reviewGate": { "profileWeights": { "diff": 0.6, "architecture": 0.2 } } }`.

#### Review profiles & sources

A *profile* is the unit of selection; a *source* is just the named trigger a profile reacts to
(diff and security share the `diff` trigger). There is **no pick-source-then-profile two-step** —
selection is a single **global** weighted draw over the profiles whose source fired this round.
Provider selection is unaffected — profiles never bind a provider.

| Profile | Source | Weight | Mode | Reviews |
|---|---|---|---|---|
| `diff` | `diff` | 0.6 | honors diff-manifest | the git diff — bugs & cleanup (default) |
| `architecture` (架构锐评) | `codebase` | 0.2 | agent | whole codebase architecture |
| `security` (安全锐评) | `diff` | 0.05 | honors diff-manifest | the diff for security vulnerabilities |
| `docs` (文档锐评) | `docs` | 0.1 | agent | docs vs. current code |
| `deps` (依赖锐评) | `deps` | 0.05 | agent | dependency risk (CVEs, licenses) |

Default weights sum to 1.0 and are **global probabilities** — across reviews each profile runs at
roughly its weight. A profile is only *eligible* when its source fired; the weight of any profile
whose source is cold this round (its "orphan mass") folds into the catch-all `diff` review, so
each eligible specialist keeps its **exact global share** and `diff` absorbs the slack (its
effective rate rises above 0.6 when specialists are idle). If `diff` itself is cold (e.g. a
doc-only change, so only the `docs` source fired), the orphan mass spreads across whatever is
eligible. Set a weight to 0 in `profileWeights` to opt a profile out. Sources fire on: `diff` = wave gate;
`codebase` = time interval; `docs` = ≥N doc files changed; `deps` = a lockfile changed.
`architecture`/`docs`/`deps` run in **agent mode** with no diff payload — reviewers explore the
repo. Source config (`docsThreshold`, `codebaseIntervalMin`) lives under `reviewGate` in
`.claude/.rem-state.json`.

### Step 2 — Gather context

For the **active profile's source**: the `diff`/`security` profiles run `diff-manifest.js`
(below) for the diff payload. The `architecture`/`docs`/`deps` profiles run in agent mode with
NO diff payload — their reviewers explore the repo directly (read source/docs, `git diff`,
inspect lockfiles); skip diff-manifest for them, but still pass `stats`/`range`/`seed` (the
workflow requires `stats`, so run diff-manifest to obtain them even when its `diff` is unused).

Run `diff-manifest.js` — the ONLY allowed diff payload. Never run raw `git diff` or paste diff text into context.

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js"
```

By default, reviews uncommitted changes (staged + unstaged vs HEAD). If the user specified a range or path filter, pass it through:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js" --range "main...HEAD"
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js" --path "src/components"
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js" --range "main...HEAD" --path "src/components"
```

`--path` restricts the review to a subfolder or file — only changes under that path are included. Combine with `--range` to review a specific module's history.

Capture the JSON output. The script produces a size-bounded payload — each field is construction-guaranteed to stay under safe limits:
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

### Step 3 — Run reviewers (host-adaptive fan-out)

Two hosts, one merge. The reviewer fan-out tool differs by host; the merge + render +
write-back is identical (shared `mergeFindings`/`renderReviewMarkdown` in `lib.mjs`, invoked
by `post-review.js`). Pick the branch for the host you are running under:

- **Claude Code** — use the `Workflow` tool (3a below). It fans out reviewers in a sandboxed
  VM, merges/renders inline, and returns `{ reviewFile, markdown, merged, summary }`.
- **Codex (or any host without the `Workflow` tool)** — fan out reviewers yourself in
  parallel via `spawn_agent` (or the takeover `call_model` MCP tool), collect each reviewer's
  raw `{ findings: [...] }`, and hand the **raw** results to `post-review.js --raw` (3b below),
  which runs the same merge/render. Do NOT merge or assign `SR-` ids yourself — the shared lib
  owns that so both hosts produce byte-identical output.

#### Step 3a — Claude Code: Workflow

If the profile honors the diff manifest (`profile.mode === null`, i.e. `diff`/`security`) AND `mode === "empty"`: report in chat `Sharp review skipped: no reviewable changes after filtering (<excludedSummary>)` and stop. Do NOT invoke Workflow or write memory. (Agent-mode profiles — `architecture`/`docs`/`deps` — ignore empty: they explore the repo, not a diff, so always proceed for them.)

Otherwise, pass the JSON fields into Workflow args, layering the profile on top:

```js
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/scripts/sharp-review-workflow.js",
  args: {
    date: "<YYYY-MM-DD today>",
    seed: result.seed,              // time-based; rotates reviewer pair per round
    mode: profile.mode || result.mode,   // architecture forces "agent"
    promptKind: profile.promptKind,      // "diff" | "architecture"
    framing: profile.framing,            // profile-specific prompt intro (null for diff)
    profileLabel: profile.label,         // shown in the memory heading
    reviewScope: profile.reviewScope,    // pass only when non-null (else workflow default)
    range: result.range,
    path: result.path,              // only when --path was used
    stats: result.stats,
    diff: result.diff,              // only review mode (omit for architecture)
    manifestText: result.manifestText, // only agent diff mode (omit for architecture)
    excludedSummary: result.excludedSummary,
  }
})
```

The `architecture` profile forces agent mode and uses neither `diff` nor `manifestText` — its reviewers explore the repo from scratch. `stats`/`range`/`seed` from diff-manifest are still passed (the workflow requires `stats`).

The workflow launches 2 of 3 reviewers, picked from a time-based seed (`seed mod 3`, combos AB/AC/BC) so multiple review rounds within the same day rotate the pair instead of repeating: Reviewer A (Codex), Reviewer B (DeepSeek), Reviewer C (Opus). Each is constrained by a JSON Schema that enforces:
- `severity`: HIGH | MEDIUM | LOW | INFO
- `file`: affected file path
- `summary`: one-line issue description
- `category`: Bug | Feature | Performance
- `status`: OPEN | FIXED
- `suggestion`: one-line fix

In **review mode**, the full diff is inlined into each reviewer's prompt via takeover `mode="review"`. In **agent mode**, only the manifest is sent; reviewers use `mode="agent"` to get full tool access and explore the codebase autonomously (`git diff <range> -- <path>`, read source files, trace call chains).

#### Step 3b — Codex (no Workflow tool): direct parallel fan-out

Same gate as 3a: if the profile honors the diff manifest and `mode === "empty"`, report
`Sharp review skipped: …` and stop. Otherwise:

1. Pick the active reviewer pair the same way the workflow does — `seed mod 3` over
   `[A:Codex, B:DeepSeek, C:Opus]` (combos AB/AC/BC) — using `result.seed`.
2. Build each reviewer's prompt from the same scope/diff/manifest payload (Step 2) and fan
   them out **in parallel** — `spawn_agent` one worker per reviewer, or the takeover
   `call_model` MCP tool (`provider="codex"|"deepseek"|"claude"`, `mode="review"|"agent"`).
   Each reviewer must return ONLY `{ "findings": [...] }` matching the schema in Step 3a.
3. Collect the raw per-reviewer results into a `raw.json` (use the Write tool):

   ```json
   {
     "reviewers": [{"key":"A","name":"Codex"},{"key":"B","name":"DeepSeek"},{"key":"C","name":"Opus"}],
     "active":    [{"key":"A","name":"Codex"},{"key":"B","name":"DeepSeek"}],
     "profileLabel": "diff review",
     "rawResults": [ {"findings":[...]}, {"findings":[...]} ]
   }
   ```
   `rawResults[i]` aligns positionally with `active[i]`; a failed reviewer is `null`.

4. Hand it to `post-review.js --raw` (Step 4) — it runs the shared merge/render and writes
   the memory entry. No client-side merge or `SR-` id assignment.

### Step 4 — Write memory entry & sync

**IMPORTANT on Windows**: Do NOT use Bash redirection (`>`) with Windows paths — Bash treats backslashes as escape characters and creates stray files in the wrong location. Instead, write temp files using the Write tool, then call post-review.js via PowerShell.

**From Codex / raw fan-out (3b)** — write the `raw.json` from Step 3b, then:

```powershell
node "<CLAUDE_PLUGIN_ROOT>/scripts/post-review.js" --date <YYYY-MM-DD> --raw "$env:TEMP/claude-sharp-review/raw.json"
```

**From the Claude Workflow (3a)** — the workflow already merged/rendered, returning
`{ reviewFile, markdown, merged, summary }`. Write two temp files with the Write tool:
- `$env:TEMP/claude-sharp-review/findings.json` — contents: `result.merged` as JSON
- `$env:TEMP/claude-sharp-review/review.md` — contents: `result.markdown`

```powershell
node "<CLAUDE_PLUGIN_ROOT>/scripts/post-review.js" --date <YYYY-MM-DD> --findings "$env:TEMP/claude-sharp-review/findings.json" --markdown "$env:TEMP/claude-sharp-review/review.md"
```

Either form writes `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter, then runs stamp-memory.js.

### Step 5 — Resolve findings

```bash
todo mark <SR-ID> fixed
```

This flips `**Status:** OPEN` → `FIXED` in `sharp-review.md` and re-derives the frontmatter — equivalent to hand-editing + `post-review.js --rescan`. (`todo` is the rem-owned CLI; sharp-review never calls `task-engine.js` directly.)

For the full file-ownership table (where findings, archives, and manual tasks live) → `reference/task-system.md`.

### Step 6 — Report

**Output in chat ONLY**: `Sharp review: <summary>`

Do NOT dump findings in chat.

#### Attention boundary (consumer-aware)

This report step **is** the attention gate for sharp-review, and the skill is already
consumer-aware by construction:

- **AI consumer** (e.g. `evolve` calling this workflow, or any parent orchestrator): consumes
  the returned `{ merged, markdown, summary }` programmatically. The skill **never prompts** —
  there is no human attention to protect, so no gate is needed. This is the default and the
  reason findings go to backlog instead of chat.
- **Human consumer**: findings are written to the `sharp-review.md` backlog for *async* triage
  via `todo`, deliberately kept out of chat so a review never floods your attention. Only the
  one-line `summary` reaches you.

When a human explicitly wants to **triage now** (not later via `todo`), route the OPEN findings
through the shared attention gate (`shared/attention.mjs`) instead of reading them all:
`route(items, { consumer: 'human' })` compresses to *what you must decide / the consequence of
not deciding*, coalesces into a single `AskUserQuestion` (≤4, highest-severity first), and
silently defers the low-stakes rest to the backlog. Map each finding to a gate item
(`{ id, title: summary, detail: 'file: summary', stakes: severity, reversible: !arch,
default: 'defer', options: [Fix now / Won't-fix / Defer] }`). For an AI consumer pass
`consumer: 'ai'` and it resolves by policy with no prompt.

## Phase 2 — Task Audit

After the review:

1. Run `todo` — review open findings against code changed in this session. Items the review touched show `⚠ likely-resolved`.
2. For each finding you fixed AND verified (tests pass / behavior confirmed) in this session, run `todo mark <SR-ID> fixed` immediately — do not leave it for the next review to rediscover. Do NOT mark a finding fixed if you only changed the file without confirming the issue is resolved.
3. Flag stale items (> 90d untouched) — `todo` report shows `⚠ stale` markers.
4. Check in-flight Codex tasks via `TaskGet` — do not mark feature complete until verified.

## Usage

Run `/sharp-review` after finishing a feature. No arguments needed.

---

## Generalized Mode (Content Review)

The workflow engine also supports arbitrary **content** review beyond code diffs — callers
configure reviewers, finding schemas, and review scope; the engine handles parallel fanout, dedup
merge, and confidence tagging. The standard `/sharp-review` flow never needs this. External
callers (e.g. ai-post 三方会审): see **`reference/generalized-mode.md`** for the full Workflow
args, parameter table, return value, and example.
