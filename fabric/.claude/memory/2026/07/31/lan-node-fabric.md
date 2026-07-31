---
name: lan-node-fabric
created: 2026-07-31
---

# LAN node fabric — devices as teammates (v1)

## Design consensus (from the parent-repo discussion, 2026-07-31)

Multi-device fabric uses a **pure message-passing model** — explicitly NOT a shared
filesystem (OneDrive-synced-repo model rejected as too complex). A peer device behaves like
a Claude Code teammate: you spawn a session on it, exchange text turns, and it works in its
OWN project directory with its OWN credentials. File sync is git's job, negotiated inside
the conversation, never the transport's. Projects are referenced by **alias** registered on
the serving machine (peer never learns paths). The future multi-device multi-agent
management platform is a separate project; this node protocol is its shared foundation
(platform = a read-only privileged node on this network).

## What shipped

- `engine/node-config.mjs` — `fabric` block in `claude_env_settings.json`:
  `{ token, nodes: {name: {host,port,token?}}, serve: {port, host?, name?, projects: {alias: path}} }`.
  Riding the synced env-settings file distributes roster + token to all machines for free.
- `engine/node-server.mjs` — `createNodeServer({token, name, projects, deps})`; TCP,
  newline-delimited JSON-RPC 2.0; methods `node/status|spawn|send|close`; token required on
  every request (AUTH_ERROR -32001); refuses to start without a token; dispatch is
  non-awaiting so long turns don't block a socket; garbage lines ignored.
- `engine/node-client.mjs` — `connectNode()` (multiplexed by JSON-RPC id, pendings rejected
  on connection loss) + `openRemoteSession()` returning the uniform `{id, send, close}`
  provider-session handle. One connection per remote session.
- `engine/session.mjs` — `openProviderSession({node, project})` routes to remote when
  `node` set (name resolved via config, or inline `{host,port,token}`); team workers accept
  `node`/`project`, so teams mix local + remote transparently.
- `scripts/serve.mjs` — CLI to run the machine as a node.
- MCP: `spawn_session`/`team_spawn` grew `node`/`project`; new `list_nodes` tool.
- Tests: `tests/node-fabric.test.mjs` — 11 tests over real localhost sockets with fake
  session deps (auth, roundtrip, multiplexing, alias resolution, handle shape, connection
  loss, malformed wire data, config loading, session-route + team integration).

## Deliberate v1 limits (revisit later)

- No mDNS discovery (config roster only), transport is TLS-PSK (token-derived; no cert management),
  no reconnect/resume (a remote session is owned by the connection that spawned it and is
  closed by the server when that socket drops), no async completion callbacks (a `send`
  awaits the full turn over the socket), `call`/`fan_out` one-shots not yet node-routable
  (sessions/teams only).
