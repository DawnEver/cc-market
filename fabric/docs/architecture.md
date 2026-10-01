# Fabric — Architecture Reference

Deep-dive detail behind `AGENTS.md`. Load this file when you need the file-structure map
or the full MCP tool surface. Dev-only reference — the entry-point mental model (4-layer
architecture, first principle) stays in `AGENTS.md`.

## File Structure

```
fabric/
├── engine/                  L0 mechanism — FABRIC-OWNED canonical (edit here directly).
│   │                        Fabric-only since takeover was absorbed; no longer in shared/.
│   ├── providers.mjs        Provider registry/routing (single source of truth)
│   ├── spawn-child.mjs      Claude child engine: exe resolution, provider env, stream-json
│   ├── anthropic-http.mjs   Raw Anthropic-compatible HTTP caller (retry + SSE)
│   ├── observe-{proxy,reader}.mjs  Observe proxy + capture reader
│   ├── mcp-rpc.mjs          JSON-RPC stdio transport for the MCP server
│   ├── fabric-config.mjs    The `fabric` config block (systemPromptFile, sessionDefaults)
│   ├── style-resolve.mjs    Output-style → built system-prompt file
│   └── codex/               app-server client · task · discovery
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
├── docs/                    Dev reference (this file)
├── CLAUDE.md                Entry point → @AGENTS.md
└── AGENTS.md                Entry point (slim — links here for detail)
```

## MCP Server

`mcp-server.mjs` implements JSON-RPC 2.0 over stdin/stdout (line + Content-Length framed
transport — framed needed for Codex MCP startup). Tools:

| Tool | Input | Routes to |
|---|---|---|
| `call` | `prompt`, `provider?`, `model?`, `mode?` (task/review/agent/image-generate/image-edit), `write?`, `systemPrompt?`, `images?`, `observe?`, `passthroughAuth?`, `cwd?`, `runDir?`, `timeoutMs?` | The one primitive. `<command>` flags in `prompt` are authoritative. Dispatch = (provider bucket) × mode: codex → app-server (task/agent/review/image); native claude → `spawnClaudeP`; API → `callAnthropicAPI` (task/review) or `spawnClaudeP` (agent). `observe:true` (non-codex) forces the harness engine behind the proxy + jsonl capture. |
| `fan_out` | `tasks[]` (`provider`, `prompt`, `id?`, `mode?`, `write?`, `model?`, `cwd?`), `synthesize?` | N `handleCall`s in parallel → compact JSON (per-task summary, est. tokens, duration) + optional deepseek synthesis |
| `list_providers` | (none) | `listModels()` |
| `resolve_model` | `provider`, `model` | `resolveModelFromId()` (native: no remapping) |
| `codex_status` | `codexPath?` | `checkCodexStatus()` |

Exported for testing: `TOOLS`, `handleToolCall`, `handleCall`, `handleFanOut`, `handleRpcRequest`,
`encodeRpcMessage`, the dispatch maps. Handlers take injectable `deps` (`spawnChild`) for
hermetic tests.

### The `mode` dispatch matrix (L1 policy)

| mode | codex | claude (native) | API provider |
|---|---|---|---|
| task | app-server (`write`, images) | `claude -p` (own OAuth) | raw HTTP completion |
| agent | app-server | `claude -p` + harness | `claude -p` + provider env (NOT raw HTTP) |
| review | native `review/start` | task + `review.md` prompt | task + `review.md` prompt |
| image-generate / image-edit | app-server | — (ProviderError) | — |

## Config

`engine/fabric-config.mjs` `loadFabricConfig()` reads the `fabric` block of
`claude_env_settings.json`: `sessionDefaults` (`{provider, model}` used when `call` omits a
provider) and `systemPromptFile` (claude/API platform prompt — a
`~/.claude/system-prompt/...` path resolved via the per-machine symlink setup.js creates;
**never a machine-specific OneDrive path**). `readRegistry` (providers.mjs) and
`loadFabricConfig` both deep-merge the machine-local `~/.claude/claude_env_settings.local.json`
over the shared file (override wins). Codex's platform prompt comes from `codex_config.toml`
`model_instructions_file = "~/.codex/system-prompt/codex-base.md"`. Cached by mtime (of both
the shared file AND the local overlay) AND a 2s TTL, because mtime alone has 1-second
granularity on Windows and a same-second edit would otherwise stay invisible to the
long-lived MCP server.
