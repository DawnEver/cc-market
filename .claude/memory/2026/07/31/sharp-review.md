---
name: sharp-review-2026-07-31
description: Sharp review findings — 14 total
metadata:
  type: project
---

## Review 2026-07-31 (session) — diff review + security audit (安全锐评)

### Reviewer Status
- Reviewer claude (claude): skipped
- Reviewer codex (codex): skipped
- Reviewer deepseek (deepseek): OK
- Reviewer kimi (kimi): OK

### Confirmed findings

---

### [SR-20260731-001] [HIGH] fabric/engine/node-server.mjs — Server-side session leak on client disconnect — spawned sessions (and their child processes) live forever when a client socket drops

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Track which sessions were spawned per socket (e.g., a socketSessions Map), and auto-close them in the socket's close handler. At minimum, add a TTL scavenger that closes sessions with no activity.

socket.on("close") only untracks the socket from the Set. Sessions created via node/spawn on that socket remain in the global session.mjs registry — with their live child processes — until the server restarts or someone manually calls node/close. Shipping a known process leak without even a basic cleanup mechanism means a crashing client leaks resources on the server indefinitely.

---

### [SR-20260731-002] [MEDIUM] fabric/scripts/serve.mjs — Fragile --port CLI parsing: missing value argument produces NaN, cryptic crash

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Validate the parsed port: check that args[portFlag + 1] exists, Number(...) is not NaN, and the value is in range 1-65535. Print a clear usage message on failure.

If --port has no following argument, Number(undefined) is NaN and server.listen(NaN, ...) throws a cryptic ERR_SOCKET_BAD_PORT error. No validation, no friendly error message.

---

### [SR-20260731-003] [MEDIUM] fabric/engine/node-server.mjs — All dispatch errors use flat -32000 code — JSON-RPC error codes lack discrimination

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Map specific failures to proper JSON-RPC codes: method-not-found → -32601, invalid params → -32602, server/internal → -32000. Surface the code from the thrown error if it carries one.

Every .catch() in the dispatch pipeline returns { code: -32000 }. A Method-not-found error gets the same -32000 as a session crash or bad params; clients can't programmatically distinguish failure classes. Only the auth error correctly uses a specific code (-32001).

---

### [SR-20260731-004] [MEDIUM] fabric/engine/node-config.mjs — loadFabricConfig re-reads and re-parses the JSON file on every call — no caching

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a module-level cache with an invalidation function, following the same pattern already used in providers.mjs (clearConfigCache).

loadFabricConfig() does JSON.parse(readFileSync) on every invocation; resolveNode(), the MCP list_nodes tool, and serve.mjs all call it. providers.mjs already has a cached config pattern — this module should follow suit.

---

### [SR-20260731-005] [LOW] fabric/engine/node-server.mjs — Socket errors are silently discarded — no logging for connection debugging

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Log the error to stderr before destroying the socket.

socket.on("error", () => socket.destroy()) swallows the error object entirely. A TCP RST or malformed packet vanishes without a trace; the MCP server pattern already logs to stderr liberally.

---

### [SR-20260731-006] [LOW] fabric/engine/node-server.mjs — JSON-RPC 2.0 notification compliance: server responds to requests missing id field

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Check id === undefined before dispatching; if absent, treat as a JSON-RPC notification (process but send no response).

A request without an id is serialized back with id: null. Per JSON-RPC 2.0 a request without an id is a Notification and MUST NOT be responded to. Not harmful in practice but a spec deviation.

---

### [SR-20260731-007] [LOW] fabric/scripts/serve.mjs — No graceful-shutdown timeout — hung server.close() blocks process exit forever

- **Category:** Bug
- **Status:** OPEN
- **Confidence:** single-reviewer
- **Suggestion:** Race server.close() against a 5s timeout that force-exits.

SIGINT/SIGTERM handlers await server.close(); process.exit(0). If a socket's TCP FIN handshake stalls, the process hangs indefinitely with no fallback.

---

### [SR-20260731-008] [INFO] fabric/.claude/memory/2026/07/31/lan-node-fabric.md — Known session-leak bug documented as a deliberate v1 limit — no mitigation shipped

