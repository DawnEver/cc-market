// engine/node-client.mjs — client side of the LAN node fabric. connectNode() gives a
// multiplexed JSON-RPC connection to a peer node-server; openRemoteSession() wraps it into
// the SAME `{ id, send(text) → {text, turn}, close() }` handle every local provider session
// exposes — so the session registry / teams treat a remote machine exactly like a local
// provider (a teammate you exchange messages with, never a filesystem you reach into).
//
// Sessions on the same peer SHARE one pooled connection (SR-027/048): the pending map
// already multiplexes by JSON-RPC id, so N sessions cost one socket instead of N. A
// heartbeat pings each referenced connection so a half-open peer is discovered before the
// next send rather than by hanging it.

import tls from "node:tls";
import {
  PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken, identityForToken,
} from "./node-tls.mjs";
import { attachEdge } from "./node-edge.mjs";
import { loadOrCreateIdentity, trustPeer } from "./node-identity.mjs";

// A request deadline is what separates "the peer is gone" (CONNECTION_LOST) from "the peer
// accepted and went silent" (REQUEST_TIMEOUT). Without it a wedged peer holds the caller —
// and, upstream, an MCP concurrency slot — forever (SR-004/023/043).
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
// A spawn legitimately takes longer: a provider child has to come up before it answers.
export const SPAWN_REQUEST_TIMEOUT_MS = 180_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
// Async turn delivery (node/send acks after delivery, not completion). The ACK window is
// short — delivery is near-instant. The TURN deadline is the real bound on a legitimately
// long remote turn (the old 120s REQUEST_TIMEOUT made a >2min turn look like a failure);
// each poll RPC waits only TURN_POLL_REQUEST_TIMEOUT_MS while the turn runs in the
// background, so no single request holds an edge pending slot for the whole turn.
export const SEND_ACK_TIMEOUT_MS = 30_000;
export const SEND_TURN_TIMEOUT_MS = 30 * 60_000;
export const TURN_POLL_REQUEST_TIMEOUT_MS = 30_000;
export const TURN_POLL_INTERVAL_MS = 2000;
// TCP-level keepalive catches a peer whose machine vanished without a FIN.
const KEEPALIVE_DELAY_MS = 15_000;

/**
 * Connect to a peer node over TLS-PSK. Resolves to
 * `{ request(method, params, {timeoutMs}), close(), onClose(fn), peer, peerReady }`.
 * Callers wanting a SHARED socket should go through the pool (openRemoteSession); this
 * opens a dedicated one.
 *
 * The socket is a SYMMETRIC edge (node-edge.mjs): the peer may send requests back over it.
 * `identity` (this machine's Ed25519 identity) is presented via the hello handshake when
 * given; `pinnedFingerprint` fails the edge closed if the peer cannot prove it (P3).
 * `onRequest` handles requests the PEER sends us (the mesh keeper passes one; ordinary
 * callers serve nothing).
 */
export function connectNode({ host, port, token, connectTimeoutMs = 5000, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, identity = null, pinnedFingerprint = null, trustPeer: trustPeerFn, onRequest = undefined }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host, port,
      // The identity names WHICH accepted token we hold, so a node can key a set of them.
      pskCallback: () => ({ psk: pskFromToken(token), identity: identityForToken(token) }),
      ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
      // PSK authenticates the server (it must hold the same token); no cert to verify.
      checkServerIdentity: () => undefined,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(Object.assign(new Error(`connectNode: timed out connecting to ${host}:${port}`), { code: "CONNECT_TIMEOUT" }));
    }, connectTimeoutMs);

    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.setKeepAlive(true, KEEPALIVE_DELAY_MS);
      socket.removeAllListeners("error");
      const edge = attachEdge({
        socket, label: `${host}:${port}`, identity,
        pinnedFingerprint,
        trustPeer: trustPeerFn ?? ((n, fp) => trustPeer(n, fp, pinnedFingerprint)),
        requestTimeoutMs,
        ...(onRequest ? { onRequest } : {}),
      });
      const conn = {
        request: (method, params = {}, opts) => edge.request(method, { ...params, token }, opts),
        onClose: (fn) => edge.onClose(fn),
        get destroyed() { return edge.destroyed; },
        close: () => edge.close(),
        // P3 surface: who is on the other end (null until the hello handshake settles).
        get peer() { return edge.peer; },
        get legacy() { return edge.legacy; },
        peerReady: edge.peerReady,
      };
      // A PIN changes the contract: the caller asked for one specific machine, so the
      // connection is only ESTABLISHED once the peer has proved it — an unprovable or
      // legacy peer rejects here rather than serving one unauthenticated request first.
      if (pinnedFingerprint) {
        edge.peerReady.then((r) => {
          if (r.verified) resolve(conn);
          else {
            edge.close();
            // No provable identity at all (legacy or silent) = IDENTITY_REQUIRED; a
            // proof that failed or mismatched the pin = IDENTITY_UNTRUSTED.
            const code = (r.legacy || r.error) ? "IDENTITY_REQUIRED" : "IDENTITY_UNTRUSTED";
            reject(Object.assign(new Error(r.error ?? "peer identity could not be verified"), { code }));
          }
        });
      } else {
        resolve(conn);
      }
    });
  });
}

