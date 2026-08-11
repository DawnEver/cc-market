// engine/node-probe.mjs — probe every configured fabric node for its status facts,
// concurrently, each with its own deadline (one wedged peer must not hold the fleet view;
// SR-043). Shared by the MCP `list_nodes` tool and the web management console; ping.mjs
// keeps its own probe because it formats ALIVE/DEAD lines and an exit code.

import { connectNode } from "./node-client.mjs";
import { loadFabricConfig } from "./node-config.mjs";

/**
 * Probe every configured node for its status facts.
 * @param detail 'light' (counts + per-session liveness) or 'full' (adds usage/turns/pid).
 *   Ask for what the VIEW renders: the console polls every few seconds across every node,
 *   so a usage object per session is paid for on every tick (SR-029/046).
 * Returns [{ name, alive:true, ...status } | { name, alive:false, error }].
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
      return { name, alive: false, error: `${e.code ? `${e.code}: ` : ""}${String(e.message).slice(0, 300)}` };
    } finally { conn?.close(); }
  };
  return Promise.all(Object.entries(fc.nodes || {}).map(probe));
}
