// engine/node-server.mjs — the LAN node server: exposes this machine's provider sessions
// to peer fabric nodes over TCP (newline-delimited JSON-RPC 2.0). Started by
// `scripts/serve.mjs`; a peer's openRemoteSession (node-client.mjs) is the counterpart.
//
// Pure message-passing: peers spawn/drive/close sessions here by id; the session runs in
// THIS machine's project directory (resolved from a project ALIAS registered in this
// server's config) with this machine's credentials. No file transfer, no shared paths.
//
// Methods (every request must carry the shared token in params.token):
//   node/status  → { name, sessions }
//   node/spawn   { provider, model?, write?, project? } → { id, provider, nativeId }
//   node/send    { id, prompt } → { text, turn }
//   node/close   { id } → { id, exitCode, turns }

import net from "node:net";
import process from "node:process";
import { createSession, sendToSession, closeSession, listSessions } from "./session.mjs";

export const AUTH_ERROR = -32001;

export function createNodeServer({ token, name = null, projects = {}, deps = {} } = {}) {
  if (!token) throw new Error("createNodeServer: a token is required (set fabric.token in claude_env_settings.json)");
  const _createSession = deps.createSession || createSession;
  const _sendToSession = deps.sendToSession || sendToSession;
  const _closeSession = deps.closeSession || closeSession;
  const _listSessions = deps.listSessions || listSessions;

  async function dispatch(method, params) {
    switch (method) {
      case "node/status":
        return { name, sessions: _listSessions() };
      case "node/spawn": {
        if (!params.provider) throw new Error("node/spawn: provider is required");
        let cwd;
        if (params.project != null) {
          cwd = projects[params.project];
          if (!cwd) throw new Error(`node/spawn: unknown project alias "${params.project}" on this node. Available: ${Object.keys(projects).join(", ") || "(none)"}`);
        }
        return _createSession({
          provider: params.provider, model: params.model, write: !!params.write,
          cwd: cwd || process.cwd(), observe: false,
        });
      }
      case "node/send":
        if (!params.id || !params.prompt) throw new Error("node/send: id and prompt are required");
        return _sendToSession(params.id, params.prompt);
      case "node/close":
        if (!params.id) throw new Error("node/close: id is required");
        return _closeSession(params.id);
      default:
        throw new Error(`Method not found: ${method}`);
    }
  }

  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const reply = (rpc) => { try { socket.write(`${JSON.stringify(rpc)}\n`); } catch { /* socket gone */ } };

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; } // garbage on the wire: ignore
        const { id, method, params = {} } = req;
        if (params.token !== token) {
          reply({ jsonrpc: "2.0", id, error: { code: AUTH_ERROR, message: "unauthorized: bad or missing token" } });
          continue;
        }
        // Dispatch WITHOUT awaiting so long turns don't block other requests on this socket.
        dispatch(method, params).then(
          (result) => reply({ jsonrpc: "2.0", id, result }),
          (e) => reply({ jsonrpc: "2.0", id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }),
        );
      }
    });
  });

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
