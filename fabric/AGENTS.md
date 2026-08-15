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

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File structure** map (every module, the console, `scripts/serve.*` flags) →
  `docs/architecture.md` § File Structure.
- **MCP server** full tool table + the `mode` dispatch matrix + "the server IS the daemon"
  → `docs/architecture.md` § MCP Server.
- **LAN node fabric** (TLS-PSK protocol, per-node tokens, ownership/trust, connection pool,
  async ack+poll send, `fabric` config block) → `docs/architecture.md` § LAN node fabric.
- **Dev invariants** (edit `engine/` not `shared/`, windowsHide, per-session serialization,
  atomic spawn admission, observe asymmetry) → `.claude/rules/invariants.md`.

## MCP Server — at a glance

`mcp-server.mjs` implements JSON-RPC 2.0 over stdio (line + Content-Length framed, needed
for Codex MCP startup). One `call` primitive (task/review/agent/image-*) + persistent
session tools (`spawn_session` / `session_send` / `session_view` / `attach_session` /
`session_compact` / `session_goal` / `session_close`) + fleet (`list_nodes`) + providers
(`list_providers` / `resolve_model` / `codex_status`). Full table and dispatch matrix →
`docs/architecture.md` § MCP Server.

## LAN node fabric — at a glance

Peers are **message-passing teammates**, never a filesystem you reach into. One node server
(`scripts/serve.*`, TLS-PSK, also starts the management console; `--no-console` for the
node alone) exposes `node/spawn|send|turn|view|compact|goal|close|status|ping`; the client
(`engine/node-client.mjs`) pools connections and returns uniform `{id, send, close}` handles,
so a remote session is indistinguishable from a local one above the opener. A remote `send()`
is async ack + poll (`node/turn`), so a long turn no longer trips the 120s deadline. Full
protocol / config → `docs/architecture.md` § LAN node fabric.

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