/**
 * The identity this process presents on outbound edges, loaded lazily and cached: any
 * fabric process (serve, an MCP server) speaks FOR this machine, so all of them share
 * the machine key in journalDir(). Optional for a caller — a null identity connects as
 * an anonymous legacy client exactly as before.
 */
let _identity = null;
export function localIdentity() {
  if (!_identity) _identity = loadOrCreateIdentity();
  return _identity;
}

// ── Connection pool: one socket per host:port:token, refcounted ──────
//
// A pooled socket is shared by every session on that peer, so its drop reaps that peer's
// OWNED (non-shared) sessions in one go rather than one at a time — the same trade the
// per-session socket already made, now taken once. Sessions spawned `shared` are exempt
// server-side and survive it.

const pool = new Map(); // key → {host, port, fingerprint, refs, conn, promise, timer}
const keyOf = (host, port, token) => `${host}:${port}:${token}`;
let heartbeatMs = null; // null → HEARTBEAT_INTERVAL_MS; test hook below overrides it
// Test/env hooks for the async-send turn window: null → the exported constants. Env lets a
// daemon tune the wall-clock bound without code; the setters let a test shrink it fast.
let sendTurnTimeoutMs = null;
let turnPollIntervalMs = null;
const turnTimeout = () => sendTurnTimeoutMs ?? (Number(process.env.FABRIC_SEND_TURN_TIMEOUT_MS) || SEND_TURN_TIMEOUT_MS);
const pollInterval = () => turnPollIntervalMs ?? (Number(process.env.FABRIC_TURN_POLL_MS) || TURN_POLL_INTERVAL_MS);

