---
name: mcp-migration
description: Takeover plugin migrated from Bash heredoc to pure MCP server (v2.0.0)
metadata:
  type: project
---

# Pure MCP Migration (2026-06-03)

**Why:** The old Bash-based approach (`companion.mjs` launched via `node ... <<'PROMPT'`) was only usable from Skill context. Workflow agents couldn't invoke it. Moving to an MCP stdio server lets Workflow agents call external models (DeepSeek, Codex) via `mcp__plugin_takeover_takeover__call_model`.

**How to apply:** The takeover plugin is v2.0.0+. It MUST have its MCP server registered in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "takeover": {
      "command": "node",
      "args": ["<plugin-root>/scripts/mcp-server.mjs"]
    }
  }
}
```

Without MCP registration, `/takeover:continue` and `/takeover:plan` will fail — the agent now calls MCP tools, not a Bash heredoc.

## Architecture Change

| Component | Before | After |
|-----------|--------|-------|
| Entry point | `scripts/companion.mjs` (CLI, stdin heredoc) | `scripts/mcp-server.mjs` (MCP stdio server) |
| Core library | `scripts/lib.mjs` (unchanged) | `scripts/lib.mjs` (same file, dead code removed) |
| Agent | `tools: Bash` → `node companion.mjs ...` | `tools: mcp__...__call_model, mcp__...__list_models` |
| Prompt delivery | Shell heredoc, escape concerns | JSON-RPC, no escape issues |

## MCP Tools

- `call_model(provider, model, mode?, systemPrompt?, write?, userPrompt)` → text
- `list_models()` → text (provider list)

## Dead Code Removed

- `companion.mjs` (96 lines) — replaced by mcp-server.mjs
- `parseArgs()` (33 lines) — only caller was companion.mjs
- `readStdin()` (4 lines) — only caller was companion.mjs
- Tests renamed: `companion.test.mjs` → `lib.test.mjs` (27 tests pass)

## Files Changed
- `scripts/mcp-server.mjs` (new, 208 lines)
- `scripts/companion.mjs` (deleted)
- `scripts/lib.mjs` (dead code removed, listModels fixed)
- `agents/takeover.md` (Bash → MCP tools)
- `commands/{continue,plan,models}.md` (updated allowed-tools)
- `skills/takeover-runtime/SKILL.md` (Bash contract → MCP contract)
- `skills/takeover-result/SKILL.md` (stale language fixed)
- `tests/companion.test.mjs` → `tests/lib.test.mjs` (renamed, dead tests removed)
- `README.md`, `.claude-plugin/plugin.json` (docs + v2.0.0)
