// engine/node-client.mjs — client side of the LAN node fabric. connectNode() gives a
// multiplexed JSON-RPC connection to a peer node-server; openRemoteSession() wraps it into
// the SAME `{ id, send(text) → {text, turn}, close() }` handle every local provider session
// exposes — so the session registry / teams treat a remote machine exactly like a local
// provider (a teammate you exchange messages with, never a filesystem you reach into).

import tls from "node:tls";
import { PSK_IDENTITY, PSK_CIPHERS, PSK_TLS_VERSION, pskFromToken } from "./node-tls.mjs";

/** Connect to a peer node over TLS-PSK. Resolves to { request(method, params), close() }. */
export function connectNode({ host, port, token, connectTimeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host, port,
      pskCallback: () => ({ psk: pskFromToken(token), identity: PSK_IDENTITY }),
      ciphers: PSK_CIPHERS, minVersion: PSK_TLS_VERSION, maxVersion: PSK_TLS_VERSION,
      // PSK authenticates the server (it must hold the same token); no cert to verify.
      checkServerIdentity: () => undefined,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connectNode: timed out connecting to ${host}:${port}`));
    }, connectTimeoutMs);

    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const pending = new Map(); // id → {resolve, reject}
      let seq = 0;
      let buf = "";

      socket.removeAllListeners("error");
      // Structured loss (G5): a dropped peer rejects with code CONNECTION_LOST so the
      // layer above can requeue by code, not by parsing prose.
      const lostError = (why) => Object.assign(
        new Error(`node connection lost (${host}:${port}): ${why}`),
        { code: "CONNECTION_LOST", host, port },
      );
      const fail = (why) => {
        for (const p of pending.values()) p.reject(lostError(why));
        pending.clear();
      };
      socket.on("error", (e) => { fail(e.message); socket.destroy(); });
      socket.on("close", () => fail("closed"));
      socket.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let rpc;
          try { rpc = JSON.parse(line); } catch { continue; }
          const p = pending.get(rpc.id);
          if (!p) continue;
          pending.delete(rpc.id);
          if (rpc.error) {
            const err = new Error(rpc.error.message || "node error");
            err.code = rpc.error.code;
            p.reject(err);
          } else p.resolve(rpc.result);
        }
      });

      resolve({
        request(method, params = {}) {
          return new Promise((res, rej) => {
            if (socket.destroyed) return rej(lostError("closed"));
            const id = ++seq;
            pending.set(id, { resolve: res, reject: rej });
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, token } })}\n`);
          });
        },
        close() { socket.destroy(); },
      });
    });
  });
}

/**
 * Open a session on a remote node, returning the uniform provider-session handle.
 * One connection per remote session: simple lifecycle, failures stay isolated.
 * @param {object} opts  host, port, token, provider (required), model?, write?, project?
 */
export async function openRemoteSession(opts) {
  const { host, port, token, provider, model, write, project, profile, visible, interactive, effort } = opts;
  if (!provider) throw new Error("openRemoteSession: provider is required");
  const conn = await connectNode({ host, port, token });
  try {
    const desc = await conn.request("node/spawn", { provider, model, write: !!write, project, profile: profile ?? null, visible: !!visible, interactive: !!interactive, effort: effort ?? null });
    return {
      id: desc.id,
      pid: desc.pid ?? null,
      send: (text) => conn.request("node/send", { id: desc.id, prompt: text }),
      ping: () => conn.request("node/ping", { id: desc.id }),
      async close() {
        try { return (await conn.request("node/close", { id: desc.id }))?.exitCode ?? null; }
        finally { conn.close(); }
      },
    };
  } catch (e) {
    conn.close();
    throw e;
  }
}
