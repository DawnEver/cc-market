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

- `.claude/sharp-review/YYYY-MM-DD.md` — full review report with stable IDs
- `.claude/memory/tasks/tasks.md` — structured active task list
- `.claude/rules/MEMORY.md` — index entry for progressive disclosure

### Resolving Findings

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/sync-tasks.js --resolve SR-YYYYMMDD-NNN ...
```

Or check `[x]` in tasks.md — auto-promoted to resolved.txt on next sync.

## How It Works

1. **Hook** classifies the session (none/once/multi) using a Haiku classifier
2. **Skill** gathers git diff, launches 3 parallel reviewers via Workflow
3. **Workflow** merges findings, deduplicates, assigns IDs
4. **sync-tasks.js** bridges findings into structured task list with memory cross-references
