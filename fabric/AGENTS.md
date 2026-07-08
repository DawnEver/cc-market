# Fabric Plugin — AGENTS.md

Multi-provider agent **session fabric**: the session-engine substrate for any agent
orchestrating child model sessions of any provider. Dual-form — an importable library
(`shared/`) and an MCP server (`scripts/mcp-server.mjs`). Takeover is the stateless
policy consumer of the same engines; fabric owns the substrate itself.

Design memory: `.claude/memory/2026/07/07/harness-as-fabric.md`.

## Architecture

```
orchestrator agent (claude / codex / …)
  → MCP: run_task(provider=deepseek, prompt="…")          one-shot fan-out
  → library: openSession({provider, observe})             persistent multi-turn
      → L1 engines: spawn-child (claude -p / stream-json)
                    anthropic-http (raw HTTP + SSE)
                    shared/codex/ (codex app-server — native, no proxy)
      → L1 observe-proxy: child speaks vanilla Anthropic HTTP,
        proxy owns endpoint/auth/model-alias, tees to runDir/http.jsonl
  → L0 providers.mjs: registry, vanilla/Foundry normalization, model aliases
```

## File Structure

```
fabric/
├── shared/                  Bundled engine layer (DO NOT edit here — edit cc-market/shared/)
│   ├── providers.mjs        L0 provider registry/routing (single source of truth)
│   ├── spawn-child.mjs      Claude child engine: exe resolution, provider env, stream-json
│   ├── open-session.mjs     Persistent multi-turn child session (library-level)
│   ├── anthropic-http.mjs   Raw Anthropic-compatible HTTP caller (retry + SSE)
│   ├── observe-proxy.mjs    Observe proxy: request buffered+remapped, SSE streamed
│   ├── observe-reader.mjs   Capture reader: loadRows / mainTurns / summarize
│   └── codex/               Codex app-server client + task runner + binary discovery
├── scripts/
│   └── mcp-server.mjs       MCP stdio server (JSON-RPC): list_providers / resolve_model / run_task
├── tests/                   mcp-server + observe-proxy tests (node:test)
├── .claude/rules/           Injected every session (invariants only)
├── CLAUDE.md                Entry point → @AGENTS.md
└── AGENTS.md                This file
```

## MCP Server

`mcp-server.mjs` implements JSON-RPC 2.0 over stdin/stdout (line transport; framed
encoding supported on send). Three tools:

| Tool | Input | Routes to |
|---|---|---|
| `list_providers` | (none) | `listModels()` |
| `resolve_model` | `provider`, `model` | `resolveModelFromId()` (native providers: no remapping) |
| `run_task` | `provider`, `prompt`, `model?`, `observe?`, `passthroughAuth?`, `write?`, `cwd?`, `runDir?`, `timeoutMs?` | codex: `runCodexTask()` (native app-server); others: `spawnChild()` via `claude -p`, optionally behind the observe proxy. `passthroughAuth?` — OAuth providers (claude) with `observe:true`: proxy forwards the child's own Authorization header instead of injecting a static key; defaults on for native claude |

Exported for testing: `TOOLS`, `handleToolCall`, `handleRpcRequest`, `encodeRpcMessage`.

Roadmap: `spawn_session` / `session_send` / `session_close` (persistent sessions over MCP)
needs a handle-holding daemon — the library primitive (`openSession`) already exists.

## Testing

```shell
node --test cc-market/fabric/tests/*.test.mjs
```

Pre-commit hook runs fabric tests when fabric files are staged (`shared/` changes fan out
to all plugins).

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic. Export functions for testability where needed.
- Version bumping is automatic — the repo-level `pre-push` hook bumps this plugin's
  `plugin.json` whenever `fabric/` changed in the push.
