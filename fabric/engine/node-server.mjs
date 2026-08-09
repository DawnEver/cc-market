// engine/node-server.mjs — the LAN node server: exposes this machine's provider sessions
// to peer fabric nodes over TCP (newline-delimited JSON-RPC 2.0). Started by
// `scripts/serve.mjs`; a peer's openRemoteSession (node-client.mjs) is the counterpart.
//
// Pure message-passing: peers spawn/drive/close sessions here by id; the session runs in
// THIS machine's project directory (resolved from a project ALIAS registered in this
// server's config) with this machine's credentials. No file transfer, no shared paths.
//
// Methods (every request must carry the shared token in params.token):
//   node/status  → { name, version, uptime_s, cpu, mem_available_mb, mem_total_mb, tags, sessions }
//   node/spawn   { provider, model?, write?, project? } → { id, provider, nativeId, pid }
//   node/send    { id, prompt } → { text, turn }
//   node/ping    { id } → { id, provider, alive, pid, turns, lastActivity }
//   node/close   { id } → { id, exitCode, turns }
//
// Sessions are OWNED by the connection that spawned them: node/send and node/close only
// accept ids owned by that connection, and when a socket drops its sessions are closed
// (best-effort) so a dead peer can't leak children. node/status still lists all sessions.

import tls from "node:tls";
import crypto from "node:crypto";
import os from "node:os";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, sendToSession, closeSession, listSessions, pingSession } from "./session.mjs";
import { PSK_IDENTITY, PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken } from "./node-tls.mjs";

export const AUTH_ERROR = -32001;
export const MAX_LINE_BYTES = 1024 * 1024; // per-socket buffer cap: an unbounded line is a DoS

// Hash both sides so lengths always match — timingSafeEqual throws on length mismatch.
const digest = (s) => crypto.createHash("sha256").update(String(s)).digest();
const tokenMatches = (given, expected) => crypto.timingSafeEqual(digest(given), digest(expected));

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Plugin version, best-effort: a peer scheduling against this node deserves to know
// which fabric it is talking to.
function pluginVersion() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", ".claude-plugin", "plugin.json");
    return JSON.parse(readFileSync(p, "utf8")).version ?? "unknown";
  } catch { return "unknown"; }
}

export function createNodeServer({ token, name = null, projects = {}, tags = [], deps = {} } = {}) {
  if (!token) throw new Error("createNodeServer: a token is required (set fabric.token in claude_env_settings.json)");
  const _createSession = deps.createSession || createSession;
  const _sendToSession = deps.sendToSession || sendToSession;
  const _closeSession = deps.closeSession || closeSession;
  const _listSessions = deps.listSessions || listSessions;
  const _pingSession = deps.pingSession || pingSession;
  const startedAt = Date.now();

  // -32601 unknown method, -32602 missing/invalid params, -32000 runtime failure.
  async function dispatch(method, params, owned) {
    switch (method) {
      case "node/status":
        // Capacity facts (G1): what a scheduler needs to ADMIT, reported not decided.
        return {
          name, version: pluginVersion(), uptime_s: Math.round((Date.now() - startedAt) / 1000),
          cpu: os.cpus().length,
          mem_available_mb: Math.round(os.freemem() / 1048576),
          mem_total_mb: Math.round(os.totalmem() / 1048576),
          tags, sessions: _listSessions(),
        };
      case "node/spawn": {
        if (!params.provider) throw new RpcError(-32602, "node/spawn: provider is required");
        let cwd;
        if (params.project != null) {
          cwd = projects[params.project];
          if (!cwd) throw new RpcError(-32602, `node/spawn: unknown project alias "${params.project}" on this node. Available: ${Object.keys(projects).join(", ") || "(none)"}`);
        }
        const desc = await _createSession({
          provider: params.provider, model: params.model, write: !!params.write,
          cwd: cwd || process.cwd(), observe: false,
        });
        owned.add(desc.id);
        return desc;
      }
      case "node/send":
        if (!params.id || !params.prompt) throw new RpcError(-32602, "node/send: id and prompt are required");
        if (!owned.has(params.id)) throw new RpcError(-32602, `node/send: session "${params.id}" is not owned by this connection`);
        return _sendToSession(params.id, params.prompt);
      case "node/ping":
        // Read-only liveness (G3): like node/status, not restricted to the owner.
        if (!params.id) throw new RpcError(-32602, "node/ping: id is required");
        return _pingSession(params.id);
      case "node/close":
        if (!params.id) throw new RpcError(-32602, "node/close: id is required");
        if (!owned.has(params.id)) throw new RpcError(-32602, `node/close: session "${params.id}" is not owned by this connection`);
        return _closeSession(params.id).then((r) => { owned.delete(params.id); return r; });
      default:
        throw new RpcError(-32601, `Method not found: ${method}`);
    }
  }

  const sockets = new Set();
  // TLS-PSK: the shared token IS the credential — wrong token fails the handshake, and all
  // traffic is encrypted. No certificates to manage (see engine/node-tls.mjs).
  const server = tls.createServer({
    pskCallback: (_socket, identity) => (identity === PSK_IDENTITY ? pskFromToken(token) : null),
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
    const reply = (rpc) => { try { socket.write(`${JSON.stringify(rpc)}\n`); } catch { /* socket gone */ } };

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
        if (params.token === undefined || !tokenMatches(params.token, token)) {
          if (!notification) reply({ jsonrpc: "2.0", id, error: { code: AUTH_ERROR, message: "unauthorized: bad or missing token" } });
          continue;
        }
        // Dispatch WITHOUT awaiting so long turns don't block other requests on this socket.
        dispatch(method, params, owned).then(
          (result) => { if (!notification) reply({ jsonrpc: "2.0", id, result }); },
          (e) => { if (!notification) reply({ jsonrpc: "2.0", id, error: { code: e.code ?? -32000, message: e instanceof Error ? e.message : String(e) } }); },
        );
      }
    });
  });

  // A failed handshake (wrong PSK, non-TLS client) must not crash the server.
  server.on("tlsClientError", (e) => process.stderr.write(`fabric node: TLS handshake failed: ${e.message}\n`));

  return {
    listen(port = 0, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve({ port: server.address().port }));
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
