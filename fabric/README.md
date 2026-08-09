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

MCP `call` — the one-shot primitive (call it N times concurrently for fan-out; `mode`
selects policy: task/review/agent/image-generate/image-edit):

```json
{ "provider": "deepseek", "prompt": "Summarize the failure modes in this log: ..." }
```

```json
{ "provider": "codex", "mode": "task", "prompt": "Fix the failing test in tests/mcp-server.test.mjs",
  "write": true, "cwd": "/path/to/repo" }
```

For a real multi-turn handoff (context retained across turns) use `spawn_session` /
`session_send` / `session_close` instead of repeated `call`s. The `/continue` command
drives the `takeover` handoff subagent over this surface.

Library import — the same engines, directly:

```js
import { spawnChild } from './engine/spawn-child.mjs';
import { openSession } from './engine/open-session.mjs';
import { startObserveProxy } from './engine/observe-proxy.mjs';

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

- **L0 provider routing** — `engine/providers.mjs` (fabric-owned, canonical). Reads `~/.claude/claude_env_settings.json`, normalizes vanilla/Foundry,
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
- `openSession({provider, observe, runDir, model})` — **persistent multi-turn** child
  (library-level, no daemon). Holds one long-lived `claude` stream-json process; `send(text)`
  returns each turn's text, context retained across turns. Turns/tool/question events arrive
  as structured JSON, not TTY. Open many concurrently for stateful fan-out.
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
- `spawn_session` / `session_send` / `session_close` / `list_sessions` — **persistent
  multi-turn** sessions over MCP. `spawn_session` returns an id; each `session_send` is one
  turn with context retained from earlier turns; `session_close` frees the child. Works for
  codex (app-server thread), claude, and API providers alike. Example:

  ```json
  { "tool": "spawn_session", "arguments": { "provider": "codex", "cwd": "/repo", "write": true } }
  → { "id": "sess-1-...", "provider": "codex", "nativeId": "thread-abc" }
  { "tool": "session_send", "arguments": { "id": "sess-1-...", "prompt": "Investigate the failing test." } }
  { "tool": "session_send", "arguments": { "id": "sess-1-...", "prompt": "Now fix it." } }   // remembers the investigation
  { "tool": "session_close", "arguments": { "id": "sess-1-..." } }
  ```

  No separate daemon: the MCP stdio server is itself long-lived, so it holds the live session
  handles in an in-process registry across discrete tool calls.

## LAN nodes — sessions on other machines

Fabric nodes let sessions run on peer machines, teammate-style: pure message-passing, no
shared filesystem. The remote session runs in the remote machine's own project directory
(referenced by an alias registered there) with its own credentials; only text travels.
Transport is TLS-PSK: the shared token doubles as the pre-shared key, so all traffic is
encrypted and mutually authenticated with zero certificates — a wrong token fails the
handshake itself.

1. Configure the `fabric` block in `~/.claude/claude_env_settings.json` (synced to all
   machines):

   ```json
   "fabric": {
     "token": "a-shared-secret",
     "nodes": { "desktop": { "host": "my-desktop.example.corp", "port": 7677 } },
     "serve": {
       "port": 7677,
       "projects": { "thesis": "C:/work/thesis" },
       "byHost": { "my-desktop": { "projects": { "thesis": "D:/repos/thesis" } } }
     }
   }
   ```

   `host` may be an IP or DNS name. Because the file is synced to every machine, `serve`
   is shared — `serve.byHost` holds per-machine overrides keyed by hostname
   (case-insensitive, FQDN or short name); `projects` maps merge, override winning
   per alias.

2. On each peer machine, bring fabric up in a terminal you keep open. **`scripts\serve.cmd`
   / `scripts/serve.ps1` / `scripts/serve.sh` is THE start command** — it runs the LAN node
   server AND the management console in one process (both idempotent: an already-running
   instance is detected and skipped). Console: http://127.0.0.1:7678. Flags: `--port N`,
   `--console-port N`, `--no-console` (node only), `--status` (report and exit).
   Session-bound on purpose — never run as a background service; closing the terminal stops both.
3. **Open the firewall for inbound 7677** — once per machine. Windows blocks inbound Node by
   default (the serve log looks healthy while every peer times out; measured 2026-08-09).
   Admin PowerShell:

   ```powershell
   New-NetFirewallRule -DisplayName "fabric node 7677" -Direction Inbound -Protocol TCP -LocalPort 7677 -Action Allow
   ```

   Verify from any other machine: `node scripts/ping.mjs <name>` → `ALIVE` with capacity facts.
4. From any session, spawn remotely — same tools, plus `node`/`project`:

   ```json
   { "tool": "spawn_session", "arguments": { "provider": "codex", "node": "desktop", "project": "thesis", "write": true } }
   ```

   `team_spawn` workers accept `node`/`project` too, so a team can mix local and remote
   workers. `list_nodes` shows the configured peers.

## Auth note

Static-key providers get the token injected in the header style matching the env var that
supplied it: `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`, `ANTHROPIC_API_KEY` (and
Foundry keys, e.g. DeepSeek/Kimi) → `x-api-key`. OAuth providers (`claude`) must
use `passthroughAuth: true` — the proxy forwards the child's own refreshing token rather
than holding credentials.
