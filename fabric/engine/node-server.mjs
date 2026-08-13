// engine/node-server.mjs — the LAN node server: exposes this machine's provider sessions
// to peer fabric nodes over TCP (newline-delimited JSON-RPC 2.0). Started by
// `scripts/serve.mjs`; a peer's openRemoteSession (node-client.mjs) is the counterpart.
//
// Pure message-passing: peers spawn/drive/close sessions here by id; the session runs in
// THIS machine's project directory (resolved from a project ALIAS registered in this
// server's config) with this machine's credentials. No file transfer, no shared paths.
//
// Methods (every request must carry an ACCEPTED token in params.token):
//   node/status  { detail?: 'light'|'full' } → { name, version, uptime_s, cpu, cpu_busy_pct,
//                  mem_*, tags, maxSessions, sessions_count, sessions }
//   node/view    { id, tailChars? } → { content, alive, pid, turns, lastActivity }  (content tail)
//   node/spawn   { provider?, model?, write?, project? } → { id, provider, nativeId, pid }
//                 (provider/model/effort default to this node's sessionDefaults)
//   node/send    { id, prompt } → { text, turn }
//   node/ping    { id } → { id, provider, alive, pid, turns, lastActivity }
//   node/compact { id } → { id, compacted, confirmed }
//   node/goal    { id, condition, prompt?, maxTurns?, timeoutMs? } → { id, ... }
//                 (set the native /goal; with prompt, run the autonomous loop on the
//                  peer and return the drained final result)
//   node/close   { id } → { id, exitCode, turns, usage? }
//   node/shutdown {} → { shuttingDown, name, version, sessions }
//                 (serve takeover: a token-holder asks this node to end its lifecycle so
//                  a NEWER serve can bind the port; the reply precedes the shutdown)
//
// Sessions are OWNED by the connection that spawned them: node/send, node/compact,
// node/goal and node/close only accept ids owned by that connection, and when a socket
// drops its sessions are closed (best-effort) so a dead peer can't leak children.
// node/status still lists all sessions.
//
// TRUST DOMAIN (SR-013): a node is ONE trust domain — holding an accepted token confers
// full VISIBILITY of the box. node/status, node/ping and node/view are all read-only and
// all unrestricted by owner, deliberately and consistently; ownership gates only the calls
// that ACT on a session (node/send, node/close). Anyone who should not see this box's
// sessions should not hold one of its tokens.

import tls from "node:tls";
import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, sendToSession, closeSession, listSessions, pingSession, compactSession, setSessionGoal, goalRunSession, viewSession } from "./session.mjs";
import { sampleCpuBusyPct } from "./sysinfo.mjs";
import { resolveProfile } from "./profile.mjs";
import {
  PSK_IDENTITY, PSK_IDENTITY_PREFIX, PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken,
  tokenFingerprint,
} from "./node-tls.mjs";
import { attachEdge } from "./node-edge.mjs";
import { loadOrCreateIdentity, trustPeer } from "./node-identity.mjs";

export const AUTH_ERROR = -32001;
export const DEFAULT_MAX_SESSIONS = 64;

// Hash both sides so lengths always match — timingSafeEqual throws on length mismatch.
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const tokenMatches = (given, expected) => crypto.timingSafeEqual(digest(given), digest(expected));

class RpcError extends Error {
  constructor(code, message, data = undefined) { super(message); this.code = code; this.data = data; }
}

// Plugin version, best-effort: a peer scheduling against this node deserves to know which
// fabric it is talking to. MEMOIZED at first read (server start): node/status must report
// the version of the CODE actually running, not the plugin.json that may have been updated
// on disk since — an autoUpdate under a long-lived serve made the status lie (WS2's banner
// said v0.1.14 while node/status reported v0.1.19, observed 2026-08-11).
let _pluginVersion;
export function pluginVersion() {
  if (_pluginVersion !== undefined) return _pluginVersion;
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
    _pluginVersion = JSON.parse(readFileSync(p, "utf8")).version ?? "unknown";
  } catch { _pluginVersion = "unknown"; }
  return _pluginVersion;
}

/**
 * @param {object} opts
 *   token         primary token (the one the legacy bare PSK identity maps to)
 *   tokens        additional ACCEPTED tokens — revoking a peer is deleting one entry
 *   maxSessions   static operator-declared ceiling on concurrent sessions
 *   sessionDefaults  {provider?, model?, effort?} — defaults a node/spawn that omits them
 *   cpuSampleMs   CPU-busy% sample window; <=0 skips the sample (cpu_busy_pct: null)
 */
