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

1. **Hook** classifies the session (none/once/multi)
2. **Skill** gathers git diff, launches 3 parallel reviewers via Workflow
3. **Workflow** merges findings, deduplicates, assigns IDs
4. **post-review.js** writes a single memory entry, cross-links SR-IDs, stamps index, delegates to rem engine
