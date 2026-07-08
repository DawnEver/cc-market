# Takeover Plugin — AGENTS.md

Multi-model AI orchestration via MCP. Routes tasks to Claude, Codex, DeepSeek, or any Anthropic-compatible API.

## Architecture

```
/takeover:continue "review this" --provider deepseek
  → Agent(takeover:takeover)
    → Gathers local context (git diff, file reads)
    → MCP tool: call_model(provider=deepseek, mode=task, userPrompt="...")
      → mcp-server.mjs reads claude_env_settings.json
      → Routes to: Anthropic API | Codex app-server | Native Claude CLI
      → Returns output verbatim via takeover-result skill

/takeover:continue --provider codex --review
  → Agent gathers git diff
    → MCP tool: call_model(provider=codex, mode=review, userPrompt="<diff>")
      → CodexAppServerClient → codex app-server → review/start (adversarial)
      → Returns findings verbatim
```

## File Structure

Takeover is a **policy layer**: the execution engines (claude child sessions,
raw Anthropic HTTP, codex app-server client) live in the bundled `shared/`
(canonical source: `cc-market/shared/`, shared with the fabric plugin). This
plugin shapes prompts, picks an engine per mode, and formats MCP results.

Note (intentional behavior): `provider=claude` now routes through the shared engine's
`buildChildEnv` → `loadProviderEnv('claude')`, which strips provider env keys
(`ANTHROPIC_BASE_URL`, auth tokens, etc.) from the inherited environment — the claude
child always direct-connects with its own OAuth rather than inheriting a gateway env.

```
takeover/
├── shared/                  Bundled engine layer (DO NOT edit here — edit cc-market/shared/)
│   ├── spawn-child.mjs      Claude child engine: exe resolution, provider env, stream-json, images
│   ├── anthropic-http.mjs   Raw Anthropic-compatible HTTP caller (retry + SSE)
│   ├── providers.mjs        Provider registry/routing (single source of truth)
│   ├── codex/               Codex app-server client + task runner + binary discovery
│   └── (rest of bundle)     attention.mjs, lib.mjs, observe-proxy.mjs, observe-reader.mjs,
│                            open-session.mjs, spawn.mjs, stamp.mjs, state.mjs — bundled with
│                            the full shared layer; not all are used by takeover directly
├── scripts/
│   ├── lib.mjs              Barrel: re-exports lib/* (+ shared codex discovery) so `./lib.mjs` import sites stay stable
│   ├── lib/                 Policy modules:
│   │   ├── config.mjs       Re-exports shared/providers.mjs (+ SCRIPT_DIR)
│   │   ├── errors.mjs       Error taxonomy (TakeoverError + subclasses)
│   │   ├── trace.mjs        TraceMe NDJSON emission + structured request logging
│   │   ├── spawn.mjs        spawnClaudeP: MCP-shape wrapper over shared spawn-child
│   │   ├── parse.mjs        Command-block flag parsing, prompt building, text extraction
│   │   └── callers.mjs      Codex companion wrapper; re-exports shared anthropic-http
│   ├── mcp-server.mjs       MCP stdio server (JSON-RPC): call_model (provider dispatch map) + list_models + codex_status
│   └── codex/               Takeover-only codex policy (client comes from shared/codex/)
│       ├── review.mjs       Adversarial code review via review/start
│       └── image.mjs        Image gen/edit via codex exec --full-auto
├── agents/takeover.md       Subagent: context gathering (50K char budget) + handoff
├── commands/
│   ├── continue.md          /takeover:continue (--review, --image, --image-edit)
│   ├── models.md            /takeover:models
│   └── summary.md           /takeover:summary
├── prompts/
│   ├── task.md              System prompt for task handoffs
│   └── review.md            Adversarial review system prompt
├── skills/
│   ├── takeover-result/     Result handling: return verbatim
│   └── codex-image-result/  Image output: present SAVED: paths
├── tests/
│   ├── lib.test.mjs         Provider config, model resolution, API, retry
│   ├── mcp-server.test.mjs  TOOLS schema, JSON-RPC, validation
│   ├── discovery.test.mjs   Codex binary discovery
│   ├── app-server.test.mjs  JSON-RPC client
│   ├── image.test.mjs       Image gen/edit
├── .claude/rules/           Injected every session (invariants only)
├── CLAUDE.md                Entry point → @AGENTS.md
└── AGENTS.md                This file
```

## Key Invariants

See `.claude/rules/invariants.md` (always-injected) for prompt delivery, retry logic, provider config, foundry mode, and MCP protocol constraints.

## Provider Config

Config shape and troubleshooting → `skills/takeover-result/reference/provider-config.md`.

## MCP Server

`mcp-server.mjs` implements JSON-RPC 2.0 over stdin/stdout. Exposes three tools:

| Tool | Input | Routes to |
|---|---|---|
| `call_model` | `provider`, `userPrompt`, `model?`, `mode?`, `write?`, `systemPrompt?` | `callAnthropicAPI` / `callCodexCompanion` (task) / `runCodexReview` / `handleImageEdit` / `handleGenerateImage` / `spawnClaudeP` |
| `list_models` | (none) | `listModels()` |
| `codex_status` | `codexPath?` | `checkCodexStatus()` |

Mode routing for `call_model`:
- `mode=task` (default, any provider) → codex: `callCodexCompanion()`; native claude: `spawnClaudeP()`; API: `callAnthropicAPI()`
- `mode=agent` (any provider) → codex: `callCodexCompanion()`; others: `spawnClaudeP()` (claude -p with provider env)
- `mode=review` → `runCodexReview()` (codex only, adversarial)
- `mode=image-generate` → `generateImage()` (codex only)
- `mode=image-edit` → `editImage()` (codex only)

Exported for testing: `TOOLS`, `handleToolCall`, `handleCallModel`, `send`.

## Testing

```shell
node --test cc-market/takeover/tests/*.test.mjs
```

Pre-commit hook runs all takeover tests via glob. `callAnthropicAPI` tests mock `globalThis.fetch`.

## Standard

- After changes, update README.md and this file if architecture/docs shift.
- Always add tests for new logic. Export functions for testability where needed.
- Version bumping is automatic — the repo-level `pre-push` hook bumps this plugin's `plugin.json` whenever `takeover/` changed in the push.
