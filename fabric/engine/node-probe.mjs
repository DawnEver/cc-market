// engine/node-probe.mjs — probe every configured fabric node for its status facts,
// concurrently, each with its own deadline (one wedged peer must not hold the fleet view;
// SR-043). Shared by the MCP `list_nodes` tool and the web management console; ping.mjs
// keeps its own probe because it formats ALIVE/DEAD lines and an exit code.

import { connectNode, localIdentity } from "./node-client.mjs";
import { loadFabricConfig, loadServeConfig } from "./node-config.mjs";

// Connectivity failures worth retrying through the LOCAL daemon's mesh (P1/P2): the
// target may be unreachable from THIS box while the local daemon holds an edge to it.
const ROUTABLE = new Set(["CONNECT_TIMEOUT", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Probe every configured node for its status facts.
 * @param detail 'light' (counts + per-session liveness) or 'full' (adds usage/turns/pid).
 *   Ask for what the VIEW renders: the console polls every few seconds across every node,
 *   so a usage object per session is paid for on every tick (SR-029/046).
 * Returns [{ name, alive:true, ...status } | { name, alive:false, error }]. A node reached
 * through the local mesh relay reports alive with `via` naming the relay path.
 */
export async function pingNodes({ _connect = connectNode, _config = loadFabricConfig, detail = "light" } = {}) {
  const fc = _config();
  const probe = async ([name, n]) => {
    let conn = null;
    try {
      conn = await _connect({ host: n.host, port: n.port, token: n.token || fc.token, connectTimeoutMs: 3000 });
      const st = await conn.request("node/status", { detail }, { timeoutMs: 10000 });
      return { name, alive: true, ...st };
    } catch (e) {
      if (!ROUTABLE.has(e.code)) {
        return { name, alive: false, error: `${e.code ? `${e.code}: ` : ""}${String(e.message).slice(0, 300)}` };
      }
      // P1 fallback: ask the LOCAL daemon to relay one status request over its mesh edge.
      try {
        const serve = loadServeConfig();
        const localToken = serve.token || fc.token;
        if (!localToken) throw e;
        const local = await _connect({ host: "127.0.0.1", port: serve.port ?? 7677, token: localToken, connectTimeoutMs: 2000, identity: localIdentity() });
        try {
          const st = await local.request("node/forward", { target: name, method: "node/status", params: { detail } }, { timeoutMs: 12000 });
          return { name, alive: true, ...st, via: "local-mesh relay" };
        } finally { local.close(); }
      } catch (e2) {
        return { name, alive: false, error: `${e.code}: direct dial failed; relay via local mesh failed too (${String(e2.message).slice(0, 200)})` };
      }
    } finally { conn?.close(); }
  };
  return Promise.all(Object.entries(fc.nodes || {}).map(probe));
}
