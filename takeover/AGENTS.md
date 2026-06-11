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

```
takeover/
├── scripts/
│   ├── lib.mjs              Core: provider config, API callers, retry, flag parsing
│   ├── mcp-server.mjs       MCP stdio server (JSON-RPC): call_model + list_models + codex_status
│   └── codex/
│       ├── discovery.mjs    Codex binary detection
│       ├── app-server.mjs   JSON-RPC 2.0 client for codex app-server
│       ├── task.mjs         Task execution with streaming (replaces callCodexCompanion)
│       ├── review.mjs       Adversarial code review via review/start
│       └── image.mjs        Image gen/edit via codex exec --full-auto
├── agents/takeover.md       Subagent: context gathering + handoff
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
├── CLAUDE.md                Entry point → @AGENTS.md + @.claude/rules/*.md
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
