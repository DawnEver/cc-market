---
name: sharp-review
description: Post-feature sharp review (锐评) — 3 parallel reviewers with schema enforcement, merge findings, sync task list
---

# Sharp Review (锐评)

Workflow-driven post-feature review. Three parallel reviewers each constrained by JSON Schema, then cross-checked and merged. Result is written as a single memory entry `.claude/memory/YYYY-MM-DD/sharp-review.md` with rem frontmatter.

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

The workflow launches 3 parallel reviewers, each with a JSON Schema that enforces:
- `severity`: HIGH | MEDIUM | LOW | INFO
- `file`: affected file path
- `summary`: one-line issue description
- `category`: Bug | Feature | Performance
- `module`: inferred from file path
- `status`: OPEN | FIXED
- `suggestion`: one-line fix

### Step 3 — Write memory entry & sync

The workflow returns `{ reviewFile, markdown, merged, summary }`. Write findings as a single memory entry:

```bash
# Write merged findings to temp JSON, markdown to temp file
# Then:
node ${CLAUDE_PLUGIN_ROOT}/scripts/post-review.js --date <YYYY-MM-DD> --findings <merged.json> --markdown <markdown.md>
```

This does everything: writes `.claude/memory/YYYY-MM-DD/sharp-review.md` with rem frontmatter, cross-links SR-IDs to related memory files, runs stamp-memory.js to index, and delegates to task-engine.js for tasks.md.

### Step 4 — Resolve findings

To mark a finding as fixed, edit the memory file directly: change `**Status:** OPEN` → `**Status:** FIXED`. Then re-run post-review.js to sync statuses to tasks.md.

### Step 5 — Report

**Output in chat ONLY**: `Sharp review: <summary>`

Do NOT dump findings in chat.

## Phase 2 — Task Audit

After the review:

1. Read `.claude/memory/tasks/tasks.md` — review open HIGH/MEDIUM bugs against code changed in this session. Mark any that are now resolved.
2. Flag stale items (> 90d untouched) with `[STALE]` or move to archive if confirmed fixed.
3. Check in-flight Codex tasks via `TaskGet` — do not mark feature complete until verified.

## Usage

Run `/sharp-review` after finishing a feature. No arguments needed.
