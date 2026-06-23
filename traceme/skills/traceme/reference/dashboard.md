# Dashboard — Full Filter List

Generates an interactive HTML dashboard at `~/.claude/traceme/dashboard.html` and opens it.
Embeds the **last 90 days** of data and renders with **Apache ECharts via CDN** (needs internet
on first open).

## Interactive Controls

All filters work entirely in-browser — no CLI re-run needed:

- **Date range picker** — select start and end dates
- **Project filter** — multi-select from available projects
- **Device dimension** — toggle between all-devices (merged) and single-device view (when sync
  is set up)
- **Grouping** — switch between model / project / device / category
- **Calendar intensity** — toggle between tokens and cost
- **Cache read layer** — toggle `cache_read` overlay on trend charts

## Data Source Per View

- **Token / Cost / Session / Calendar / Trend views** — combine local live data with foreign
  devices' synced snapshots
- **Per-model, tool-category, skill, and "Elapsed" views** — local-device only (only
  tokens/cost/sessions are synced)

## Defaults & Conventions

- Calendar/trend default to *billable* tokens (`input+output+cache_creation`, excludes re-read
  cache)
- Tool-category chart keeps `subagent` (actual tokens) apart from MCP/plugin/builtin
  (`approx. result-bytes`, coarse estimate)
- "Elapsed" is gross wall-clock incl. idle

Run `rescan --all` once to backfill older sessions before opening the dashboard.
