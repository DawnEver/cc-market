# Sharp Review (锐评)

Post-feature code review with 3 independent AI reviewers. Each reviewer is constrained by JSON Schema; findings are cross-checked, merged, and synced to a structured task list.

## Install

Enable the plugin in `claude_settings.json`:

```json
{
  "enabledPlugins": {
    "sharp-review@cc-market": true
  }
}
```

Then run setup to symlink:

```bash
node scripts/setup/setup.js
```

## Usage

Run `/sharp-review` after finishing a feature. The Stop hook automatically classifies review depth and triggers the skill when appropriate.

### Modes

| Mode | Trigger | Reviewers |
|---|---|---|
| `none` | Trivial/doc-only tasks | 0 (skipped) |
| `once` | Moderate code changes | 1 pass |
| `multi` | Complex/risky changes | 3 parallel + merge |

## Output

- `.claude/memory/YYYY/MM/DD/sharp-review.md` — single memory entry per session with rem frontmatter
- `.claude/memory/tasks/tasks.md` — structured active task list
- `.claude/rules/MEMORY.md` — one index entry per session

### Resolving Findings

Edit the memory file directly: change `**Status:** OPEN` → `**Status:** FIXED`. Then rescan:

```bash
node cc-market/sharp-review/scripts/post-review.js --date YYYY-MM-DD --rescan
```

## How It Works

1. **Wave Gate** checks accumulated changes against thresholds (see below). Skips if below — changes keep accumulating across sessions.
2. **Hook** classifies the session (none/once/multi) when gate passes
3. **Skill** gathers git diff, launches 3 parallel reviewers via Workflow
4. **Workflow** merges findings, deduplicates, assigns IDs
5. **post-review.js** writes a single memory entry, cross-links SR-IDs, stamps index, delegates to rem engine

### Wave Gate

Reviews are gated by accumulated code changes, not per-session. This prevents triggering a review every time you stop, and auto-resets when you move to a new commit.

| Wave | When | Threshold | Purpose |
|---|---|---|---|
| 0 | New commit / first review | 80 lines or 4 files | Catch issues early on fresh code |
| 1+ | Same ref already reviewed | 300 lines or 10 files | Only re-trigger after substantial new changes |

When a session is skipped (below threshold), the reference point is preserved — changes add up across multiple sessions until the threshold is met. Once triggered, `lastReviewRef` moves to HEAD and the wave increments. Wave resets to 0 automatically when HEAD moves to a new commit.

**Per-project configuration** — add to `.claude/.rem-state.json`:
```json
{
  "reviewGate": {
    "thresholds": {
      "wave0": { "lines": 80, "files": 4 },
      "wave1": { "lines": 300, "files": 10 }
    }
  }
}
```
Omit to use defaults shown above. Override only the fields you want to change.