export function createNodeServer({ token, tokens = [], name = null, projects = {}, tags = [], profiles = {}, defaultProfile = null, sessionDefaults = null, maxSessions = DEFAULT_MAX_SESSIONS, cpuSampleMs = 120, deps = {}, _kill = null, _closeGraceMs = 3000, identity = undefined, getMesh = () => null, onEdge = null, peerPins = () => ({}), onShutdownRequest = null } = {}) {
  if (!token) throw new Error("createNodeServer: a token is required (set fabric.token in claude_env_settings.json)");
  // P3: every node serves its Ed25519 identity in the hello handshake (undefined → load
  // or create the machine key; an explicit null opts out, serving as a legacy node).
  const nodeIdentity = identity === undefined ? loadOrCreateIdentity() : identity;
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
  const _viewSession = deps.viewSession || viewSession;
  const kill = _kill || ((pid) => process.kill(pid));
  const closeGraceMs = _closeGraceMs;
  const startedAt = Date.now();
  // In-flight spawn admissions. The ceiling check reads _listSessions() BEFORE
  // _createSession registers the new session, so two concurrent spawns both saw a free
  // slot and both spawned — a team_spawn fan-out overshot the operator's ceiling.
  // Counting in-flight admissions in the check, and incrementing SYNCHRONOUSLY before
  // the first await, makes admission atomic (single-threaded: nothing can interleave
  // between the check and the increment).
  let admissions = 0;
  // cwd → the alias whose root contains it; a session outside every alias reports null
  // rather than a guess. ONE mapping used by node/status AND node/view: attachSession
  // learns a session's project from the view, so the two must agree or an attached
  // session shows "no project" while the status list groups it under its alias.
  const projectForCwd = (cwd) => Object.entries(projects).find(([, root]) =>
    cwd && String(cwd).replaceAll("\\", "/").startsWith(String(root).replaceAll("\\", "/")))?.[0] ?? null;
  // SHARED sessions (v2): drivable by ANY token-holder, and never reaped on the
  // spawner's disconnect -- their lifecycle belongs to the journal/watchdog.
  const shared = new Set();
  // Sessions spawned over the mesh's OUTBOUND edges (a peer dialed us... no — WE dialed
  // and the peer asks back). One ownership set for all mesh-served requests; server
  // close reaps them with everything else.
  const meshOwned = new Set();

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
          name, hostname: os.hostname(), version: pluginVersion(),
          uptime_s: Math.round((Date.now() - startedAt) / 1000),
          cpu: os.cpus().length,
          // Cross-platform CPU busy % over a short window — os.loadavg() is [0,0,0] on
          // Windows, so this samples os.cpus() cumulative times (engine/sysinfo.mjs).
          cpu_busy_pct: await sampleCpuBusyPct(cpuSampleMs),
          mem_available_mb: Math.round(os.freemem() / 1048576),
          mem_total_mb: Math.round(os.totalmem() / 1048576),
          tags,
          projects: Object.keys(projects),
          maxSessions,
          sessions_count: live.length,
          // P3: this node's provable identity (fingerprint only — the key never leaves).
          // P2: the mesh edges this daemon currently holds, when a mesh runs here.
          identity: nodeIdentity ? { fingerprint: nodeIdentity.fingerprint } : null,
          mesh: getMesh()?.status() ?? null,
          // A console polling every 6s across N nodes re-serializes this list each time,
          // so `light` is the default and usage objects are opt-in (SR-029/046). The cost
          // is O(sessions) either way; light just makes each row small.
          sessions: live.map((sess) => {
            const project = projectForCwd(sess.cwd);
            const common = { id: sess.id, provider: sess.provider, shared: shared.has(sess.id), project };
            return detail === "full"
              ? { ...sess, ...common }
              : { ...common, alive: sess.alive ?? null, lastActivity: sess.lastActivity ?? null };
          }),
        };
      }
      case "node/spawn": {
        // Defaults resolve HERE, against this node's own config — the same convention as
        // profiles (the peer enforces policy; a caller may omit and inherit the node's
        // default session). The default is a BUNDLE: overriding the provider leaves the
        // default session, so its model/effort no longer apply (a deepseek model id would
        // be wrong on a claude session). An explicit param always wins.
        const provider = params.provider ?? sessionDefaults?.provider ?? null;
        const onDefaultProvider = !params.provider || (sessionDefaults?.provider != null && params.provider === sessionDefaults.provider);
        const model = params.model ?? (onDefaultProvider ? sessionDefaults?.model : null) ?? null;
        const effort = params.effort ?? (onDefaultProvider ? sessionDefaults?.effort : null) ?? null;
        if (!provider) throw new RpcError(-32602, "node/spawn: provider is required (and this node has no sessionDefaults.provider)");
        // A STATIC operator-declared ceiling (SR-025/041), not a scheduling decision:
        // dynamic admission (who gets the next slot, by load) stays in swarm. This only
        // refuses past an invariant the operator wrote in serve.maxSessions, so a
        // token-holder cannot fork-bomb the box between two of swarm's observations.
        const current = _listSessions().length + admissions;
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
        // All validation above is synchronous, so the slot claimed here can never be
        // claimed twice; the finally releases it whether the spawn settles or fails.
        admissions++;
        try {
          const desc = await _createSession({
            provider, model, write: !!params.write,
            cwd: cwd || process.cwd(), observe: false, profile,
            visible: !!params.visible, interactive: !!params.interactive, effort,
          });
          if (params.shared) shared.add(desc.id); else owned.add(desc.id);
          return { ...desc, shared: !!params.shared };
        } finally {
          admissions--;
        }
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
      case "node/view":
        // Read-only content view (transcript tail + liveness facts), likewise unrestricted
        // by owner — viewing is visibility, not acting. A peer can see what a session on
        // this box is doing; it cannot send to it or close it unless it owns/spawns shared.
        if (!params.id) throw new RpcError(-32602, "node/view: id is required");
        // Attach learns identity from the view — fill project from cwd the SAME way
        // node/status does, or an attached session shows "no project" while the status
        // list groups the same session under its alias.
        const v = await _viewSession(params.id, { tailChars: params.tailChars });
        if (v && typeof v === "object" && v.project == null && v.cwd) v.project = projectForCwd(v.cwd);
        return v;
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
      case "node/shutdown": {
        // Takeover half of a serve restart: a token-holder may ask this node to shut
        // down so a NEWER serve can bind the port. The reply goes out FIRST, the
        // shutdown is scheduled after — killing the socket before replying would read
        // as CONNECTION_LOST to a caller that needs to hear "yes, I am going away".
        // Refusing when no handler is wired is honest: not every embedding owns a
        // lifecycle to end.
        if (!onShutdownRequest) throw new RpcError(-32601, "node/shutdown: this embedding has no lifecycle to end");
        const sessions = _listSessions().length;
        setTimeout(() => { try { onShutdownRequest(); } catch { /* dying anyway */ } }, 250).unref?.();
        return { shuttingDown: true, name, version: pluginVersion(), sessions };
      }
      case "node/forward": {
        // P1/P2 relay: pass one request to a node this daemon holds (or can open) a mesh
        // edge to. The mesh dials on demand; auth at the target is the edge's own token.
        const mesh = getMesh();
        if (!mesh) throw new RpcError("ROUTE_UNAVAILABLE", "node/forward: this node runs no mesh (pre-mesh fabric) — it cannot relay");
        if (typeof params.target !== "string" || typeof params.method !== "string") {
          throw new RpcError(-32602, "node/forward: target (node name) and method are required");
        }
        return mesh.forward(params.target, params.method, params.params ?? {}, { timeoutMs: params.timeoutMs });
      }
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
    // Every accepted socket is a SYMMETRIC edge (node-edge.mjs): after the hello
    // handshake the peer can also answer OUR requests — the basis of the mesh (P1/P2).
    // Auth is unchanged: the TLS-PSK handshake rejects unknown tokens, and every request
    // re-checks params.token against the accepted set before dispatch.
    const edge = attachEdge({
      socket,
      label: `${socket.remoteAddress ?? "?"}:${socket.remotePort ?? "?"} inbound`,
      identity: nodeIdentity ? { ...nodeIdentity, name } : null,
      trustPeer: (peerName, fp) => trustPeer(peerName, fp, peerPins()[peerName] ?? null),
      onRequest: async (method, params) => {
        if (params.token === undefined || !tokenAccepted(params.token)) {
          throw new RpcError(AUTH_ERROR, "unauthorized: bad or missing token");
        }
        return dispatch(method, params, owned);
      },
    });
    onEdge?.(edge);
  });

  // A failed handshake (wrong PSK, non-TLS client) must not crash the server.
  // The remote address is the diagnosis: a LAN peer's IP means a token mismatch on that
  // box (config not yet synced), anything else is a stray non-fabric client on the port.
  server.on("tlsClientError", (e, sock) => process.stderr.write(
    `fabric node: TLS handshake failed from ${sock?.remoteAddress ?? "?"}:${sock?.remotePort ?? "?"}: ${e.message}\n`));

  return {
    /**
     * Serve one authenticated request OUTSIDE any inbound socket — the mesh's outbound
     * edges receive requests too (reversal: the peer asks us back over the socket it
     * dialed). Sessions spawned this way are owned by the mesh edge set, reaped on
     * server close like everything else.
     */
    async serveRequest(method, params = {}) {
      if (params.token === undefined || !tokenAccepted(params.token)) {
        throw new RpcError(AUTH_ERROR, "unauthorized: bad or missing token");
      }
      return dispatch(method, params, meshOwned);
    },
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
