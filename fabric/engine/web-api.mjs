// engine/web-api.mjs — the local management console's JSON API, as a PURE handler:
// (method, path, body) → { status, body }. HTTP wiring and the HTML shell live in
// scripts/web.mjs; this module is what the tests exercise.
//
// Scope, honestly stated: the console CHATS with sessions this process spawned (local
// or remote via node) — a peer session owned by another connection is observable
// through node/status but not drivable (node/send is owner-restricted, by design).
// The console holds a per-session message log so the UI can render a conversation;
// the durable trail stays in the journal, as everywhere else.

import { readFileSync, existsSync } from "node:fs";
import { createSession, sendToSession, closeSession, listSessions, pingSession } from "./session.mjs";
import { reconcile, recordEvent } from "./journal.mjs";
import { loadFabricConfig } from "./node-config.mjs";
import { connectNode } from "./node-client.mjs";
import { getConfigPath } from "./providers.mjs";
import { liveCatalogue } from "./catalogue.mjs";
import { loadServeConfig } from "./node-config.mjs";
import { attachSession } from "./session.mjs";

/**
 * Structured provider/model/node catalogue for UI dropdowns. Models are the tier
 * ALIASES the config maps (haiku/sonnet/opus/fable); an empty list means "the
 * provider picks its default" (codex). Nodes come from fabric.nodes; "" = local.
 */
export function catalogue({ _config = loadFabricConfig, _configPath = getConfigPath } = {}) {
  const providers = [
    { name: "claude", models: ["haiku", "sonnet", "opus"] },
    { name: "codex", models: [] },
  ];
  try {
    const p = _configPath();
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf8"));
      for (const k of Object.keys(cfg)) {
        if (!k.startsWith("env:")) continue;
        const env = cfg[k];
        if (!env.ANTHROPIC_BASE_URL && !env.ANTHROPIC_FOUNDRY_BASE_URL) continue;
        const models = [];
        if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) models.push("haiku");
        if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) models.push("sonnet");
        if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) models.push("opus");
        if (env.ANTHROPIC_DEFAULT_FABLE_MODEL) models.push("fable");
        providers.push({ name: k.slice(4), models });
      }
    }
  } catch { /* config unreadable: builtin providers only */ }
  let nodes = [];
  try { nodes = Object.keys(_config().nodes || {}); } catch { /* no fabric block */ }
  return { providers, nodes, efforts: ["low", "medium", "high", "max"] };
}

/** Probe every configured node for its status facts (the ping.mjs logic, reusable). */
export async function pingNodes({ _connect = connectNode, _config = loadFabricConfig } = {}) {
  const fc = _config();
  const out = [];
  for (const [name, n] of Object.entries(fc.nodes || {})) {
    try {
      const conn = await _connect({ host: n.host, port: n.port, token: n.token || fc.token, connectTimeoutMs: 3000 });
      const st = await conn.request("node/status", {});
      conn.close();
      out.push({ name, alive: true, ...st });
    } catch (e) {
      out.push({ name, alive: false, error: String(e.message).slice(0, 120) });
    }
  }
  return out;
}

export function createWebApi(deps = {}) {
  const _create = deps.createSession || createSession;
  const _send = deps.sendToSession || sendToSession;
  const _close = deps.closeSession || closeSession;
  const _list = deps.listSessions || listSessions;
  const _ping = deps.pingSession || pingSession;
  const _nodes = deps.pingNodes || pingNodes;
  const _reconcile = deps.reconcile || reconcile;
  const _catalogue = deps.catalogue || liveCatalogue;
  const _attach = deps.attachSession || attachSession;

  const logs = new Map(); // sessionId → [{role, text, ts}]
  const log = (id, role, text) => {
    if (!logs.has(id)) logs.set(id, []);
    logs.get(id).push({ role, text, ts: Date.now() });
  };

  async function handle(method, path, body) {
    try {
      if (method === "GET" && path === "/api/nodes") return { status: 200, body: await _nodes() };
      if (method === "GET" && path.startsWith("/api/catalogue")) {
        return { status: 200, body: _catalogue({ force: path.includes("force=1") }) };
      }
      if (method === "GET" && path === "/api/fleet") {
        // Machines = configured nodes, with THIS machine identified (serve name match),
        // each carrying projects + sessions (shared/project flags from node/status) and
        // the console's own in-process sessions folded under the self machine.
        const machines = await _nodes();
        let selfName = null;
        try { selfName = loadServeConfig().name; } catch { /* no serve block */ }
        const own = _list();
        const ownByNode = (n) => own.filter((s2) => (s2.node ?? selfName) === n);
        return { status: 200, body: machines.map((mch) => ({
          ...mch,
          self: mch.name === selfName,
          console_sessions: ownByNode(mch.name).map((s2) => ({ ...s2, chattable: true })),
        })) };
      }
      if (method === "POST" && path === "/api/attach") {
        if (!body?.node || !body?.remoteId) return { status: 400, body: { error: "node and remoteId are required" } };
        const desc = await _attach({ node: body.node, remoteId: body.remoteId });
        logs.set(desc.id, []);
        return { status: 200, body: desc };
      }
      if (method === "GET" && path === "/api/sessions") {
        return { status: 200, body: _list().map((s) => ({ ...s, chattable: logs.has(s.id) })) };
      }
      if (method === "GET" && path === "/api/reconcile") return { status: 200, body: _reconcile() };
      if (method === "POST" && path === "/api/reconcile/clear") {
        if (!body?.id) return { status: 400, body: { error: "id is required" } };
        // Clearing = journaling the loss; the record stays (append-only), reconcile stops
        // reporting it. Only for records the operator has judged dead.
        (deps.recordEvent || recordEvent)({ event: "loss", id: body.id, reason: "cleared from console" });
        return { status: 200, body: { id: body.id, cleared: true } };
      }

      if (method === "POST" && path === "/api/sessions") {
        if (!body?.provider) return { status: 400, body: { error: "provider is required" } };
        const desc = await _create({
          provider: body.provider, model: body.model || undefined,
          node: body.node || undefined, project: body.project || undefined,
          profile: body.profile || undefined, effort: body.effort || undefined,
          write: !!body.write, visible: !!body.visible, interactive: !!body.interactive,
          // Sessions opened on a node default to SHARED so any machine's console can
          // manage them; body.shared=false opts out.
          shared: body.node ? body.shared !== false : false,
        });
        logs.set(desc.id, []);
        return { status: 200, body: desc };
      }

      let m;
      if (method === "POST" && (m = path.match(/^\/api\/sessions\/([^/]+)\/send$/))) {
        if (!body?.prompt?.trim()) return { status: 400, body: { error: "prompt is required" } };
        const id = m[1];
        log(id, "user", body.prompt);
        const res = await _send(id, body.prompt);
        log(id, "assistant", res.text);
        return { status: 200, body: res };
      }
      if (method === "POST" && (m = path.match(/^\/api\/sessions\/([^/]+)\/close$/))) {
        const res = await _close(m[1]);
        return { status: 200, body: res };
      }
      if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)\/ping$/))) {
        return { status: 200, body: await _ping(m[1]) };
      }
      if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)\/log$/))) {
        return { status: 200, body: { id: m[1], messages: logs.get(m[1]) ?? [] } };
      }
      return { status: 404, body: { error: `no route: ${method} ${path}` } };
    } catch (e) {
      return { status: 500, body: { error: String(e?.message ?? e) } };
    }
  }

  return { handle };
}