// Connectivity failures that justify trying the mesh route (P1): the target's subnet
// filters us — but the LOCAL daemon may hold an edge to it (it can dial out, or the
// target dialed in). Auth/handshake failures are NOT routable: they fail the same way
// through any path.
const ROUTABLE = new Set(["CONNECT_TIMEOUT", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Reach a node THROUGH the local daemon's mesh (P1 reversal + P2 relay): connect to
 * 127.0.0.1:<serve port> and relay every request as node/forward {target}. The returned
 * object walks and talks like a direct connection.
 */
async function connectViaLocalMesh({ target, local }) {
  const conn = await connectNode({ host: local.host, port: local.port, token: local.token, connectTimeoutMs: 3000 });
  // Fail fast if the local daemon is pre-mesh (no node/forward) or holds no route: a
  // cheap forward probe turns "it looked connected" into a verdict before a spawn rides it.
  try {
    await conn.request("node/forward", { target, method: "node/status", params: { detail: "light" } }, { timeoutMs: 10000 });
  } catch (e) {
    conn.close();
    throw Object.assign(
      new Error(`no route to "${target}": direct dial failed AND the local mesh (${local.host}:${local.port}) cannot reach it either (${e.code ?? ""} ${e.message})`.trim()),
      { code: "ROUTE_UNAVAILABLE", target });
  }
  return {
    request: (method, params = {}, opts) => conn.request("node/forward", { target, method, params }, opts),
    onClose: (fn) => conn.onClose(fn),
    get destroyed() { return conn.destroyed; },
    close: () => conn.close(),
    get peer() { return conn.peer; },
    get legacy() { return conn.legacy; },
    peerReady: conn.peerReady,
    via: target,
  };
}

/** Test hook: shorten (or restore, with null) the pool heartbeat interval. */
export function _setPoolHeartbeatMs(ms) { heartbeatMs = ms; }

/** Test hook: bound (or restore, with null) the async-send turn window. */
export function _setSendTurnTimeoutMs(ms) { sendTurnTimeoutMs = ms; }

/** Test hook: shorten (or restore, with null) the node/turn poll cadence. */
export function _setTurnPollIntervalMs(ms) { turnPollIntervalMs = ms; }

/** Observability: one row per pooled connection. Never carries the token itself. */
export function poolStats() {
  return [...pool.values()].map((e) => ({
    host: e.host, port: e.port, fingerprint: e.fingerprint, refs: e.refs,
    alive: !!e.conn && !e.conn.destroyed,
  }));
}

function evict(key, entry) {
  if (pool.get(key) !== entry) return;
  pool.delete(key);
  clearInterval(entry.timer);
}

function startHeartbeat(key, entry) {
  const every = heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
  entry.timer = setInterval(() => {
    if (!entry.conn || entry.conn.destroyed) return evict(key, entry);
    // The cheapest call the protocol has; a peer that cannot answer it is not usable, so
    // destroying the socket is what turns a half-open connection into CONNECTION_LOST
    // at every pending request instead of a hang at the next send.
    entry.conn.request("node/status", { detail: "light" }, { timeoutMs: HEARTBEAT_TIMEOUT_MS })
      .catch(() => { evict(key, entry); entry.conn.close(); });
  }, every);
  entry.timer.unref?.();
}

/** Acquire the shared connection to a peer, incrementing its refcount.
 *  `route` (optional): {target, local:{host,port,token}} — if the direct dial fails with
 *  a connectivity error, fall back to relaying through the LOCAL daemon's mesh edge. */
async function acquire({ host, port, token, route = null }) {
  const key = route ? `via:${route.local.host}:${route.local.port}→${route.target}:${token}` : keyOf(host, port, token);
  let entry = pool.get(key);
  if (entry && entry.conn?.destroyed) { evict(key, entry); entry = undefined; }
  if (!entry) {
    entry = { host, port, fingerprint: identityForToken(token).split(":")[1], refs: 0, conn: null, timer: null };
    entry.promise = connectNode({ host, port, token, identity: localIdentity() })
      .catch(async (e) => {
        if (!route || !ROUTABLE.has(e.code)) throw e;
        return connectViaLocalMesh(route);
      })
      .then((conn) => {
        entry.conn = conn;
        conn.onClose(() => evict(key, entry));
        startHeartbeat(key, entry);
        return conn;
      }, (e) => { evict(key, entry); throw e; });
    pool.set(key, entry);
  }
  entry.refs++;
  let released = false;
  try {
    const conn = await entry.promise;
    return {
      conn,
      release() {
        if (released) return;
        released = true;
        if (--entry.refs <= 0) { evict(key, entry); conn.close(); }
      },
    };
  } catch (e) {
    if (!released) { released = true; entry.refs--; }
    throw e;
  }
}

/** Copy the liveness facts a peer reports onto the handle, where listSessions() reads them. */
function absorbFacts(handle, facts) {
  if (!facts || typeof facts !== "object") return facts;
  if ("alive" in facts) handle.alive = facts.alive;
  if ("pid" in facts && facts.pid != null) handle.pid = facts.pid;
  if ("lastActivity" in facts) handle.lastActivity = facts.lastActivity;
  if ("turns" in facts) handle.turns = facts.turns;
  if ("usage" in facts) handle.usage = facts.usage;
  if ("compacted" in facts) handle.compacted = facts.compacted;
  if ("compactable" in facts) handle.compactable = facts.compactable;
  return facts;
}

/** The shared shape of a remote handle, over an already-acquired pooled connection. */
function remoteHandle({ id, pid = null, lease }) {
  const { conn, release } = lease;
  const handle = {
    id,
    pid,
    // Liveness/cost facts, filled in by ping() and close(); null until observed, never
    // guessed (SR-005: a handle must not claim alive by default).
    alive: null,
    lastActivity: null,
    usage: null,
    // Async send: node/send acks on DELIVERY (fast), then we poll node/turn until the turn
    // settles — bounded by a long TURN deadline while each poll RPC waits only a short
    // window. A legitimately long turn (minutes) no longer trips the old 120s request
    // deadline; a wedged session is still caught by the turn deadline (TURN_TIMEOUT) and a
    // dead peer by CONNECTION_LOST on any poll. The {text, turn} contract is unchanged, so
    // sendToSession and everything above it read the result exactly as before.
    send: async (text) => {
      const ack = await conn.request("node/send", { id, prompt: text }, { timeoutMs: SEND_ACK_TIMEOUT_MS });
      const seq = ack?.seq;
      const deadline = Date.now() + turnTimeout();
      for (;;) {
        const t = await conn.request("node/turn", { id, seq }, { timeoutMs: TURN_POLL_REQUEST_TIMEOUT_MS });
        if (t.state === "done") return { text: t.text, turn: t.turn };
        if (t.state === "error") {
          const err = new Error(t.error);
          err.code = t.code ?? "TURN_ERROR";
          throw err;
        }
        if (t.state === "idle") break; // consumed or never started — the result is unrecoverable
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, pollInterval()));
      }
      const err = new Error(`node turn ${seq} on session ${id} did not complete within ${turnTimeout()}ms`);
      err.code = "TURN_TIMEOUT";
      throw err;
    },
    // Compact runs on the peer (node/compact), same ownership gate as send/close.
    compact: () => conn.request("node/compact", { id }),
    // Native goal: set and/or run — the autonomous loop runs on the PEER and the
    // drained final result comes back (node/goal).
    goal: (opts) => conn.request("node/goal", { id, ...opts }),
    ping: async () => absorbFacts(handle, await conn.request("node/ping", { id })),
    // Content view forwards to the peer's node/view — a nested remote (session on C
    // managed via B) keeps working because the peer forwards in turn.
    view: (opts) => conn.request("node/view", { id, ...opts }),
    async close() {
      try {
        // node/close reports the real cost facts (SR-011); the registry journals
        // handle.usage, so absorbing them here is what makes them durable. The RETURN
        // stays the exitCode scalar every caller already reads.
        const r = absorbFacts(handle, await conn.request("node/close", { id }));
        handle.exitCode = r?.exitCode ?? null;
        return handle.exitCode;
      } finally { release(); }
    },
  };
  return handle;
}

