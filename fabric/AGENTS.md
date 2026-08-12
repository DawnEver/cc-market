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
│   ├── journal.mjs          Append-only session journal (~/.fabric) + reconcile() for restart orphans
│   ├── profile.mjs          Spawn profiles: allowedTools/permissionMode/envDeny — subtraction at the spawn point
│   ├── mcp-rpc.mjs          JSON-RPC stdio transport for the MCP server
│   ├── node-{server,client,config}.mjs  LAN node fabric: TCP JSON-RPC peer server, remote
│   │                        session client, `fabric` config block (see § LAN node fabric)
│   ├── node-probe.mjs       Fleet probe: concurrent pingNodes for list_nodes / web console
│   ├── sysinfo.mjs          Cross-platform CPU busy % + localStatus (Windows-safe)
│   ├── codex/               app-server client · task · session · discovery
│   └── tests/               engine unit suites (node:test)
├── shared/                  Bundled generic utils only (spawn/lib/state/stamp/attention) —
│                            DO NOT edit; edit cc-market/shared/. engine/ imports ../shared/spawn.mjs
├── scripts/
│   ├── mcp-server.mjs       MCP stdio server: wires L1 policy onto L0
│   ├── ping.mjs             Probe every configured node → ALIVE + capacity facts, or DEAD + reason
│   ├── serve.{mjs,ps1,cmd,sh}  THE standard way to start: LAN node server + management
│   │                        console in ONE process, both idempotent, session-bound on
│   │                        purpose (never a background service; user directive 2026-08-09).
│   │                        --port N · --console-port N · --no-console · --status
│   ├── lib.mjs + lib/       L1 policy: parse (<command> flags), config, spawn (claude
│   │                        wrapper), callers (codex/API adapters), trace, errors, format
│   │                        (fleet display: fmtUptime/fmtMem/fmtAgo)
│   └── codex/{review,image}.mjs  L1 codex policy: adversarial review · image gen/edit
├── web/                     Management console — a small structured web project:
│   ├── server.mjs           HTTP shell: extension-whitelisted static + API wiring,
│   │                        startConsole() export; /lib/ maps to scripts/lib for the
│   │                        display formatters (one formatting source, no re-spelling)
│   ├── api.mjs              Pure JSON API handler (tested) — incl. /view routes:
│   │                        /api/sessions/:id/view (transcript-as-truth chat) and
│   │                        /api/nodes/:node/sessions/:id/view (foreign observe)
│   └── public/              index.html + ES modules (state.js · render.js · main.js)
│                           + style.css, all re-read per request. state.js = PURE
│                           derivations (tested), incl. the attention model
│                           (attentionItems/machineWarnings/compareMachines/fleetHealth
│                           with exported thresholds); render.js = keyed vnode patch (no
│                           innerHTML, events via one delegated data-action dispatcher);
│                           main.js = polling + hash-routed views. No build step.
│                           UI = a CONVEYOR (machines → sessions → chat): the focused
│                           stage holds ~80% width, the stage above stays as a compact
│                           rail (~20%) — fleet keeps a sessions preview, sessions a
│                           machines rail, chat the sessions rail for one-click switch;
│                           the split bar drags, each stage remembers its ratio
│                           (localStorage). PAPER theme (user-picked from a rendered
│                           4-candidate gallery); palette flows through CSS variables.
│                           Skeletons mount once per stage entry; polls patch sub-
│                           containers only (form controls/scroll survive). Scales to
│                           dozens of machines / ~100 sessions (attention-first sort,
│                           machine grid, column-aligned rows, rails scroll).
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
| `spawn_session` | `provider?`, `model?`, `write?`, `cwd?`, `observe?`, `node?`, `project?`, `profile?`, `shared?`, `effort?` | `createSession()` → registers a live handle, returns `{id, provider, nativeId}`. Omitted provider/model/effort fall back to `fabric.sessionDefaults` (a provider+model+effort bundle; overriding the provider opts out of the default's model/effort). With `node`, the session runs on that peer machine (see § LAN node fabric). `shared:true` (remote only) makes it drivable by any token-holder and exempt from spawner-disconnect reap — the cross-machine attach convention |
| `session_view` | `id?`, `node?`, `remoteId?`, `tailChars?` | `viewSession()` / `viewRemoteSession()` → transcript tail + liveness facts (alive, pid, turns, lastActivity). `id` for a local/owned session (remote handles forward to their node); `node`+`remoteId` inspects a peer session directly (read-only, not owner-gated). codex reports `content:null` honestly (no local transcript) |
| `attach_session` | `node`, `remoteId` | `attachSession()` → adopt a shared remote session so this console can `session_send`/`session_close` it; returns a local id |
| `session_send` | `id`, `prompt` | `sendToSession()` → one turn, context retained |
| `session_close` | `id` | `closeSession()` → tears down the child |
| `session_compact` | `id` | `compactSession()` → native context compaction in place (codex `thread/compact/start`; claude/API via the CLI's `/compact` user message + `compact_boundary`); `COMPACT_UNSUPPORTED` for backends without one |
| `session_goal` | `id`, `condition`, `prompt?`, `maxTurns?`, `timeoutMs?` | `setSessionGoal()`/`goalRunSession()` → FABRIC-SIDE goal loop: with a goal active, a send iterates a completion-marker protocol (`<<GOAL_COMPLETE>>`) until the marker appears or the caps hit; returns the final outcome (`state: met\|capped\|timeout`); caps mandatory (the loop never self-terminates while unmet); claude/API children only (`GOAL_UNSUPPORTED` otherwise). The CLI's native `/goal` is deliberately NOT used — it requires hooks enabled, incompatible with the hook-free child policy (verified: refuses under disableAllHooks, hangs the CLI at startup with hooks on an isolated config dir) |
| `list_sessions` | (none) | `listSessions()` |
| `list_nodes` | (none) | Live fleet dashboard: this machine + every configured peer, probed concurrently (per-node deadlines) with ALIVE/DEAD, version, uptime (d/h/m), CPU busy %, mem free/total, tags, and each node's sessions (the "processes" you can manage) |
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

## LAN node fabric — devices as teammates

Multiple machines cooperate by **message-passing only** — a peer device is a teammate you
converse with, never a filesystem you reach into. No shared-filesystem assumption, no file
transfer: a remote session runs in the remote machine's own project directory (referenced
by an **alias** registered on that machine, never by path), with that machine's own
credentials; only text comes back.

- **Server** (`engine/node-server.mjs`, CLI `scripts/serve.*` — which also starts the
  management console in the same process; `--no-console` for the node alone): exposes
  `node/spawn|send|view|compact|goal|close|status|ping` over newline-delimited JSON-RPC 2.0 on **TLS-PSK**
  (`engine/node-tls.mjs` — PSK derived from a token; an unaccepted token fails the
  handshake, all traffic encrypted, no certificates). Every request also carries the token;
  the server refuses to start without one. Sessions are owned by the connection that
  spawned them (send/close reject foreign ids; socket drop reaps its non-shared sessions).
  `serve.maxSessions` (default 64) is a **static operator-declared ceiling**: `node/spawn`
  past it fails with `CAPACITY_CEILING`, and `node/status` reports the ceiling and the
  count. Dynamic admission — who gets the next slot, by load — stays in swarm; this only
  refuses past an invariant the operator wrote down. `node/status` also reports
  `hostname`, `cpu` (cores), **`cpu_busy_pct`** (cross-platform sample via
  `engine/sysinfo.mjs` — `os.loadavg` is [0,0,0] on Windows), mem free/total, uptime;
  `node/spawn` defaults omitted provider/model/effort to the node's `sessionDefaults`.
- **Tokens are per-node, and that is the norm.** A node accepts a **SET**: `fabric.token`
  (primary) plus `fabric.tokens`, while a peer picks its own with `nodes.<name>.token`.
  Issue one token per peer — revoking that peer is then deleting one entry on the node,
  not re-keying the fleet. TLS-PSK carries one PSK per identity, so the peer's identity
  says WHICH token it holds: `fabric-node:<sha256(token)[:12]>` (a hash — the identity
  travels in the clear and must never be the credential). The bare legacy identity
  `fabric-node` is still accepted and maps to the primary token, so an older peer connects.
- **A node is ONE trust domain.** `node/status`, `node/ping` and `node/view` are read-only
  and NOT owner-filtered: an accepted token confers full visibility of the box. Ownership
  gates only the calls that ACT on a session (send/close/compact/goal). Do not issue a
  token to a peer that should not see the machine's sessions. `node/status` takes
  `detail: 'light'|'full'` — light (the default) is counts plus per-session liveness,
  full adds usage/turns/pid for a console that renders cost. `node/view {id, tailChars?}`
  returns a session's transcript tail + liveness facts (see `viewSession`/`viewRemoteSession`).
- **Client** (`engine/node-client.mjs`): `openRemoteSession()` returns the same
  `{id, send, close}` handle as any local provider session. Sessions on the same peer share
  **one pooled connection** (keyed `host:port:token`, refcounted, closed at 0), multiplexed
  by JSON-RPC id. Every request carries a deadline — `REQUEST_TIMEOUT` (120s; 180s for a
  spawn), deliberately distinct from `CONNECTION_LOST` so a caller can tell peer-stuck from
  peer-gone — and a 30s heartbeat reaps a half-open peer before the next send hangs on it.
  `poolStats()` reports the live connections without printing any token.
- **Routing** (`engine/session.mjs`): `openProviderSession({node, project, ...})` — `node`
  is a configured node name (or inline `{host, port, token}`); everything above the opener
  (session registry, teams, MCP tools) is agnostic. Team workers take `node`/`project` too,
  so a team can mix local and remote workers transparently.
- **Config** (`engine/node-config.mjs`): the `fabric` block of `claude_env_settings.json` —
  `token`/`tokens` (accepted set), `nodes` (peers; `host` may be IP or DNS name, `token`
  per peer), `serve` (port/name/`maxSessions`/`projects` alias map), `sessionDefaults`
  (provider/model/effort bundle), `systemPromptFile` (claude/API platform prompt — a
  `~/.claude/system-prompt/...` path resolved via the per-machine symlink setup.js links
  into the synced repo; **never a machine-specific OneDrive path**). Secrets never ride the
  synced file: `readRegistry` (providers.mjs) and `loadFabricConfig` both deep-merge the
  machine-local `~/.claude/claude_env_settings.local.json` over the shared registry
  (override wins), so a machine can supply its own API keys and its own `fabric.token`/
  `tokens`. Codex's platform
  prompt comes from `codex_config.toml` `model_instructions_file =
  "~/.codex/system-prompt/codex-base.md"` (codex expands `~` against `~/.codex/`). Cached
  by mtime (of both the shared file AND the local overlay) AND a 2s TTL, because mtime
  alone has 1-second granularity on Windows and a
  same-second edit would otherwise stay invisible to a long-lived daemon forever. Riding
  the synced env-settings file means the node roster propagates to every machine
  automatically; since `serve` is therefore shared, `serve.byHost` carries per-machine
  overrides (matched against `os.hostname()` case-insensitively, FQDN or short name;
  `projects` merge per-alias) — resolved by `loadServeConfig()`, used by `scripts/serve.mjs`.

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
