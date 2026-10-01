# Fabric Plugin — AGENTS.md

Multi-provider agent **fabric**: any agent (Claude / Codex / …) invoking,
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
                  anthropic-http · codex/{app-server,task} · observe proxy.
                  (shared/ now holds only cross-plugin generic utils)
```

## Orientation

Progressive disclosure — this file is the entry point; load `docs/architecture.md` for the
deep detail when a task reaches into that area.

- **File structure** map (every module) →
  `docs/architecture.md` § File Structure.
- **MCP server** full tool table + the `mode` dispatch matrix → `docs/architecture.md` § MCP Server.
- **Dev invariants** (edit `engine/` not `shared/`, windowsHide, observe asymmetry,
  codex stays native) → `.claude/rules/invariants.md`.

## MCP Server — at a glance

`mcp-server.mjs` implements JSON-RPC 2.0 over stdio (line + Content-Length framed, needed
for Codex MCP startup). One `call` primitive (task/review/agent/image-*) + `fan_out` (parallel calls) +
providers (`list_providers` / `resolve_model` / `codex_status`). Full table and dispatch matrix →
`docs/architecture.md` § MCP Server.

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
