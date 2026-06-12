---
name: traceme:insights
description: Multi-day trend analysis — token consumption, session time, and skill usage rankings across projects
---

# TraceMe Insights

Analyze token trends, time distribution, and skill usage across your projects over multiple days.

## Commands

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" insights                 # Last 7 days (cross-device)
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" insights --day           # Today only
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" insights --month         # Last 30 days
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" insights --days 14       # Explicit N days
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" insights --local         # Local DB only
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" insights --project NAME  # Filter to project
```

## Output Sections

1. **Quick Stats** — days analyzed, projects, sessions, prompts, tokens, cost, session time, skills
2. **Token Consumption by Project** — per-day per-project token table with totals
3. **Time Consumption by Project** — session count, total and average duration (zombie sessions excluded)
4. **Skill Usage Rankings** — ranked table with bar chart; per-project breakdown when multiple projects
5. **Model Usage** — per-model calls, tokens, cost (local device only)

## Visual Dashboard

For an interactive, graphical view of the same multi-day data, generate the HTML dashboard:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" dashboard --days 30  # Generate & open in browser
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" dashboard --no-open  # Write file only
```

It writes a self-contained page to `~/.claude/traceme/dashboard.html` and opens it — a
model-usage calendar heatmap, a tokens-per-day-by-model curve, and a Plugins/Subagents/MCPs
token breakdown, plus model/project/skill tables. Click **Refresh** after re-running the
command to see fresh data. Run `traceme rescan --all` once first to backfill the category
breakdown for older sessions.

## Data Source

Token data uses the cross-device merged sync snapshot by default (all your machines). Session duration, skill usage, and model data are local-only (not synced). Pass `--local` to use local data throughout.

## Privacy

No prompt text is included in any section of the insights output.
