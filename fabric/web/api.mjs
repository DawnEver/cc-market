// web/api.mjs — the local management console's JSON API, as a PURE handler:
// (method, path, body) → { status, body }. HTTP wiring and the HTML shell live in
// web/server.mjs; this module is what the tests exercise.
//
// Scope, honestly stated: the console CHATS with sessions this process spawned or
// attached (local or remote via node) and VIEWS any session in the fleet — a peer
// session is readable through node/view (visibility is not owner-gated) but drivable
// only when owned/shared (node/send is owner-restricted, by design). The console holds
// a per-session message log only as the pending/console-local complement to the
// session's own transcript, which is the conversation's truth; the durable trail stays
// in the journal, as everywhere else.

import { createSession, sendToSession, closeSession, compactSession, setSessionGoal, goalRunSession, listSessions, pingSession, viewSession, viewRemoteSession } from "../engine/session.mjs";
import { reconcile, recordEvent } from "../engine/journal.mjs";
import { loadServeConfig } from "../engine/node-config.mjs";
import { liveCatalogue } from "../engine/catalogue.mjs";
import { attachSession } from "../engine/session.mjs";
// The fleet probe lives in the engine (shared with the MCP list_nodes tool); re-exported
// for backward compat with any importer of web/api.mjs.
export { pingNodes } from "../engine/node-probe.mjs";
import { pingNodes } from "../engine/node-probe.mjs";

export function createWebApi(deps = {}) {
  const _create = deps.createSession || createSession;
  const _send = deps.sendToSession || sendToSession;
  const _close = deps.closeSession || closeSession;
  const _compact = deps.compactSession || compactSession;
  const _setGoal = deps.setSessionGoal || setSessionGoal;
  const _goalRun = deps.goalRunSession || goalRunSession;
  const _list = deps.listSessions || listSessions;
  const _ping = deps.pingSession || pingSession;
  const _view = deps.viewSession || viewSession;
  const _viewRemote = deps.viewRemoteSession || viewRemoteSession;
  const _nodes = deps.pingNodes || pingNodes;
  const _reconcile = deps.reconcile || reconcile;
  const _catalogue = deps.catalogue || liveCatalogue;
  const _attach = deps.attachSession || attachSession;
  const _kill = deps.killPid || ((pid) => process.kill(pid));

  const logs = new Map(); // sessionId → [{role, text, ts}]
  const log = (id, role, text) => {
    if (!logs.has(id)) logs.set(id, []);
    logs.get(id).push({ role, text, ts: Date.now() });
  };

  async function handle(method, path, body) {
    try {
      let m, om; // route captures — declared here so every branch may use them
      if (method === "GET" && path.startsWith("/api/catalogue")) {
        // liveCatalogue is async now (probes never block the event loop) — await it.
        return { status: 200, body: await _catalogue({ force: path.includes("force=1") }) };
      }
      if (method === "GET" && path === "/api/fleet") {
        // Machines = configured nodes, with THIS machine identified (serve name match),
        // each carrying projects + sessions (shared/project flags from node/status) and
        // the console's own in-process sessions folded under the self machine.
        // 'full': the fleet tree renders per-session cost, which only full carries.
        const machines = await _nodes({ detail: "full" });
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
      if (method === "POST" && (om = path.match(/^\/api\/orphans\/([^/]+)\/kill$/))) {
        // Crash recovery: the operator decides a surviving session is NOT to continue —
        // kill the pid when it is provably alive, then tombstone the record either way.
        const rec = _reconcile().find((o) => o.id === om[1]);
        if (!rec) return { status: 404, body: { error: `no orphan record ${om[1]}` } };
        let killed = false;
        if (rec.pid && rec.pidAlive === true) { try { _kill(rec.pid); killed = true; } catch { /* already gone */ } }
        (deps.recordEvent || recordEvent)({ event: "loss", id: rec.id, reason: killed ? "killed from console" : "record cleared from console (pid not provably alive)" });
        return { status: 200, body: { id: rec.id, killed } };
      }
      if (method === "POST" && (om = path.match(/^\/api\/orphans\/([^/]+)\/resume$/))) {
        // Crash recovery: CONTINUE a surviving session — spawn a new child with the
        // CLI's own session id (--resume), so the conversation restores from the CLI's
        // session store. Local claude/API children only; a remote orphan is owned by
        // its peer and must be decided there.
        const rec = _reconcile().find((o) => o.id === om[1]);
        if (!rec) return { status: 404, body: { error: `no orphan record ${om[1]}` } };
        if (rec.node) return { status: 400, body: { error: `orphan ${om[1]} is remote — the peer owns it; resume it there` } };
        if (!rec.sessionId) return { status: 400, body: { error: `orphan ${om[1]} has no resumable session id (not a claude/API child)` } };
        const desc = await _create({ provider: rec.provider, resume: rec.sessionId, cwd: rec.cwd ?? process.cwd(), write: false });
        (deps.recordEvent || recordEvent)({ event: "loss", id: rec.id, reason: `resumed into ${desc.id} (${rec.sessionId})` });
        logs.set(desc.id, []);
        return { status: 200, body: { ...desc, resumedFrom: rec.id } };
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
      if (method === "POST" && (m = path.match(/^\/api\/sessions\/([^/]+)\/compact$/))) {
        // In-place native compaction (codex thread/compact/start); the same console
        // session id keeps chatting. COMPACT_UNSUPPORTED surfaces as a 500 with the code.
        const res = await _compact(m[1]);
        log(m[1], "system", `[compacted in place${res.confirmed ? "" : " (unconfirmed)"}]`);
        return { status: 200, body: res };
      }
      if (method === "POST" && (m = path.match(/^\/api\/sessions\/([^/]+)\/goal$/))) {
        // Native goal: set the /goal condition (instant); with prompt, run the
        // autonomous loop to its final outcome (the CLI iterates until met).
        const id = m[1];
        if (body?.prompt != null) {
          const res = await _goalRun(id, { prompt: String(body.prompt), maxTurns: body.maxTurns, timeoutMs: body.timeoutMs });
          log(id, "system", `[goal run: ${res.state}${res.turns != null ? `, ${res.turns} turn(s)` : ""}]`);
          log(id, "assistant", res.text);
          return { status: 200, body: res };
        }
        if (!body?.condition) return { status: 400, body: { error: "condition (or prompt) is required" } };
        const res = await _setGoal(id, String(body.condition));
        log(id, "system", `[goal set: ${body.condition}]`);
        return { status: 200, body: res };
      }
      if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)\/ping$/))) {
        return { status: 200, body: await _ping(m[1]) };
      }
      // How much of a session's transcript the console renders (chat + observe). Big
      // enough for a long conversation; the viewer reads the tail, the truth is the
      // full transcript on disk.
      const VIEW_TAIL = 20000;
      if (method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)\/view$/))) {
        // The session's own transcript tail (claude/API always records one; codex
        // reports content:null honestly) + liveness facts. The console's chat renders
        // THIS, not its own memory log — the transcript is the conversation's truth.
        const r = await _view(m[1], { tailChars: VIEW_TAIL });
        return { status: 200, body: r };
      }
      if (method === "GET" && (om = path.match(/^\/api\/nodes\/([^/]+)\/sessions\/([^/]+)\/view$/))) {
        // Observe a PEER session that is not in this console's registry (read-only —
        // node/view is visibility, not acting; owner gates only send/close).
        const r = await _viewRemote({ node: om[1], remoteId: om[2] }, { tailChars: VIEW_TAIL });
        return { status: 200, body: r };
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
