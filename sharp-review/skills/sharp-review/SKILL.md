---
name: sharp-review
description: Post-feature sharp review (锐评) —parallel reviewers, merge findings, sync task list
---

# Sharp Review (锐评)

Post-feature review: 2 of 3 reviewers, each JSON-Schema-constrained, cross-checked and merged into a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter. Normally invoked by the Stop hook once enough change accumulates (Wave Gate); `/sharp-review` runs it manually. Trigger thresholds, profile-weighting math, mode internals, and config keys → **`reference/profiles-and-modes.md`**.

## Execution mode (read first)

Review runs on git state, not the conversation — so offload it: **main loop dispatches one
`sharp-review:sharp-review` subagent** to run Steps 1–6 and return only the `Sharp review: <summary>`
line (pass it the hook's `firedSources`). Zero leakage into the main session; the worker uses
Step 3b (no `Workflow` tool in a subagent) and must not re-dispatch (recursion). The 3a
`Workflow` path is only for inline Generalized-Mode callers, never the standard trigger.

## Execution

### Step 0 — Resolve plugin root

`$env:CLAUDE_PLUGIN_ROOT` is set by Claude Code when the plugin is installed, but may not be inherited on some machines. Before running any sharp-review script, resolve it:

```powershell
if (-not $env:CLAUDE_PLUGIN_ROOT) {
  $fallback = "$env:TEMP/claude-sharp-review/plugin-root.txt"
  if (Test-Path $fallback) {
    $env:CLAUDE_PLUGIN_ROOT = (Get-Content $fallback -Raw).Trim()
  }
}
```

If still empty after the fallback, report `CLAUDE_PLUGIN_ROOT is not set and no fallback found` and stop.

### Step 1 — Pick profiles

Each run picks **2 profiles** via weighted random draw without replacement, filtered to those
whose source fired this round. The Stop hook records which trigger source(s) fired in
`reviewGate.firedSources`; pass them so the pick is constrained to eligible profiles. Capture
the JSON **array**:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/pick-profile.js" --sources diff,docs
```

```json
[
  { "key": "adversarial", "label": "adversarial review (对抗性审查)", "mode": null, "promptKind": "diff", "framing": "…", "reviewScope": "…" },
  { "key": "diff", "label": "diff review", "mode": null, "promptKind": "diff", "framing": null, "reviewScope": null }
]
```

If fewer than 2 profiles are eligible (e.g. `--sources codebase` → only `architecture`), the
array has a single element. Reviewer-to-profile assignment is **shuffled** — no profile is
predictably bound to a specific reviewer model.

Omit `--sources` for the full default rotation (manual run). Manual override: `--profile architecture` (returns single-element array). Selection is stateless (weights only). Profile table + weighting math + per-project `profileWeights` → `reference/profiles-and-modes.md`.

### Step 2 — Gather context

Diff-sourced profiles (`diff`/`security`/`adversarial`) need the diff payload; agent-mode profiles (`architecture`/`docs`/`deps`) explore the repo but still need `stats`/`range`/`seed` — so **always** run `diff-manifest.js` (the ONLY allowed diff source; never run raw `git diff` or paste diff text):

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js"                       # uncommitted vs HEAD (default)
node "$env:CLAUDE_PLUGIN_ROOT/scripts/diff-manifest.js" --range "main...HEAD" --path "src/components"
```

`--range`/`--path` scope the review. Capture the JSON output — it carries `mode`, `range`, `seed`, `stats`, and (mode-dependent) `diff` | `manifestText` + `excludedSummary`. Full payload schema → `reference/profiles-and-modes.md`.

### Step 3 — Run reviewers (fan-out)

One merge, two possible fan-out tools. The merge + render + write-back is identical (shared
`mergeFindings`/`renderReviewMarkdown` in `lib.mjs`, invoked by `post-review.js`). Pick the
branch by **how this skill is running**:

- **Standard trigger (you are the dispatched worker subagent) OR Codex** — you have no
  `Workflow` tool. Fan out reviewers yourself in parallel via the `Agent` tool / `spawn_agent`
  (or the takeover `call_model` MCP tool), collect each reviewer's raw `{ findings: [...] }`,
  and hand the **raw** results to `post-review.js --raw` (**Step 3b below**). This is the
  normal path. Do NOT merge or assign `SR-` ids yourself — the shared lib owns that so every
  host produces byte-identical output.
- **Inline in main loop (Generalized Mode external caller only)** — the `Workflow` tool is
  available; use it (3a) to fan out in a sandboxed VM, merge/render inline, and get back
  `{ reviewFile, markdown, merged, summary }`. The standard `/sharp-review` trigger never
  reaches this branch (it always runs as a worker subagent — see Execution mode at top).

#### Step 3a — Workflow (inline / generalized only)

If ALL profiles honor the diff manifest (all have `mode === null`) AND `mode === "empty"`: report in chat `Sharp review skipped: no reviewable changes after filtering (<excludedSummary>)` and stop. If at least one profile is agent-mode (`architecture`/`docs`/`deps`), proceed — agent-mode profiles explore the repo, not a diff.

Otherwise, pass the manifest fields and the **profiles array** from Step 1 into Workflow args:

```js
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/scripts/sharp-review-workflow.js",
  args: {
    date: "<YYYY-MM-DD today>",
    seed: result.seed,              // time-based; rotates reviewer pair per round
    mode: result.mode,              // fallback for profiles with mode===null
    profiles: [                     // from pick-profile.js output (Step 1)
      { key: "adversarial", label: "…", mode: null, promptKind: "diff", framing: "…", reviewScope: "…" },
      { key: "diff", label: "…", mode: null, promptKind: "diff", framing: null, reviewScope: null },
    ],
    range: result.range,
    path: result.path,              // only when --path was used
    stats: result.stats,
    diff: result.diff,              // only review mode (omit for architecture-only)
    manifestText: result.manifestText, // only agent diff mode (omit for architecture-only)
    excludedSummary: result.excludedSummary,
  }
})
```

Each active reviewer gets its own profile's framing/scope/promptKind/mode, assigned by
shuffled index (the shuffle happens in `pick-profile.js` so the order in the array IS the
shuffled assignment). The workflow picks 2 of 3 reviewers (`seed mod 3`) and pairs them
1:1 with the 2 profiles — two lenses, two reviewers, one round. Reviewer roster + finding
schema + per-mode prompt behavior → `reference/profiles-and-modes.md`.

#### Step 3b — Direct parallel fan-out (worker subagent / Codex — the normal path)

Same empty-diff gate as 3a. Fan out via `mcp__plugin_takeover_takeover__call_model`
(primary — direct API calls, no safety-classifier dependency) for each active reviewer;
fall back to the `Agent` tool (Claude Code) / `spawn_agent` (Codex) if takeover is
unavailable. Collect raw results and feed `post-review.js --raw`. Full procedure,
seed-mod-3 rotation, `raw.json` schema, and positional alignment →
**`reference/direct-fanout.md`**.

### Step 4 — Write memory entry & sync

**IMPORTANT on Windows**: Do NOT use Bash redirection (`>`) with Windows paths — Bash treats backslashes as escape characters and creates stray files in the wrong location. Instead, write temp files using the Write tool, then call post-review.js via PowerShell.

**From Codex / raw fan-out (3b)** — write the `raw.json` from Step 3b, then:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/post-review.js" --date <YYYY-MM-DD> --raw "$env:TEMP/claude-sharp-review/raw.json"
```

**From the Claude Workflow (3a)** — the workflow already merged/rendered, returning
`{ reviewFile, markdown, merged, summary }`. Write two temp files with the Write tool:
- `$env:TEMP/claude-sharp-review/findings.json` — contents: `result.merged` as JSON
- `$env:TEMP/claude-sharp-review/review.md` — contents: `result.markdown`

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/post-review.js" --date <YYYY-MM-DD> --findings "$env:TEMP/claude-sharp-review/findings.json" --markdown "$env:TEMP/claude-sharp-review/review.md"
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
