# Fabric

Multi-provider agent **session fabric** — the shared layer for any agent (`claude` /
`codex` / …) orchestrating many independent child sessions of any provider. The orchestrator
and its children can each be any provider. Dual-form: an importable library **and** an MCP
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

MCP `run_task` — one-shot headless children (spawn several concurrently for fan-out):

```json
{ "provider": "deepseek", "prompt": "Summarize the failure modes in this log: ..." }
```

```json
{ "provider": "codex", "prompt": "Fix the failing test in tests/mcp-server.test.mjs",
  "write": true, "cwd": "/path/to/repo" }
```

Library import — the same engines, directly:

```js
import { spawnChild } from './shared/spawn-child.mjs';
import { openSession } from './shared/open-session.mjs';
import { startObserveProxy } from './shared/observe-proxy.mjs';

// one-shot
const res = await spawnChild({ provider: 'deepseek', prompt: 'hello', observe: true, runDir });

// persistent multi-turn
const s = await openSession({ provider: 'claude' });
const { text } = await s.send('What did we decide last turn?');
await s.close();

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

- **L0 provider routing** — `shared/providers.mjs` (canonical, bundled; shared with
  takeover). Reads `~/.claude/claude_env_settings.json`, normalizes vanilla/Foundry,
  resolves model aliases.
- **L1 engines** — `shared/spawn-child.mjs` (the claude child engine: exe resolution,
  provider env, optional config isolation, stream-json/images), `shared/anthropic-http.mjs`
  (raw single-turn HTTP, retry + SSE), `shared/codex/` (codex app-server client + task
  runner). One implementation each, shared with takeover — takeover is the stateless
  policy consumer of the same engines.
- **L1 observe proxy** — `shared/observe-proxy.mjs`. `startObserveProxy({provider,
  runDir})` → `{url, port, jsonlPath, close}`. Buffers+remaps the request body, streams
  the SSE response back **unbuffered**, tees request/response to `runDir/http.jsonl`.

## Library (dual-form)

- `spawnChild({provider, prompt, observe, runDir, model})` — headless one-shot child.
  `buildChildEnv` is the observe switch (Foundry-strip vs proxy).
- `openSession({provider, observe, runDir, model})` — **persistent multi-turn** child
  (library-level, no daemon). Holds one long-lived `claude` stream-json process; `send(text)`
  returns each turn's text, context retained across turns. Turns/tool/question events arrive
  as structured JSON, not TTY. Open many concurrently for stateful fan-out.
- `startObserveProxy({provider, runDir})` — the observe proxy.
- `loadRows` / `mainTurns` / `summarize` (`shared/observe-reader.mjs`) — read the capture.

## MCP tools

- `list_providers` — dump the provider registry + model aliases.
- `resolve_model` — map a full Claude model id → a provider's real upstream id.
- `run_task` — dispatch a one-shot headless child for a provider and return its output.
  Anthropic-compatible providers (`claude` / `deepseek`) run via `claude -p`, optionally
  behind the observe proxy. `provider: "codex"` runs via the codex app-server instead (codex
  is native — not Anthropic HTTP); pass `write: true` to enable its tools (run git, edit
  files) and `cwd` to point it at the target repo. Spawn several concurrently for fan-out.

## Roadmap (next slice)

- MCP `spawn_session` / `session_send` / `session_close` — expose `openSession` over MCP so a
  running orchestrator agent can hold sessions across its own chat turns. Needs a handle-holding daemon
  (MCP calls are discrete; the process must outlive them). The library primitive
  (`openSession`) already exists; this is the transport wrapper.

## Auth note

Static-key providers (DeepSeek) get `x-api-key` injected. OAuth providers (`claude`) must
use `passthroughAuth: true` — the proxy forwards the child's own refreshing token rather
than holding credentials.
