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

For a fully interactive, graphical view, generate the HTML dashboard:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" dashboard            # Generate & open in browser
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" dashboard --no-open  # Write file only
```

It writes `~/.claude/traceme/dashboard.html` and opens it. The page embeds the **last 90 days**
of data and renders with **Apache ECharts (loaded from a CDN — needs internet on first open)**.
Everything is filtered in-browser, no CLI re-run: pick the **date range**, filter by one or more
**projects** and **devices** (all devices vs. a single device, when sync is set up), switch
grouping **by model / project / device / category**, toggle the calendar intensity between
**billable tokens and cost**, and toggle the **cache_read** layer.

Cross-device: the token/cost/session/calendar/trend views combine the local live DB with each
foreign device's synced snapshots. Only tokens/cost/session counts are synced — **per-model,
tool-category, and skill breakdowns plus "Elapsed" are local-device only** (those panels carry a
note and the basis/cache_read toggles appear only in single-local-device mode).

Honesty notes baked into the view: the calendar/trend default to *billable* tokens
(`input+output+cache_creation`) — re-read cache is excluded unless toggled, so idle big-context
sessions don't look huge; the tool-category chart keeps `subagent` (actual tokens) separate from
MCP/plugin/builtin (a coarse `≈ result-bytes` estimate — not comparable, no shared %); "Elapsed"
is gross wall-clock (includes idle), with sessions bucketed by their start day. Run
`traceme rescan --all` once to backfill older sessions, then re-run `dashboard`.

## Data Source

Token data uses the cross-device merged sync snapshot by default (all your machines). Session duration, skill usage, and model data are local-only (not synced). Pass `--local` to use local data throughout.

## Privacy

No prompt text is included in any section of the insights output.
