---
name: sharp-review
description: Post-feature sharp review (锐评) — 3 parallel reviewers with schema enforcement, merge findings, sync task list
---

# Sharp Review (锐评)

Workflow-driven post-feature review. Three parallel reviewers each constrained by JSON Schema, then cross-checked and merged. Result is written as a single memory entry `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter.

## Triggering (Wave Gate)

Reviews are gated by change accumulation, not per-session. The Stop hook (`sharp-review-hook.js`) diffs from the last-reviewed ref:

- **Wave 0** (new commit): triggers at ≥80 lines changed OR ≥4 files — catch issues early
- **Wave 1+** (same ref already reviewed): triggers at ≥300 lines changed OR ≥10 files — only re-trigger after substantial new changes
- Wave resets to 0 when HEAD moves to a new commit
- Skipped sessions keep accumulating — changes add up across stops until threshold met

Per-project threshold config in `.claude/.rem-state.json` → `reviewGate.thresholds`:
```json
{
  "wave0": { "lines": 300, "files": 5 },
  "wave1": { "lines": 800, "files": 15 }
}
```

## Execution

### Step 1 — Gather context

```bash
git diff HEAD~1..HEAD
```

Capture the full diff. If the branch has multiple commits, use `git diff main...HEAD` instead.

### Step 2 — Run workflow

Invoke the sharp-review workflow with the diff as args:

```js
Workflow({
  scriptPath: "${CLAUDE_PLUGIN_ROOT}/scripts/sharp-review-workflow.js",
  args: { diff: "<the git diff>", date: "<YYYY-MM-DD today>" }
})
```

The workflow launches 2 parallel reviewers for model diversity — randomly picked from 3 backends each session: Reviewer A (Codex adversarial review via takeover, provider=codex, mode=review), Reviewer B (DeepSeek via takeover, provider=deepseek), and Reviewer C (Sonnet via takeover, provider=deepseek, model=sonnet). Each is constrained by a JSON Schema that enforces:
- `severity`: HIGH | MEDIUM | LOW | INFO
- `file`: affected file path
- `summary`: one-line issue description
- `category`: Bug | Feature | Performance
- `module`: inferred from file path
- `status`: OPEN | FIXED
- `suggestion`: one-line fix

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

This writes `.claude/memory/YYYY/MM/DD/sharp-review.md` with rem frontmatter, runs stamp-memory.js, then archives resolved findings to `.claude/tasks/archive/YYYY/MM/DD.md`.

### Step 4 — Resolve findings

Edit the memory file directly: change `**Status:** OPEN` → `**Status:** FIXED`. Then run `post-review.js --rescan --date YYYY-MM-DD` to archive it.

### Step 5 — Report

**Output in chat ONLY**: `Sharp review: <summary>`

Do NOT dump findings in chat.

## Phase 2 — Task Audit

After the review:

1. Run `todo` — review open findings against code changed in this session. Mark resolved ones as FIXED.
2. Flag stale items (> 90d untouched) — `todo` report shows `⚠ stale` markers.
3. Check in-flight Codex tasks via `TaskGet` — do not mark feature complete until verified.

## Usage

Run `/sharp-review` after finishing a feature. No arguments needed.
