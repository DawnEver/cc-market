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
{ "provider": "<catalogue provider>", "prompt": "Summarize the failure modes in this log: ..." }
```

```json
{ "provider": "codex", "mode": "task", "prompt": "Fix the failing test in tests/mcp-server.test.mjs",
  "write": true, "cwd": "/path/to/repo" }
```

The `/continue` command drives the `takeover` handoff subagent over this surface.

Windows Codex startup and status checks share one launcher: native executables run
without a shell; batch shims use a constrained invocation that preserves literal paths.
Only fixed bootstrap flags enter a shim. Prompts remain JSON-RPC data.

Library import — the same engines, directly:

```js
import { spawnChild } from './engine/spawn-child.mjs';
import { startObserveProxy } from './engine/observe-proxy.mjs';

// one-shot
const res = await spawnChild({ provider: '<catalogue provider>', prompt: 'hello', observe: true, runDir });

// observe proxy on its own
const proxy = await startObserveProxy({ provider: '<catalogue provider>', runDir });
// ... point any Anthropic-HTTP client at proxy.url; capture lands in proxy.jsonlPath
await proxy.close();
```

## Why

Running child model sessions has two modes:

- **Normal** — the child direct-connects to its provider (its anthropic endpoint, key and model pins in the env). No
  overhead.
- **Observe/debug** — you want to capture the child's API traffic.

Fabric captures it with a minimal own proxy:

```
child --ANTHROPIC_BASE_URL=http://127.0.0.1:PORT--> observe-proxy --> real upstream
```

The child always speaks vanilla Anthropic HTTP; the proxy alone owns the provider's
endpoint, auth, and model alias. `observe` is a single boolean — proxy vs direct — and the same proxy works for any Anthropic-compatible provider.

## Layers

- **L0 provider routing** — `engine/providers.mjs`. Reads the provider catalogue from `~/.claude/provider-cache.json` (ai-lab's `python -m ai_lab.providers --json`, copied by setup; stale/absent is refused as `unsupported` naming the remedy) and the host projection rules (`claudeApiKeyEnv`) from `~/.claude/claude_env_settings.json`; resolves model aliases.
- **L1 engines** — `engine/spawn-child.mjs` (the claude child engine: exe resolution,
  provider env, optional config isolation, stream-json/images), `engine/ai-lab-call.mjs`
  (every one-shot API call as one `python -m ai_lab.call` request; ai-lab holds the wire, key and retries), `engine/codex/` (codex app-server client + task
  runner). One implementation each; the plugin's own L1 policy consumes them.
- **L1 observe proxy** — `engine/observe-proxy.mjs`. `startObserveProxy({provider,
  runDir})` → `{url, port, jsonlPath, close}`. Buffers+remaps the request body, streams
  the SSE response back **unbuffered**, tees request/response to `runDir/http.jsonl`.

## Library (dual-form)

- `spawnChild({provider, prompt, observe, runDir, model})` — headless one-shot child.
  `buildChildEnv` is the observe switch (direct vs proxy).
- `startObserveProxy({provider, runDir})` — the observe proxy.
- `loadRows` / `mainTurns` / `summarize` (`engine/observe-reader.mjs`) — read the capture.

## MCP tools

- `call` — the one-shot primitive: invoke a model and return its output. `mode`
  (task/review/agent/image-*) carries policy; `<command>` flags in `prompt` override params.
  `provider: "claude"` runs via `claude -p`; a catalogue provider runs task/review through
  `ai_lab.call` and agent mode via `claude -p` on its anthropic endpoint;
  `provider: "codex"` runs via the codex app-server (native — pass `write: true` for tools,
  `cwd` for the repo). `observe: true` (non-codex) captures API traffic to the proxy jsonl.
  Call several concurrently for fan-out.
- `list_providers` — dump the provider registry + model aliases.
- `resolve_model` — map a full Claude model id → a provider's real upstream id.
- `codex_status` — codex CLI install / version / auth check.
- `fan_out` — run N `call`s in parallel, at most `fabric.fanOutConcurrency` (default 4) at once; returns compact JSON (per-task `result` capped at
  400 chars, est. tokens, duration) plus a synthesis when `synthesize: true` and a
  `fabric.synthesizer` is configured (refused by name otherwise).

## Config

The `fabric` block of `~/.claude/claude_env_settings.json`:

```json
"fabric": {
  "systemPromptFile": "~/.claude/system-prompt/claude-base.md",
  "sessionDefaults": { "provider": "<catalogue provider>", "model": "<model id or tier word>" }
}
```

`sessionDefaults` supplies provider/model when `call` omits a provider.

`ledger` names the ai-lab ledger (`python -m ai_lab.call --ledger`) every one-shot API call is
recorded in, with its usage and key slot — the one usage record (default
`~/.claude/fabric/ledger.jsonl`). The ledger also serves an identical repeated request from the
record. fabric writes no trace of its own.

Optional `summarizer` and `synthesizer` (each `{ "provider": ..., "model": ... }`) name who
condenses a long `call` result (`resultMode: "summary"`) and who synthesises `fan_out`
results. Both default to NONE: with no summarizer the default `resultMode` is `full`, and an
explicit `summary` or `synthesize: true` without its helper is refused by name.

## Auth note

An API provider's key is never in a file: it is read from the git credential store
(`git credential fill`, prompts off) under the catalogue row's host and the caller's key
task (`call`'s `task`, default `default`; the row's `key_usernames` names the credential).
No git is `unsupported`; no stored key is `auth`, naming `python -m ai_lab.auth login`.
The observe proxy injects it in the header style `claudeApiKeyEnv` names:
`ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`, `ANTHROPIC_API_KEY` → `x-api-key`. OAuth providers (`claude`) must
use `passthroughAuth: true` — the proxy forwards the child's own refreshing token rather
than holding credentials.
