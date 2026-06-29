---
name: sharp-review
description: Post-feature sharp review (锐评) —parallel reviewers, merge findings, sync task list
---

# Sharp Review (锐评)

Post-feature review: 2 of 3 reviewers, each JSON-Schema-constrained, cross-checked and merged into a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter. Normally invoked by the Stop hook once enough change accumulates (Wave Gate); `/sharp-review` runs it manually. Trigger thresholds, profile-weighting math, mode internals, and config keys → **`reference/profiles-and-modes.md`**.

## Execution mode (read first)

Review runs on git state, not the conversation — so offload it: **main loop dispatches one
`sharp-review:sharp-review` subagent** to run Steps 1–6 and return only the `Sharp review: <summary>`
line (pass it the hook's `firedSources`). Zero leakage into the main session; the worker fans
out reviewers directly (Step 3) and must not re-dispatch (recursion).

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

**Empty-diff gate:** If ALL profiles honor the diff manifest (all have `mode === null`) AND `mode === "empty"`: report in chat `Sharp review skipped: no reviewable changes after filtering (<excludedSummary>)` and stop. If at least one profile is agent-mode (`architecture`/`docs`/`deps`), proceed — agent-mode profiles explore the repo, not a diff.

Otherwise fan out via `mcp__plugin_takeover_takeover__call_model` (primary — direct API
calls, no safety-classifier dependency) for each active reviewer; fall back to the `Agent`
tool (Claude Code) / `spawn_agent` (Codex) if takeover is unavailable. **Prerequisite:** the
dispatched `sharp-review:sharp-review` worker must list `mcp__plugin_takeover_takeover__call_model`
in its `tools:` allowlist — an explicit allowlist excludes everything unnamed, so omitting it
silently forces every reviewer onto the flaky `Agent` fallback (the cause of past all-reviewers-
FAILED runs). Collect each reviewer's raw `{ findings: [...] }` and feed the **raw** results to
`post-review.js --raw`. deepseek/claude return JSON directly; **codex review-mode returns prose**
— normalize per `reference/direct-fanout.md` § Codex prose normalization (which also defines the
single `[]`-vs-`null` rule). Do NOT merge or assign `SR-` ids yourself — the shared
`mergeFindings`/`renderReviewMarkdown` in `lib.mjs` (invoked by `post-review.js`) owns that, so
every host produces byte-identical output. Full procedure, seed-mod-3 rotation, `raw.json`
schema, and positional alignment → **`reference/direct-fanout.md`**.

### Step 4 — Write memory entry & sync

**IMPORTANT on Windows**: Do NOT use Bash redirection (`>`) with Windows paths — Bash treats backslashes as escape characters and creates stray files in the wrong location. Instead, write the `raw.json` from Step 3 using the Write tool, then call post-review.js via PowerShell:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/post-review.js" --date <YYYY-MM-DD> --raw "$env:TEMP/claude-sharp-review/raw.json"
```

This writes `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter, then runs stamp-memory.js.

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
