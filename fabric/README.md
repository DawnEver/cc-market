# Fabric

Multi-provider agent **fabric** — the shared layer for any agent (`claude` / `codex` / …)
invoking and orchestrating one-shot child agents of any provider. The orchestrator and its
children can each be any provider. Dual-form: an importable library **and** an MCP
server.

## Install

```shell
/plugin install fabric@cc-market
```

Then register the MCP server in `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "fabric": {
      "command": "node",
      "args": ["<plugin-root>/scripts/mcp-server.mjs"]
    }
  }
}
```

## Usage

MCP `call` — the one-shot primitive (call it N times concurrently for fan-out; `mode`
selects policy: task/review/agent/image-generate/image-edit):

```json
{ "provider": "deepseek", "prompt": "Summarize the failure modes in this log: ..." }
```

```json
{ "provider": "codex", "mode": "task", "prompt": "Fix the failing test in tests/mcp-server.test.mjs",
  "write": true, "cwd": "/path/to/repo" }
```

The `/continue` command drives the `takeover` handoff subagent over this surface.

Library import — the same engines, directly:

```js
import { spawnChild } from './engine/spawn-child.mjs';
import { startObserveProxy } from './engine/observe-proxy.mjs';

// one-shot
const res = await spawnChild({ provider: 'deepseek', prompt: 'hello', observe: true, runDir });

// observe proxy on its own
const proxy = await startObserveProxy({ provider: 'deepseek', runDir });
// ... point any Anthropic-HTTP client at proxy.url; capture lands in proxy.jsonlPath
await proxy.close();
```

## Why

Running child model sessions has two modes:

- **Normal** — the child direct-connects to its provider (DeepSeek via Foundry env). No
  overhead.
- **Observe/debug** — you want to capture the child's API traffic.

`claude-tap` only intercepts vanilla `ANTHROPIC_BASE_URL`, which **conflicts** with
Foundry routing (DeepSeek). Fabric resolves this with a minimal own proxy:

```
child --ANTHROPIC_BASE_URL=http://127.0.0.1:PORT--> observe-proxy --> real upstream
```

The child always speaks vanilla Anthropic HTTP; the proxy alone owns the provider's
endpoint, auth, and model alias. `observe` becomes a single boolean — vanilla+proxy vs
Foundry direct — and the same proxy works for any Anthropic-compatible provider.

## Layers

- **L0 provider routing** — `engine/providers.mjs` (fabric-owned, canonical). Reads `~/.claude/claude_env_settings.json` plus the machine-local `claude_env_settings.local.json` overlay (deep-merged by `readRegistry`, override wins — the synced file carries base URLs/models, never keys), normalizes vanilla/Foundry,
  resolves model aliases.
- **L1 engines** — `engine/spawn-child.mjs` (the claude child engine: exe resolution,
  provider env, optional config isolation, stream-json/images), `engine/anthropic-http.mjs`
  (raw single-turn HTTP, retry + SSE), `engine/codex/` (codex app-server client + task
  runner). One implementation each; the plugin's own L1 policy consumes them.
- **L1 observe proxy** — `engine/observe-proxy.mjs`. `startObserveProxy({provider,
  runDir})` → `{url, port, jsonlPath, close}`. Buffers+remaps the request body, streams
  the SSE response back **unbuffered**, tees request/response to `runDir/http.jsonl`.

## Library (dual-form)

- `spawnChild({provider, prompt, observe, runDir, model})` — headless one-shot child.
  `buildChildEnv` is the observe switch (Foundry-strip vs proxy).
- `startObserveProxy({provider, runDir})` — the observe proxy.
- `loadRows` / `mainTurns` / `summarize` (`engine/observe-reader.mjs`) — read the capture.

## MCP tools

- `call` — the one-shot primitive: invoke a model and return its output. `mode`
  (task/review/agent/image-*) carries policy; `<command>` flags in `prompt` override params.
  Anthropic-compatible providers (`claude` / `deepseek`) run via `claude -p` or raw HTTP;
  `provider: "codex"` runs via the codex app-server (native — pass `write: true` for tools,
  `cwd` for the repo). `observe: true` (non-codex) captures API traffic to the proxy jsonl.
  Call several concurrently for fan-out.
- `list_providers` — dump the provider registry + model aliases.
- `resolve_model` — map a full Claude model id → a provider's real upstream id.
- `codex_status` — codex CLI install / version / auth check.
- `fan_out` — run N `call`s in parallel; returns compact JSON (per-task summary, est.
  tokens, duration) plus an optional synthesis.

## Config

The `fabric` block of `~/.claude/claude_env_settings.json` (synced; per-machine overrides go
in `~/.claude/claude_env_settings.local.json`, deep-merged over it):

```json
"fabric": {
  "systemPromptFile": "~/.claude/system-prompt/claude-base.md",
  "sessionDefaults": { "provider": "deepseek", "model": "deepseek-v4-flash[1m]" }
}
```

`sessionDefaults` supplies provider/model when `call` omits a provider.

## Auth note

Static-key providers get the token injected in the header style matching the env var that
supplied it: `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`, `ANTHROPIC_API_KEY` (and
Foundry keys, e.g. DeepSeek/Kimi) → `x-api-key`. OAuth providers (`claude`) must
use `passthroughAuth: true` — the proxy forwards the child's own refreshing token rather
than holding credentials.
