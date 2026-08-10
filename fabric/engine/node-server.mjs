// engine/node-server.mjs — the LAN node server: exposes this machine's provider sessions
// to peer fabric nodes over TCP (newline-delimited JSON-RPC 2.0). Started by
// `scripts/serve.mjs`; a peer's openRemoteSession (node-client.mjs) is the counterpart.
//
// Pure message-passing: peers spawn/drive/close sessions here by id; the session runs in
// THIS machine's project directory (resolved from a project ALIAS registered in this
// server's config) with this machine's credentials. No file transfer, no shared paths.
//
// Methods (every request must carry an ACCEPTED token in params.token):
//   node/status  { detail?: 'light'|'full' } → { name, version, uptime_s, cpu, mem_*, tags,
//                  maxSessions, sessions_count, sessions }
//   node/spawn   { provider, model?, write?, project? } → { id, provider, nativeId, pid }
//   node/send    { id, prompt } → { text, turn }
//   node/ping    { id } → { id, provider, alive, pid, turns, lastActivity }
//   node/compact { id } → { id, compacted, confirmed }
//   node/goal    { id, condition, prompt?, maxTurns?, timeoutMs? } → { id, ... }
//                 (set the native /goal; with prompt, run the autonomous loop on the
//                  peer and return the drained final result)
//   node/close   { id } → { id, exitCode, turns, usage? }
//
// Sessions are OWNED by the connection that spawned them: node/send, node/compact,
// node/goal and node/close only accept ids owned by that connection, and when a socket
// drops its sessions are closed (best-effort) so a dead peer can't leak children.
// node/status still lists all sessions.
//
// TRUST DOMAIN (SR-013): a node is ONE trust domain — holding an accepted token confers
// full VISIBILITY of the box. node/status and node/ping are both read-only and both
// unrestricted by owner, deliberately and consistently; ownership gates only the calls
// that ACT on a session (node/send, node/close). Anyone who should not see this box's
// sessions should not hold one of its tokens.

import tls from "node:tls";
import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, sendToSession, closeSession, listSessions, pingSession, compactSession, setSessionGoal, goalRunSession } from "./session.mjs";
import { resolveProfile } from "./profile.mjs";
import {
  PSK_IDENTITY, PSK_IDENTITY_PREFIX, PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken,
  tokenFingerprint, MAX_LINE_BYTES, MAX_REPLY_BYTES,
} from "./node-tls.mjs";

export const AUTH_ERROR = -32001;
export const DEFAULT_MAX_SESSIONS = 64;

// Hash both sides so lengths always match — timingSafeEqual throws on length mismatch.
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const tokenMatches = (given, expected) => crypto.timingSafeEqual(digest(given), digest(expected));

class RpcError extends Error {
  constructor(code, message, data = undefined) { super(message); this.code = code; this.data = data; }
}

// Plugin version, best-effort: a peer scheduling against this node deserves to know
// which fabric it is talking to.
export function pluginVersion() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
    return JSON.parse(readFileSync(p, "utf8")).version ?? "unknown";
  } catch { return "unknown"; }
}

/**
 * @param {object} opts
 *   token         primary token (the one the legacy bare PSK identity maps to)
 *   tokens        additional ACCEPTED tokens — revoking a peer is deleting one entry
 *   maxSessions   static operator-declared ceiling on concurrent sessions
 */