/**
 * Open a session on a remote node, returning the uniform provider-session handle.
 * @param {object} opts  host, port, token, provider (required), model?, write?, project?
 *   route? — {target, local:{host,port,token}}: on a connectivity failure, relay through
 *   the LOCAL daemon's mesh (P1/P2). The handle behaves identically either way.
 */
export async function openRemoteSession(opts) {
  const { host, port, token, provider, model, write, project, profile, visible, interactive, effort, shared, route = null } = opts;
  if (!provider) throw new Error("openRemoteSession: provider is required");
  const lease = await acquire({ host, port, token, route });
  try {
    const desc = await lease.conn.request("node/spawn", {
      provider, model, write: !!write, project, profile: profile ?? null,
      visible: !!visible, interactive: !!interactive, effort: effort ?? null, shared: !!shared,
    }, { timeoutMs: SPAWN_REQUEST_TIMEOUT_MS });
    return remoteHandle({ id: desc.id, pid: desc.pid ?? null, lease });
  } catch (e) {
    lease.release();
    throw e;
  }
}

/**
 * Attach to an EXISTING session on a peer (shared, or owned by a dead connection whose
 * record survived). Same uniform handle; close() closes the REMOTE session.
 */
export async function attachRemoteSession({ host, port, token, id, route = null }) {
  const lease = await acquire({ host, port, token, route });
  return remoteHandle({ id, lease });
}
