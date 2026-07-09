# Fabric Plugin — AGENTS.md

Multi-provider agent **session fabric**: any agent (Claude / Codex / …) invoking,
orchestrating, and handing off to models of any provider. Absorbed the former `takeover`
plugin — its policy (modes, prompts, handoff UX) is now the L1/L2 layers on fabric's one
call primitive. Dual-form: an importable library (`shared/`) and an MCP server
(`scripts/mcp-server.mjs`).

**First principle:** the atomic operation is `invoke(model, input, options) → output`.
"One task" is one `call`; "orchestrate many" is the caller making N calls — fan-out is the
orchestrator's job (the agent / a Workflow), never a tool's. So there is one call surface,
not a "single" tool and a "batch" tool.

Design memories: `.claude/memory/2026/07/07/harness-as-fabric.md`,
`.claude/memory/2026/07/08/persistent-sessions-and-takeover-merge.md`.

## Architecture — four layers

```
L3 ORCHESTRATION  the caller: agent calls the primitive N times / Workflow fan-out
                  (NOT a tool — "single vs many" is call count)
L2 ERGONOMICS     commands (/continue /models /handoff), the `takeover` handoff subagent
                  (50K context-gathering), result skills (verbatim, SAVED-path images)
L1 POLICY         scripts/lib (parse <command> flags, buildPrompt, trace, errors) +
                  scripts/codex (review, image) + prompts/ — mode dispatch matrix
L0 MECHANISM      engine/ (fabric-owned, canonical): providers routing · spawn-child ·
                  anthropic-http · codex/{app-server,task,session} · session registry ·
                  observe proxy. (shared/ now holds only cross-plugin generic utils)
```

## File Structure

```
fabric/
├── engine/                  L0 mechanism — FABRIC-OWNED canonical (edit here directly).
│   │                        Fabric-only since takeover was absorbed; no longer in shared/.
│   ├── providers.mjs        Provider registry/routing (single source of truth)
│   ├── spawn-child.mjs      Claude child engine: exe resolution, provider env, stream-json
│   ├── open-session.mjs     Persistent multi-turn claude/API child (stream-json)
│   ├── session.mjs          Provider-dispatching opener + in-process session registry
│   ├── anthropic-http.mjs   Raw Anthropic-compatible HTTP caller (retry + SSE)
│   ├── observe-{proxy,reader}.mjs  Observe proxy + capture reader
│   ├── mcp-rpc.mjs          JSON-RPC stdio transport for the MCP server
│   ├── codex/               app-server client · task · session · discovery
│   └── tests/               engine unit suites (node:test)
├── shared/                  Bundled generic utils only (spawn/lib/state/stamp/attention) —
│                            DO NOT edit; edit cc-market/shared/. engine/ imports ../shared/spawn.mjs
├── scripts/
│   ├── mcp-server.mjs       MCP stdio server: wires L1 policy onto L0
│   ├── lib.mjs + lib/       L1 policy: parse (<command> flags), config, spawn (claude
│   │                        wrapper), callers (codex/API adapters), trace, errors
│   └── codex/{review,image}.mjs  L1 codex policy: adversarial review · image gen/edit
├── prompts/{task,review}.md L1 system prompts (mode → prompt)
├── commands/                L2: continue.md · models.md · handoff.md
├── agents/takeover.md       L2: handoff subagent (context-gather → one call)
├── skills/                  L2: takeover-result (verbatim) · codex-image-result (SAVED paths)
├── tests/                   node:test suites
├── .claude/rules/           Injected every session (invariants only)
├── CLAUDE.md                Entry point → @AGENTS.md
└── AGENTS.md                This file
```

## MCP Server

`mcp-server.mjs` implements JSON-RPC 2.0 over stdin/stdout (line + Content-Length framed
transport — framed needed for Codex MCP startup). Tools:

| Tool | Input | Routes to |
|---|---|---|
| `call` | `prompt`, `provider?`, `model?`, `mode?` (task/review/agent/image-generate/image-edit), `write?`, `systemPrompt?`, `images?`, `observe?`, `passthroughAuth?`, `cwd?`, `runDir?`, `timeoutMs?` | The one primitive. `<command>` flags in `prompt` are authoritative. Dispatch = (provider bucket) × mode: codex → app-server (task/agent/review/image); native claude → `spawnClaudeP`; API → `callAnthropicAPI` (task/review) or `spawnClaudeP` (agent). `observe:true` (non-codex) forces the harness engine behind the proxy + jsonl capture. |
| `spawn_session` | `provider`, `model?`, `write?`, `cwd?`, `observe?` | `createSession()` → registers a live handle, returns `{id, provider, nativeId}` |
| `session_send` | `id`, `prompt` | `sendToSession()` → one turn, context retained |
| `session_close` | `id` | `closeSession()` → tears down the child |
| `list_sessions` | (none) | `listSessions()` |
| `list_providers` | (none) | `listModels()` |
| `resolve_model` | `provider`, `model` | `resolveModelFromId()` (native: no remapping) |
| `codex_status` | `codexPath?` | `checkCodexStatus()` |

Exported for testing: `TOOLS`, `handleToolCall`, `handleCall`, `handleRpcRequest`,
`encodeRpcMessage`, the dispatch maps. Handlers take injectable `deps` (`spawnChild`,
`createSession`, `sendToSession`, `closeSession`, `listSessions`) for hermetic tests.

### The `mode` dispatch matrix (L1 policy)

| mode | codex | claude (native) | API provider |
|---|---|---|---|
| task | app-server (`write`, images) | `claude -p` (own OAuth) | raw HTTP completion |
| agent | app-server | `claude -p` + harness | `claude -p` + provider env (NOT raw HTTP) |
| review | native `review/start` | task + `review.md` prompt | task + `review.md` prompt |
| image-generate / image-edit | app-server | — (ProviderError) | — |

### Persistent sessions — the server IS the daemon

`spawn_session` / `session_send` / `session_close` give an orchestrator a real multi-turn
child that retains context across discrete tool calls. The "handle-holding daemon" the
roadmap once called for turned out to need **no separate process**: an MCP stdio server is
already long-lived (it stays up for the whole host session), so it holds live session
handles in an in-process registry (`engine/session.mjs`) keyed by id. Both backends expose
the same `{ id, send, close }` surface:

- **codex** → `engine/codex/session.mjs` `openCodexSession` — one app-server thread,
  natively multi-turn (`thread/start` once, `turn/start` per send).
- **claude / API** → `engine/open-session.mjs` `openSession` — a long-lived `claude`
  stream-json child.

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
