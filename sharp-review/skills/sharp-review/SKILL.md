---
name: sharp-review
description: Post-feature sharp review (锐评) — 3 parallel reviewers with schema enforcement, merge findings, sync task list
---

# Sharp Review (锐评)

Workflow-driven post-feature review. Three parallel reviewers each constrained by JSON Schema, then cross-checked and merged. Findings are written to `.claude/sharp-review/YYYY-MM-DD.md` with stable IDs and synced to `.claude/memory/tasks/tasks.md`.

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

### Step 3 — Write findings

The workflow returns `{ reviewFile, markdown, merged, summary }`. Write `markdown` to the file:

1. Create `.claude/sharp-review/` if it doesn't exist
2. Append to `reviewFile`
3. Apply fixes for all confirmed findings immediately

### Step 4 — Sync task list & index memory

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/sync-tasks.js
```

This thin wrapper parses sharp-review findings and delegates to rem's task engine (`cc-market/rem/scripts/sync-tasks.js`), which creates individual memory entries for HIGH/MEDIUM findings in `.claude/memory/YYYY-MM-DD/SR-ID.md` with full frontmatter, enabling rem's touch/promote/eviction lifecycle.

Then index the new memory files:

```bash
node ${CLAUDE_PLUGIN_ROOT}/../rem/scripts/stamp-memory.js
```

Resolve findings when fixed:
```bash
node ${CLAUDE_PLUGIN_ROOT}/../rem/scripts/sync-tasks.js --resolve SR-YYYYMMDD-NNN ...
```

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