- **Category:** Feature
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Add a per-socket session Set so sessions are auto-closed when their socket disconnects; make the 'revisit later' a TODO with a target milestone.

Documenting a leak doesn't fix it. The server already has the sockets Set — a parallel socketSessions Map with auto-close on disconnect would be ~10 lines and close this gap without waiting for v2.

---

### [SR-20260731-009] [HIGH] fabric/engine/node-server.mjs — Cleartext TCP transport exposes the shared auth token and all session traffic to anyone on the LAN

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Wrap the socket in TLS (node:tls with a pre-shared cert) or at minimum switch to an HMAC-challenge handshake so the token never crosses the wire; document that plain mode is trusted-LAN-only.

createNodeServer uses net.createServer with no TLS, and node-client.mjs sends token inside every JSON-RPC params payload. The server binds 0.0.0.0 by default, so any host that can reach the port can sniff the shared token once and fully impersonate a peer — spawning sessions with write: true on the victim machine — and read every prompt/response. Token auth over plaintext on a wildcard bind is effectively no auth on an untrusted network.

---

### [SR-20260731-010] [MEDIUM] fabric/engine/node-server.mjs — Any authenticated peer can drive or kill ANY session on the node, including sessions it did not spawn

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Track session ownership per socket connection (or per caller identity) in createNodeServer and reject node/send / node/close for ids the requester does not own.

node/send and node/close accept an arbitrary id and pass it straight to the global session registry. Auth is a single shared token for all peers, so there is no object-level access control: a peer can enumerate ids via node/status (unfiltered _listSessions()) and hijack or close every session on the node.

---

### [SR-20260731-011] [MEDIUM] fabric/engine/node-server.mjs — node/spawn with write:true gives remote peers unmediated write-capable agent sessions using this machine's credentials

- **Category:** Feature
- **Status:** CLOSED
- **Confidence:** single-reviewer
- **Suggestion:** Add a serve-level policy flag (e.g. serve.allowWrite / serve.allowedProviders) defaulting to write:false, and refuse node/spawn requests that exceed it.

A remote peer can pass write: true and any provider name to node/spawn; the spawned session runs with the server machine's API keys and filesystem access. Combined with the cleartext token issue, anyone who obtains the token gets remote code execution as the node user. No server-side gate restricts write or provider choice.

---

### [SR-20260731-012] [LOW] fabric/engine/node-server.mjs — Token compared with !== (non-constant-time) and no brute-force throttling on auth failures

- **Category:** Bug
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Compare with crypto.timingSafeEqual over hashed tokens and add a per-IP failure delay/lockout; rate-limit AUTH_ERROR responses.

params.token !== token is a short-circuiting string compare (timing oracle), and an attacker can hammer token guesses at line speed — each attempt gets an immediate AUTH_ERROR with no backoff, and the socket stays open for unlimited retries.

---

### [SR-20260731-013] [LOW] fabric/engine/node-config.mjs — Shared fabric token lives in claude_env_settings.json which syncs via OneDrive to every machine

- **Category:** Bug
- **Status:** CLOSED
- **Confidence:** single-reviewer
- **Suggestion:** Support a per-machine env-var or file-based token override (e.g. FABRIC_TOKEN) so the secret is not replicated through cloud sync; at minimum document the blast radius.

The single secret that authorizes remote write-capable session spawning is copied to every synced device and to OneDrive itself. Loss of any one device (or the cloud account) compromises all nodes.

---

### [SR-20260731-014] [INFO] fabric/engine/node-server.mjs — Unbounded buffer accumulation on socket data allows memory exhaustion from a malicious or stuck peer

- **Category:** Performance
- **Status:** FIXED
- **Confidence:** single-reviewer
- **Suggestion:** Cap the per-socket buffer (e.g. destroy the socket if buf exceeds a few MB without a newline).

buf += chunk grows without bound if a client streams data with no newline. Auth is checked per parsed line, so pre-auth flooding accumulates too — a peer can grow server memory indefinitely.
