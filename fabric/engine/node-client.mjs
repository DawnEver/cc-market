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
  PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken, identityForToken, MAX_LINE_BYTES,
} from "./node-tls.mjs";

// A request deadline is what separates "the peer is gone" (CONNECTION_LOST) from "the peer
// accepted and went silent" (REQUEST_TIMEOUT). Without it a wedged peer holds the caller —
// and, upstream, an MCP concurrency slot — forever (SR-004/023/043).
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
// A spawn legitimately takes longer: a provider child has to come up before it answers.
export const SPAWN_REQUEST_TIMEOUT_MS = 180_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
// TCP-level keepalive catches a peer whose machine vanished without a FIN.
const KEEPALIVE_DELAY_MS = 15_000;

/**
 * Connect to a peer node over TLS-PSK. Resolves to
 * `{ request(method, params, {timeoutMs}), close(), onClose(fn) }`.
 * Callers wanting a SHARED socket should go through the pool (openRemoteSession); this
 * opens a dedicated one.
 */
export function connectNode({ host, port, token, connectTimeoutMs = 5000, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
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
      const pending = new Map(); // id → {resolve, reject, timer}
      const closeHandlers = new Set();
      let seq = 0;
      let buf = "";

      socket.removeAllListeners("error");
      // Structured loss (G5): a dropped peer rejects with code CONNECTION_LOST so the
      // layer above can requeue by code, not by parsing prose.
      // Why this connection died, remembered: a request issued after the fact must report
      // the CAUSE (a flooding peer) and not just the symptom (the socket is gone).
      let deathError = null;
      const lostError = (why) => deathError ?? Object.assign(
        new Error(`node connection lost (${host}:${port}): ${why}`),
        { code: "CONNECTION_LOST", host, port },
      );
      const failAll = (err) => {
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
        pending.clear();
      };
      const fail = (why) => failAll(lostError(why));
      socket.on("error", (e) => { fail(e.message); socket.destroy(); });
      socket.on("close", () => {
        fail("closed");
        for (const fn of closeHandlers) { try { fn(); } catch { /* observer only */ } }
        closeHandlers.clear();
      });
      socket.on("data", (chunk) => {
        buf += chunk;
        // Mirror the server's line cap (SR-030): an unbounded buffer is the same DoS in
        // this direction, and a peer that never sends a newline is not a peer we can talk to.
        if (buf.length > MAX_LINE_BYTES) {
          deathError = Object.assign(
            new Error(`node response exceeded ${MAX_LINE_BYTES} bytes without a newline (${host}:${port})`),
            { code: "RESPONSE_TOO_LARGE", host, port },
          );
          failAll(deathError);
          buf = "";
          socket.destroy();
          return;
        }
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let rpc;
          try { rpc = JSON.parse(line); } catch { continue; }
          const p = pending.get(rpc.id);
          if (!p) continue; // no pending entry: a reply to a request that already timed out
          clearTimeout(p.timer);
          pending.delete(rpc.id);
          if (rpc.error) {
            const err = new Error(rpc.error.message || "node error");
            err.code = rpc.error.code;
            if (rpc.error.data !== undefined) err.data = rpc.error.data;
            p.reject(err);
          } else p.resolve(rpc.result);
        }
      });

      resolve({
        request(method, params = {}, { timeoutMs = requestTimeoutMs } = {}) {
          return new Promise((res, rej) => {
            if (socket.destroyed) return rej(lostError("closed"));
            const id = ++seq;
            // Deleting the pending entry IS the drop of any late reply: the data handler
            // finds no entry for that id and moves on.
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(Object.assign(
                new Error(`node request ${method} timed out after ${timeoutMs}ms (${host}:${port})`),
                { code: "REQUEST_TIMEOUT", host, port, method },
              ));
            }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer });
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, token } })}\n`);
          });
        },
        onClose(fn) { if (socket.destroyed) fn(); else closeHandlers.add(fn); },
        get destroyed() { return socket.destroyed; },
        close() { socket.destroy(); },
      });
    });
  });
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

/** Test hook: shorten (or restore, with null) the pool heartbeat interval. */
export function _setPoolHeartbeatMs(ms) { heartbeatMs = ms; }

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

/** Acquire the shared connection to a peer, incrementing its refcount. */
async function acquire({ host, port, token }) {
  const key = keyOf(host, port, token);
  let entry = pool.get(key);
  if (entry && entry.conn?.destroyed) { evict(key, entry); entry = undefined; }
  if (!entry) {
    entry = { host, port, fingerprint: identityForToken(token).split(":")[1], refs: 0, conn: null, timer: null };
    entry.promise = connectNode({ host, port, token }).then((conn) => {
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
    send: (text) => conn.request("node/send", { id, prompt: text }),
    // Compact runs on the peer (node/compact), same ownership gate as send/close.
    compact: () => conn.request("node/compact", { id }),
    // Native goal: set and/or run — the autonomous loop runs on the PEER and the
    // drained final result comes back (node/goal).
    goal: (opts) => conn.request("node/goal", { id, ...opts }),
    ping: async () => absorbFacts(handle, await conn.request("node/ping", { id })),
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
 */
export async function openRemoteSession(opts) {
  const { host, port, token, provider, model, write, project, profile, visible, interactive, effort, shared } = opts;
  if (!provider) throw new Error("openRemoteSession: provider is required");
  const lease = await acquire({ host, port, token });
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
export async function attachRemoteSession({ host, port, token, id }) {
  const lease = await acquire({ host, port, token });
  return remoteHandle({ id, lease });
}
