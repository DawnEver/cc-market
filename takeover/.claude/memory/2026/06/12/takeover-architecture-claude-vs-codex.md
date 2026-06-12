---
name: takeover-architecture-claude-vs-codex
description: Why takeover uses claude -p (not interactive), how Codex integration works, and whether Claude can adopt Codex's approach
metadata:
  type: project
---

# Takeover Architecture: Claude vs Codex

## Claude path: `claude -p` (one-shot subprocess)

`spawnClaudeP()` in `lib.mjs` spawns `claude -p [--input-format stream-json]` as a child
process — one prompt in, one response out, then the process exits.

**Why `-p` not interactive `claude`:** The MCP server (`mcp-server.mjs`) runs as a
headless stdio child process — no TTY available. `-p` is the programmatic one-shot mode.

**Trade-offs:**
- No tool calling — even with `mode=agent`, it just sets different provider env vars on
  the `-p` subprocess. The spawned `claude` instance has no tool-execution loop.
- Native multimodal works via `stream-json` format — images passed as structured content
  blocks (base64 data URIs).
- Short prompts (<1000 chars, no images) go via command-line arg; large prompts/images
  go via piped stdin with `stream-json` format.

## Codex path: `codex app-server` (long-lived JSON-RPC)

`CodexAppServerClient` (`app-server.mjs`) spawns `codex app-server` as a persistent
child process, communicating via JSON-RPC 2.0 over stdin/stdout. The connection stays
alive for the entire turn.

**Flow (`task.mjs`):**
1. `initialize` — handshake with clientInfo, opt out of delta notifications
2. `thread/start` — create a thread with cwd
3. `turn/start` — send prompt + `tools: {disabled: true/false}` config
4. Listen for notifications: `item/completed` (streaming text), `turn/completed` (usage, done)
5. `shutdown` — close connection

**Key advantages over Claude path:**
- Native tool calling via `tools` parameter in `turn/start` — Codex can edit files
  (`--write`), run commands, etc.
- Streaming output via `item/completed` notifications
- Multi-turn conversations possible within one thread
- Native multimodal via `data:` URLs in content blocks (not base64-embedded, just URL refs)

**Singleton client (`withSharedClient`):** Uses a mutex lock (30s timeout) so concurrent
requests queue rather than spawning multiple app-server instances.

## Can Claude adopt Codex's approach?

**Not yet.** Claude Code has no `claude app-server` equivalent — no headless JSON-RPC
interface that supports multi-turn tool loops. `-p` is single-round only.

**Most viable improvement path:** Add a tool-execution loop to `callAnthropicAPI()`
(`lib.mjs:440`) for API-based providers (deepseek etc.). The raw API supports
`tool_use → tool_result` cycles — implement the loop in the MCP server:

```
while (response.stop_reason === "tool_use") {
  execute tool call (Read/Write/Grep/Bash within safety bounds)
  send tool_result back to API
}
```

This would give non-Claude providers true agent capabilities without touching Claude
Code internals.

**Why:** MCP subprocess has no TTY; `claude -p` is single-round; Codex's `app-server`
pattern is the right architecture but depends on a feature Claude doesn't expose yet.