export function createNodeServer({ token, tokens = [], name = null, projects = {}, tags = [], profiles = {}, defaultProfile = null, maxSessions = DEFAULT_MAX_SESSIONS, deps = {}, _kill = null, _closeGraceMs = 3000 } = {}) {
  if (!token) throw new Error("createNodeServer: a token is required (set fabric.token in claude_env_settings.json)");
  // The accepted SET (SR-033/051): one shared fleet-wide PSK could only be revoked by
  // re-keying every machine. `token` stays primary — it is what an older peer's bare
  // `fabric-node` identity resolves to.
  const accepted = [...new Set([token, ...tokens].filter(Boolean).map(String))];
  const byFingerprint = new Map(accepted.map((t) => [tokenFingerprint(t), t]));
  const tokenAccepted = (given) => accepted.some((t) => tokenMatches(given, t));
  const _createSession = deps.createSession || createSession;
  const _sendToSession = deps.sendToSession || sendToSession;
  const _closeSession = deps.closeSession || closeSession;
  const _listSessions = deps.listSessions || listSessions;
  const _pingSession = deps.pingSession || pingSession;
  const _compactSession = deps.compactSession || compactSession;
  const _setSessionGoal = deps.setSessionGoal || setSessionGoal;
  const _goalRunSession = deps.goalRunSession || goalRunSession;
  const kill = _kill || ((pid) => process.kill(pid));
  const closeGraceMs = _closeGraceMs;
  const startedAt = Date.now();
  // SHARED sessions (v2): drivable by ANY token-holder, and never reaped on the
  // spawner's disconnect -- their lifecycle belongs to the journal/watchdog.
  const shared = new Set();

  // -32601 unknown method, -32602 missing/invalid params, -32000 runtime failure.
  async function dispatch(method, params, owned) {
    switch (method) {
      case "node/status": {
        // Capacity facts (G1): what a scheduler needs to ADMIT, reported not decided.
        const detail = params.detail ?? "light";
        if (detail !== "light" && detail !== "full") {
          throw new RpcError(-32602, `node/status: detail must be "light" or "full", got "${detail}"`);
        }
        const live = _listSessions();
        return {
          name, version: pluginVersion(), uptime_s: Math.round((Date.now() - startedAt) / 1000),
          cpu: os.cpus().length,
          mem_available_mb: Math.round(os.freemem() / 1048576),
          mem_total_mb: Math.round(os.totalmem() / 1048576),
          tags,
          projects: Object.keys(projects),
          maxSessions,
          sessions_count: live.length,
          // A console polling every 6s across N nodes re-serializes this list each time,
          // so `light` is the default and usage objects are opt-in (SR-029/046). The cost
          // is O(sessions) either way; light just makes each row small.
          sessions: live.map((sess) => {
            // cwd -> the alias whose root contains it; a session outside every alias
            // reports project null rather than a guess.
            const project = Object.entries(projects).find(([, root]) =>
              sess.cwd && String(sess.cwd).replaceAll("\\", "/").startsWith(String(root).replaceAll("\\", "/")))?.[0] ?? null;
            const common = { id: sess.id, provider: sess.provider, shared: shared.has(sess.id), project };
            return detail === "full"
              ? { ...sess, ...common }
              : { ...common, alive: sess.alive ?? null, lastActivity: sess.lastActivity ?? null };
          }),
        };
      }
      case "node/spawn": {
        if (!params.provider) throw new RpcError(-32602, "node/spawn: provider is required");
        // A STATIC operator-declared ceiling (SR-025/041), not a scheduling decision:
        // dynamic admission (who gets the next slot, by load) stays in swarm. This only
        // refuses past an invariant the operator wrote in serve.maxSessions, so a
        // token-holder cannot fork-bomb the box between two of swarm's observations.
        const current = _listSessions().length;
        if (current >= maxSessions) {
          throw new RpcError("CAPACITY_CEILING",
            `node/spawn: this node is at its declared ceiling of ${maxSessions} session(s) (${current} running). Raise serve.maxSessions or close sessions first.`,
            { maxSessions, sessions: current });
        }
        let cwd;
        if (params.project != null) {
          cwd = projects[params.project];
          if (!cwd) throw new RpcError(-32602, `node/spawn: unknown project alias "${params.project}" on this node. Available: ${Object.keys(projects).join(", ") || "(none)"}`);
        }
        // ENFORCEMENT, not obedience (sharp-review SR-001): a remote profile is a NAME
        // resolved against THIS server's config. An inline object from the wire would let
        // any token-holder write their own policy.
        if (params.profile != null && typeof params.profile !== "string") {
          throw new RpcError(-32602, "node/spawn: profile must be a profile NAME registered on this node, not an object");
        }
        let profile = null;
        try { profile = resolveProfile(params.profile ?? defaultProfile, { profiles }); }
        catch (e) { throw new RpcError(-32602, `node/spawn: ${e.message}`); }
        const desc = await _createSession({
          provider: params.provider, model: params.model, write: !!params.write,
          cwd: cwd || process.cwd(), observe: false, profile,
          visible: !!params.visible, interactive: !!params.interactive, effort: params.effort ?? null,
        });
        if (params.shared) shared.add(desc.id); else owned.add(desc.id);
        return { ...desc, shared: !!params.shared };
      }
      case "node/send":
        if (!params.id || !params.prompt) throw new RpcError(-32602, "node/send: id and prompt are required");
        if (!owned.has(params.id) && !shared.has(params.id)) throw new RpcError(-32602, `node/send: session "${params.id}" is not owned by this connection (spawn it shared to allow cross-connection driving)`);
        return _sendToSession(params.id, params.prompt);
      case "node/ping":
        // Read-only liveness (G3), unrestricted by owner — the SAME rule as node/status,
        // stated in both places on purpose (SR-013). The node is one trust domain: an
        // accepted token confers full visibility, and only acting on a session is gated.
        if (!params.id) throw new RpcError(-32602, "node/ping: id is required");
        return _pingSession(params.id);
      case "node/compact": {
        if (!params.id) throw new RpcError(-32602, "node/compact: id is required");
        // Acting on a session — same ownership gate as send/close.
        if (!owned.has(params.id) && !shared.has(params.id)) throw new RpcError(-32602, `node/compact: session "${params.id}" is not owned by this connection (spawn it shared to allow cross-connection driving)`);
        return _compactSession(params.id);
      }
      case "node/goal": {
        if (!params.id) throw new RpcError(-32602, "node/goal: id is required");
        if (!owned.has(params.id) && !shared.has(params.id)) throw new RpcError(-32602, `node/goal: session "${params.id}" is not owned by this connection (spawn it shared to allow cross-connection driving)`);
        // condition alone sets the goal (instant); prompt runs the loop to its final
        // result — the drain happens HERE, where the child lives.
        if (params.prompt != null) {
          return _goalRunSession(params.id, { prompt: String(params.prompt), maxTurns: params.maxTurns, timeoutMs: params.timeoutMs });
        }
        if (params.condition == null) throw new RpcError(-32602, "node/goal: condition (or prompt) is required");
        return _setSessionGoal(params.id, String(params.condition));
      }
      case "node/close":
        if (!params.id) throw new RpcError(-32602, "node/close: id is required");
        if (!owned.has(params.id) && !shared.has(params.id)) throw new RpcError(-32602, `node/close: session "${params.id}" is not owned by this connection`);
        return _closeSession(params.id).then((r) => { owned.delete(params.id); shared.delete(params.id); return r; });
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  const sockets = new Set();
  // TLS-PSK: an accepted token IS the credential — an unaccepted one fails the handshake,
  // and all traffic is encrypted. No certificates to manage (see engine/node-tls.mjs).
  // The identity names WHICH accepted token the peer holds, by fingerprint; the bare
  // legacy identity maps to the primary token so an older peer still connects.
  const server = tls.createServer({
    pskCallback: (_socket, identity) => {
      if (identity === PSK_IDENTITY) return pskFromToken(token);
      if (typeof identity === "string" && identity.startsWith(PSK_IDENTITY_PREFIX)) {
        const t = byFingerprint.get(identity.slice(PSK_IDENTITY_PREFIX.length));
        if (t) return pskFromToken(t);
      }
      return null;
    },
    ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
  }, (socket) => {
    sockets.add(socket);
    const owned = new Set(); // session ids spawned over this connection
    socket.on("close", () => {
      sockets.delete(socket);
      // Best-effort reap: the owning peer is gone, so its sessions must not outlive it.
      for (const id of owned) { try { Promise.resolve(_closeSession(id)).catch(() => {}); } catch { /* already gone */ } }
      owned.clear();
    });
    socket.on("error", (e) => {
      process.stderr.write(`fabric node: socket error: ${e.message}\n`);
      socket.destroy();
    });
    // The mirror of MAX_LINE_BYTES (SR-036): a reply is unbounded in exactly the way a
    // request line is not allowed to be. Refusing it NAMES the size, so the caller can
    // tell "the node would not send this" from "the node had nothing to say".
    const reply = (rpc) => {
      try {
        let line = JSON.stringify(rpc);
        if (line.length > MAX_REPLY_BYTES) {
          line = JSON.stringify({
            jsonrpc: "2.0", id: rpc.id,
            error: {
              code: "RESULT_TOO_LARGE",
              message: `node reply for request ${rpc.id} was ${line.length} bytes, over the ${MAX_REPLY_BYTES}-byte cap; the result was not sent`,
              data: { bytes: line.length, maxBytes: MAX_REPLY_BYTES },
            },
          });
        }
        socket.write(`${line}\n`);
      } catch { /* socket gone */ }
    };

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) {
        process.stderr.write(`fabric node: line buffer exceeded ${MAX_LINE_BYTES} bytes; dropping connection\n`);
        socket.destroy();
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; } // garbage on the wire: ignore
        const { id, method, params = {} } = req;
        const notification = id === undefined; // JSON-RPC notification: never gets a response
        if (params.token === undefined || !tokenAccepted(params.token)) {
          if (!notification) reply({ jsonrpc: "2.0", id, error: { code: AUTH_ERROR, message: "unauthorized: bad or missing token" } });
          continue;
        }
        // Dispatch WITHOUT awaiting so long turns don't block other requests on this socket.
        dispatch(method, params, owned).then(
          (result) => { if (!notification) reply({ jsonrpc: "2.0", id, result }); },
          (e) => {
            if (notification) return;
            const error = { code: e.code ?? -32000, message: e instanceof Error ? e.message : String(e) };
            // `data` carries the machine-readable half (the ceiling and the current count,
            // the byte size) — a caller must not have to parse the prose to act on it.
            if (e?.data !== undefined) error.data = e.data;
            reply({ jsonrpc: "2.0", id, error });
          },
        );
      }
    });
  });

  // A failed handshake (wrong PSK, non-TLS client) must not crash the server.
  // The remote address is the diagnosis: a LAN peer's IP means a token mismatch on that
  // box (config not yet synced), anything else is a stray non-fabric client on the port.
  server.on("tlsClientError", (e, sock) => process.stderr.write(
    `fabric node: TLS handshake failed from ${sock?.remoteAddress ?? "?"}:${sock?.remotePort ?? "?"}: ${e.message}\n`));

  return {
    listen(port = 0, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve({ port: server.address().port }));
      });
    },
    async close() {
      // Reap EVERY session this process spawned — owned AND shared. A session child is
      // windowsHide by design, so when serve dies nothing visible remains to remind the
      // operator it exists; leaving it running turns the journal's "orphan" from an
      // exceptional fact into the steady state. Graceful close first; a close that hangs
      // past its grace falls back to killing the child pid outright.
      const live = _listSessions();
      const grace = new Promise((r) => setTimeout(r, closeGraceMs).unref?.());
      await Promise.race([
        Promise.allSettled(live.map((s) => Promise.resolve(_closeSession(s.id)).catch(() => {}))),
        grace,
      ]);
      for (const s of _listSessions()) {
        if (s.pid) { try { kill(s.pid); } catch { /* already gone */ } }
      }
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
