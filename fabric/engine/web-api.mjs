// engine/web-api.mjs — the local management console's JSON API, as a PURE handler:
// (method, path, body) → { status, body }. HTTP wiring and the HTML shell live in
// scripts/web.mjs; this module is what the tests exercise.
//
// Scope, honestly stated: the console CHATS with sessions this process spawned (local
// or remote via node) — a peer session owned by another connection is observable
// through node/status but not drivable (node/send is owner-restricted, by design).
// The console holds a per-session message log so the UI can render a conversation;
// the durable trail stays in the journal, as everywhere else.

import { createSession, sendToSession, closeSession, listSessions, pingSession } from "./session.mjs";
import { reconcile } from "./journal.mjs";
import { loadFabricConfig } from "./node-config.mjs";
import { connectNode } from "./node-client.mjs";

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

  const logs = new Map(); // sessionId → [{role, text, ts}]
  const log = (id, role, text) => {
    if (!logs.has(id)) logs.set(id, []);
    logs.get(id).push({ role, text, ts: Date.now() });
  };

  async function handle(method, path, body) {
    try {
      if (method === "GET" && path === "/api/nodes") return { status: 200, body: await _nodes() };
      if (method === "GET" && path === "/api/sessions") {
        return { status: 200, body: _list().map((s) => ({ ...s, chattable: logs.has(s.id) })) };
      }
      if (method === "GET" && path === "/api/reconcile") return { status: 200, body: _reconcile() };

      if (method === "POST" && path === "/api/sessions") {
        if (!body?.provider) return { status: 400, body: { error: "provider is required" } };
        const desc = await _create({
          provider: body.provider, model: body.model || undefined,
          node: body.node || undefined, project: body.project || undefined,
          profile: body.profile || undefined, effort: body.effort || undefined,
          write: !!body.write, visible: !!body.visible, interactive: !!body.interactive,
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
