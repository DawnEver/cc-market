---
name: traceme
description: Personal observability for Claude Code — daily token/cost reports, tool usage, project stats
---

# TraceMe

Personal Claude Code observability — track your daily token usage, cost, tool usage, and project stats.

## Commands

### Report
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" report today
```

### Stats
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/traceme-cli.mjs" stats
```

## Output
Displays today's per-project breakdown: sessions, prompt count, token usage, cost, top expensive prompts, and tool/skill usage.
