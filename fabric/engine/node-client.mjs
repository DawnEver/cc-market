// engine/node-client.mjs — client side of the LAN node fabric. connectNode() gives a
// multiplexed JSON-RPC connection to a peer node-server; openRemoteSession() wraps it into
// the SAME `{ id, send(text) → {text, turn}, close() }` handle every local provider session
// exposes — so the session registry / teams treat a remote machine exactly like a local
// provider (a teammate you exchange messages with, never a filesystem you reach into).

import net from "node:net";

/** Connect to a peer node. Resolves to { request(method, params), close() }. */
export function connectNode({ host, port, token, connectTimeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connectNode: timed out connecting to ${host}:${port}`));
    }, connectTimeoutMs);

    socket.once("error", (e) => { clearTimeout(timer); reject(e); });
    socket.once("connect", () => {
      clearTimeout(timer);
      const pending = new Map(); // id → {resolve, reject}
      let seq = 0;
      let buf = "";

      socket.removeAllListeners("error");
      const fail = (why) => {
        for (const p of pending.values()) p.reject(new Error(`node connection lost (${host}:${port}): ${why}`));
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
            if (socket.destroyed) return rej(new Error(`node connection lost (${host}:${port}): closed`));
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
  const { host, port, token, provider, model, write, project } = opts;
  if (!provider) throw new Error("openRemoteSession: provider is required");
  const conn = await connectNode({ host, port, token });
  try {
    const desc = await conn.request("node/spawn", { provider, model, write: !!write, project });
    return {
      id: desc.id,
      send: (text) => conn.request("node/send", { id: desc.id, prompt: text }),
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
