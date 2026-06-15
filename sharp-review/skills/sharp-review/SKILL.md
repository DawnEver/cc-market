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

### Step 1 — Gather context

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

### Step 2 — Run workflow

If `mode === "empty"`: report in chat `Sharp review skipped: no reviewable changes after filtering (<excludedSummary>)` and stop. Do NOT invoke Workflow or write memory.

Otherwise, pass the JSON fields into Workflow args:

```js
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/scripts/sharp-review-workflow.js",
  args: {
    date: "<YYYY-MM-DD today>",
    seed: result.seed,              // time-based; rotates reviewer pair per round
    mode: result.mode,
    range: result.range,
    path: result.path,              // only when --path was used
    stats: result.stats,
    diff: result.diff,              // only in review mode
    manifestText: result.manifestText, // only in agent mode
    excludedSummary: result.excludedSummary,
  }
})
```

The workflow launches 2 of 3 reviewers, picked from a time-based seed (`seed mod 3`, combos AB/BC/AC) so multiple review rounds within the same day rotate the pair instead of repeating: Reviewer A (Codex), Reviewer B (DeepSeek), Reviewer C (Sonnet). Each is constrained by a JSON Schema that enforces:
- `severity`: HIGH | MEDIUM | LOW | INFO
- `file`: affected file path
- `summary`: one-line issue description
- `category`: Bug | Feature | Performance
- `module`: inferred from file path
- `status`: OPEN | FIXED
- `suggestion`: one-line fix

In **review mode**, the full diff is inlined into each reviewer's prompt via takeover `mode="review"`. In **agent mode**, only the manifest is sent; reviewers use `mode="agent"` to get full tool access and explore the codebase autonomously (`git diff <range> -- <path>`, read source files, trace call chains).

### Step 3 — Write memory entry & sync

The workflow returns `{ reviewFile, markdown, merged, summary }`. Write findings as a single memory entry.

**IMPORTANT on Windows**: Do NOT use Bash redirection (`>`) with Windows paths — Bash treats backslashes as escape characters and creates stray files in the wrong location. Instead, write temp files using the Write tool, then call post-review.js via PowerShell.

Use the Write tool to create two temp files (paths must use forward slashes or be resolved by Node):
- `$env:TEMP/claude-sharp-review/findings.json` — contents: `result.merged` as JSON
- `$env:TEMP/claude-sharp-review/review.md` — contents: `result.markdown`

Then run post-review.js via PowerShell:

```powershell
node "<CLAUDE_PLUGIN_ROOT>/scripts/post-review.js" --date <YYYY-MM-DD> --findings "$env:TEMP/claude-sharp-review/findings.json" --markdown "$env:TEMP/claude-sharp-review/review.md"
```

This writes `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter, then runs stamp-memory.js.

### Step 4 — Resolve findings

```bash
todo mark <SR-ID> fixed
```

This flips `**Status:** OPEN` → `FIXED` in `sharp-review.md` and re-derives the frontmatter — equivalent to hand-editing + `post-review.js --rescan`. (`todo` is the rem-owned CLI; sharp-review never calls `task-engine.js` directly.)

For the full file-ownership table (where findings, archives, and manual tasks live) → `reference/task-system.md`.

### Step 5 — Report

**Output in chat ONLY**: `Sharp review: <summary>`

Do NOT dump findings in chat.

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

The workflow engine supports arbitrary content review beyond code diffs. Callers configure reviewers, finding schemas, and review scope — the engine handles parallel fanout, dedup merge, and confidence tagging.

### Calling from another skill

```js
Workflow({
  scriptPath: "<path-to>/scripts/sharp-review-workflow.js",
  args: {
    date: "<YYYY-MM-DD>",
    contentType: "content",          // "code" (default) | "content"
    content: "<text to review>",      // required when contentType is "content"
    reviewScope: "<review dimensions>",  // overrides default code scope
    findingSchema: { ... },           // JSON Schema for findings (overrides default)
    reviewers: [                      // overrides default A/B/C
      { key: 'A', name: '...', provider: 'claude', model: 'sonnet' },
      { key: 'B', name: '...', provider: 'deepseek' },
    ],
    pickStrategy: "all",              // "seed-mod" (default, picks 2 via time seed) | "all" (uses all)
    dedupKeyFields: ["summary"],      // fields for dedup key (default: ["file", "summary"])
    idPrefix: "SR",                   // finding ID prefix (default: "SR")
  }
})
```

### Parameters

| Param | Default | Description |
|-------|---------|-------------|
| `contentType` | `"code"` | `"code"` for git diff (original behavior), `"content"` for arbitrary text |
| `content` | — | Review target text. Required when `contentType === "content"` |
| `reviewScope` | 5-dim code scope | Comma-separated review dimensions |
| `findingSchema` | Code schema | JSON Schema for a single finding. Engine wraps in `{ findings: [...] }` |
| `reviewers` | A/B/C | Array of `{ key, name, provider, model? }`. `key` maps to takeover provider routing |
| `pickStrategy` | `"seed-mod"` | `"seed-mod"` picks 2 of N from `args.seed` (time-based, falls back to day-of-month); `"all"` runs all reviewers |
| `dedupKeyFields` | `["file", "summary"]` | Which finding fields form the dedup key (lowercased, first 60 chars each) |
| `idPrefix` | `"SR"` | Prefix for finding IDs (`SR-20260610-001`, `CR-A-20260610-001`, etc.) |

### Return value

```json
{
  "reviewFile": ".claude/memory/2026/06/10/sharp-review.md",
  "markdown": "## Review 2026-06-10 (session) ...",
  "merged": [{ "id": "SR-20260610-001", "severity": "HIGH", ... }],
  "summary": "3 issues (2 high-confidence) → .claude/memory/..."
}
```

The caller is responsible for writing output — the engine returns structured data, not files. For code reviews, Step 3 of this skill writes memory via `post-review.js`. For content reviews, the caller handles pipeline integration.

### Example: ai-post 三方会审

ai-post's `/post-review` configures two identities (读者代理人 + 技术核查员), each with 2 models and custom finding schemas. Runs two workflow calls (one per identity) in parallel, then synthesizes cross-identity verdicts. See `ai-post/.claude/skills/post-review/SKILL.md`.
