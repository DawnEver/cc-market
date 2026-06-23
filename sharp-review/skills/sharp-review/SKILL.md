---
name: sharp-review
description: Post-feature sharp review (锐评) —parallel reviewers, merge findings, sync task list
---

# Sharp Review (锐评)

Post-feature review: 2 of 3 reviewers, each JSON-Schema-constrained, cross-checked and merged into a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter. Normally invoked by the Stop hook once enough change accumulates (Wave Gate); `/sharp-review` runs it manually. Trigger thresholds, profile-weighting math, mode internals, and config keys → **`reference/profiles-and-modes.md`**.

## Execution

### Step 1 — Pick profile

Each run rotates between review **profiles** (diff / architecture / security / docs / deps),
picked by a source-aware weighted draw. The Stop hook records which trigger source(s) fired in
`reviewGate.firedSources`; pass them so the pick is constrained to eligible profiles, and capture the JSON:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/pick-profile.js" --sources diff,docs
```

```json
{ "key": "diff", "label": "diff review", "mode": null, "promptKind": "diff", "framing": null, "reviewScope": null }
```

Omit `--sources` for the full default rotation (manual run). Manual override: `--profile architecture`. Selection is stateless (weights only). Profile table + weighting math + per-project `profileWeights` → `reference/profiles-and-modes.md`.

### Step 2 — Gather context

`diff`/`security` profiles need the diff payload; `architecture`/`docs`/`deps` run in agent mode and explore the repo, but still need `stats`/`range`/`seed` — so **always** run `diff-manifest.js` (the ONLY allowed diff source; never run raw `git diff` or paste diff text):

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js"                       # uncommitted vs HEAD (default)
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js" --range "main...HEAD" --path "src/components"
```

`--range`/`--path` scope the review. Capture the JSON output — it carries `mode`, `range`, `seed`, `stats`, and (mode-dependent) `diff` | `manifestText` + `excludedSummary`. Full payload schema → `reference/profiles-and-modes.md`.

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

The `architecture` profile forces agent mode and uses neither `diff` nor `manifestText` — `stats`/`range`/`seed` are still passed (the workflow requires `stats`). The workflow picks 2 of 3 reviewers (`seed mod 3`) and constrains each to the finding schema. Reviewer roster + finding schema + per-mode prompt behavior → `reference/profiles-and-modes.md`.

#### Step 3b — Codex (no Workflow tool): direct parallel fan-out

Same empty-diff gate as 3a. Fan out reviewers in parallel via `spawn_agent` / takeover
`call_model`, collect raw results, and feed `post-review.js --raw`. Full procedure,
seed-mod-3 rotation, `raw.json` schema, and positional alignment →
**`reference/codex-fan-out.md`**.

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

**Output in chat ONLY**: `Sharp review: <summary>`. Do NOT dump findings in chat — this report
step **is** the attention gate. By default findings go to the backlog (AI consumers like
`evolve` read them there; humans triage async via `todo`). Only when a human asks to **triage
now** do you route OPEN findings through the shared attention gate (`shared/attention.mjs`).
Consumer-aware routing detail → `reference/profiles-and-modes.md` § Attention boundary.

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
