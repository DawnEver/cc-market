// engine/session.mjs — persistent multi-turn session registry.
//
// The "handle-holding daemon" the roadmap called for turns out not to need a separate
// process: an MCP stdio server is ALREADY long-lived (it stays up for the whole host
// session), so it can hold live session handles in-process across discrete tool calls. This
// module is that in-process registry plus a provider-dispatching opener, kept in shared/ so
// it is unit-testable and reusable by any orchestrator (fabric's MCP server today).
//
// Every backend exposes the same surface — `{ id, send(text) → {text, turn}, close() }`
// plus a `kind` naming its liveness semantics:
//   - codex        → openCodexSession   (kind 'codex':  app-server thread, natively multi-turn)
//   - claude / API → openSession        (kind 'child':  long-lived `claude` stream-json child,
//                                        read-only OR write — write is a profile, not a backend)
//   - a peer node  → openRemoteSession  (kind 'remote': the child lives on another machine)

import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { openSession } from "./open-session.mjs";
import { openCodexSession } from "./codex/session.mjs";
import { openRemoteSession, attachRemoteSession, connectNode } from "./node-client.mjs";
import { resolveNode, loadFabricConfig } from "./node-config.mjs";
import { resolveProfile } from "./profile.mjs";
import { recordEvent } from "./journal.mjs";

// The write capability a profile-less write session gets. A profile REPLACES this list,
// exactly as it does on the read-only path — one key, one meaning across backends.
const DEFAULT_WRITE_TOOLS = "Bash,Read,Write,Edit,Glob,Grep";

// Tag a handle with the backend family it came from, so liveness can be reported
// honestly per kind instead of inferred (sharp-review SR-005/020).
function tagKind(handle, kind) {
  if (handle && handle.kind == null) { try { handle.kind = kind; } catch { /* frozen handle: kind stays unknown */ } }
  return handle;
}

/**
 * Resolve the provider/model/effort for a spawn: an explicit caller opt wins, otherwise
 * `fabric.sessionDefaults` in the config (a device's default session). Used by the session
 * opener and (for provider/model) by the one-shot call path in the MCP server.
 *
 * The default is a BUNDLE (provider+model+effort): a caller who overrides the provider has
 * left the default session, so the default's model/effort no longer apply — they would be
 * the wrong shape for a different provider (a deepseek model id on a claude session).
 */
export function resolveSessionDefaults(opts = {}, cfg = null) {
  const c = cfg ?? opts._fabricConfig ?? loadFabricConfig(opts.configPath);
  const sd = c.sessionDefaults || {};
  const onDefaultProvider = !opts.provider || (sd.provider != null && opts.provider === sd.provider);
  return {
    provider: opts.provider ?? sd.provider ?? null,
    model: onDefaultProvider ? (opts.model ?? sd.model ?? null) : (opts.model ?? null),
    effort: onDefaultProvider ? (opts.effort ?? sd.effort ?? null) : (opts.effort ?? null),
  };
}

/**
 * Open a persistent session for any provider, returning a uniform handle.
 * @param {object} opts  provider (defaults to fabric.sessionDefaults.provider), model?,
 *                       write?, cwd?, observe?, runDir?, configPath?, profile?, effort?,
 *                       node? (peer node name or {host,port,token} — runs the session on
 *                       that machine; `project` is the REMOTE node's project alias)
 */
export async function openProviderSession(opts = {}) {
  const cfg = opts._fabricConfig ?? loadFabricConfig(opts.configPath);
  const { provider, model, effort } = resolveSessionDefaults(opts, cfg);
  const write = !!opts.write;
  if (!provider) {
    throw new Error("openProviderSession: provider is required (pass one, or set fabric.sessionDefaults.provider in claude_env_settings.json)");
  }
  if (opts.node) {
    // A remote spawn forwards the profile NAME — the peer resolves it against its OWN
    // config (enforcement lives there; sharp-review SR-001). Inline objects stay local.
    // provider/model/effort are resolved HERE (this machine's defaults) and forwarded
    // explicitly, so an older peer that cannot resolve defaults itself still obeys them.
    if (opts.profile != null && typeof opts.profile !== "string") {
      throw new Error("openProviderSession: a remote spawn takes a profile NAME registered on the peer, not an object");
    }
    const node = typeof opts.node === "object" ? opts.node : resolveNode(opts.node);
    return tagKind(await openRemoteSession({ ...node, provider, model: model ?? null, write, project: opts.project, profile: opts.profile ?? null, visible: !!opts.visible, interactive: !!opts.interactive, effort: effort ?? null, shared: !!opts.shared }), "remote");
  }
  // Local: resolve a NAME once, against the SAME config file the provider env comes
  // from (SR-022), so credentials and policy can never be read from two different files.
  const profile = resolveProfile(opts.profile, cfg);
  if (provider === "codex") {
    // The codex app-server takes no tool/permission policy, so a profile here would be
    // silently discarded — the guard-scope lie. Refuse loudly instead (SR-018/026/042).
    if (profile) {
      const named = typeof opts.profile === "string" ? `"${opts.profile}"` : "(inline)";
      const err = new Error(
        `provider "codex" cannot enforce spawn profile ${named}: the codex app-server exposes no ` +
        "allowedTools/permissionMode surface. Use a claude/API provider for a profiled session.",
      );
      err.code = "PROFILE_UNSUPPORTED";
      throw err;
    }
    return tagKind(await openCodexSession({ model, write, cwd: opts.cwd, _client: opts._client }), "codex");
  }
  // Every claude/API session — read-only or write — is the SAME persistent stream-json
  // child. Write capability is a profile, not a different backend: the retired stateless
  // path re-sent the whole transcript as argv each turn, which is O(n²) tokens and hits
  // the ~32k Windows command-line ceiling around turn 5-10 (SR-024/049).
  const effectiveProfile = write
    ? {
        ...(profile || {}),
        allowedTools: profile?.allowedTools ?? DEFAULT_WRITE_TOOLS,
        // A profiled write session prompts by default; only an UNPROFILED one keeps the
        // historic wide-open default (SR-010).
        permissionMode: profile ? (profile.permissionMode || "default") : "bypassPermissions",
      }
    : profile;
  const runDir = opts.runDir || join(tmpdir(), `fabric-session-${idFragment()}`);
  return tagKind(await openSession({ ...opts, model, effort, profile: effectiveProfile, runDir }), "child");
}

/**
 * Resume an orphaned session's conversation (crash recovery): spawn a NEW child with
 * `--resume <sessionId>` so the CLI restores the conversation from its session store.
 * Local claude/API children only (sessionId known, no node); remote orphans have no
 * local resume path — the peer owns the child.
 */
export async function resumeSession(sessionId, opts = {}, _open = openProviderSession) {
  if (!sessionId) throw new Error("resumeSession: a sessionId is required (only claude/API children record one)");
  return createSession({ ...opts, resume: sessionId }, _open);
}

// ── In-process registry (held by the long-lived MCP server) ──────────

const sessions = new Map();
let seq = 0;

// Which process holds these handles. The journal is the only join point between the
// several fabric processes on one box, so a spawn record has to name the owner or the
// layer above cannot route a close/ping to the daemon that can serve it (SR-045).
let ownerKind = "lib";
export function setJournalOwnerKind(kind) { ownerKind = kind; }
const owner = () => ({ pid: process.pid, kind: ownerKind });

function idFragment() {
  // Monotonic + wall-clock so ids stay unique across a server's lifetime.
  return `${(++seq).toString(36)}-${Date.now().toString(36)}`;
}

/**
 * Create a session and register it. Returns a lightweight descriptor (never the live handle
 * — the handle stays inside the registry so callers reference it only by id).
 *
 * The registry records the session's IDENTITY — provider/model/effort with sessionDefaults
 * already resolved — so listSessions / node/status name what the session actually RUNS,
 * not what a spawn form happened to spell (an omitted model means the default's model).
 */
export async function createSession(opts, _open = openProviderSession) {
  const handle = await _open(opts);
  const id = `sess-${idFragment()}`;
  const resolved = resolveSessionDefaults(opts);
  sessions.set(id, {
    handle,
    provider: opts.provider ?? resolved.provider, model: resolved.model, effort: resolved.effort,
    project: opts.project ?? null, node: opts.node ?? null, cwd: opts.cwd ?? null,
    createdAt: Date.now(), turns: 0,
  });
  recordEvent({ event: "spawn", id, pid: handle.pid ?? null, nativeId: handle.id ?? null, sessionId: handle.sessionId ?? null, provider: opts.provider ?? resolved.provider, model: resolved.model, effort: resolved.effort, node: opts.node ?? null, owner: owner() });
  return { id, provider: opts.provider ?? resolved.provider, model: resolved.model, effort: resolved.effort, nativeId: handle.id ?? null, pid: handle.pid ?? null, sessionId: handle.sessionId ?? null };
}

// Per-id send chains. open-session and codex serialize internally, but a remote handle
// does not — and the peer's child has a SINGLE pending slot, so two concurrent
// session_send calls to one id lose a turn. Serializing here makes the guarantee
// uniform across backends instead of a property of three out of four (SR-040).
const sendChains = new Map();

function serializePerId(id, task) {
  const prev = sendChains.get(id) ?? Promise.resolve();
  const result = prev.then(task, task);
  // The chain itself must never reject: a failed turn blocks nobody (it is the CALLER's
  // rejection), and the next send starts from a settled link.
  const link = result.then(() => {}, () => {});
  sendChains.set(id, link);
  link.then(() => { if (sendChains.get(id) === link) sendChains.delete(id); });
  return result;
}

export async function sendToSession(id, text) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  if (!text || !String(text).trim()) throw new Error("session_send: prompt must be non-empty");
  const res = await serializePerId(id, async () => {
    try {
      return await entry.handle.send(text);
    } catch (e) {
      // A lost remote connection means the handle is gone for good — journal the loss so
      // reconcile() does not report it as an orphan forever.
      if (e?.code === "CONNECTION_LOST") {
        sessions.delete(id);
        recordEvent({ event: "loss", id, reason: e.message, owner: owner() });
      }
      throw e;
    }
  });
  entry.turns = res.turn ?? entry.turns + 1;
  return res;
}

export async function closeSession(id) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (already closed?)`);
  let exitCode = null;
  try {
    exitCode = await entry.handle.close();
  } catch (e) {
    // A close that THROWS is not a close — the child may live on. Journal the failure
    // and keep the record open for reconcile (sharp-review SR-016).
    sessions.delete(id);
    recordEvent({ event: "close_failed", id, error: String(e?.message ?? e), turns: entry.turns });
    throw e;
  }
  sessions.delete(id);
  recordEvent({ event: "close", id, exitCode: exitCode ?? null, turns: entry.turns, usage: entry.handle.usage ?? null });
  return { id, exitCode: exitCode ?? null, turns: entry.turns };
}

/**
 * Set (or replace) a session's native goal (claude/API: the CLI's `/goal <condition>`
 * — the session then auto-continues turns until the condition is met). Instant; the
 * next send runs the loop and returns its final outcome.
 */
export async function setSessionGoal(id, condition) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  if (typeof entry.handle.setGoal !== "function") {
    const err = new Error(
      `session ${id} (provider ${entry.provider}) has no native goal: only claude/API children expose the CLI's /goal loop.`,
    );
    err.code = "GOAL_UNSUPPORTED";
    throw err;
  }
  const res = await entry.handle.setGoal(condition);
  recordEvent({ event: "goal_set", id, provider: entry.provider, condition: res.condition, owner: owner() });
  return { id, provider: entry.provider, ...res };
}

/**
 * Run a goal session's loop to completion (drained to the final result). `prompt`
 * triggers the loop; the CLI iterates autonomously until the goal is met, capped by
 * maxTurns/timeout. Only valid when a goal is active (setSessionGoal first).
 */
export async function goalRunSession(id, { prompt, maxTurns, timeoutMs }) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  if (typeof entry.handle.goalRun !== "function") {
    const err = new Error(`session ${id} (provider ${entry.provider}) has no native goal loop (claude/API only).`);
    err.code = "GOAL_UNSUPPORTED";
    throw err;
  }
  const res = await entry.handle.goalRun(prompt, { maxTurns, timeoutMs });
  entry.turns = res.turn ?? entry.turns + 1;
  recordEvent({ event: "goal_run", id, provider: entry.provider, turns: res.turns, state: res.state, owner: owner() });
  return { id, provider: entry.provider, ...res };
}

/**
 * Compact a session's context in place (native where the backend has one — codex's
 * thread/compact/start; claude's --autocompact window is set at spawn). The handle
 * stays the same id; turns keep counting.
 */
export async function compactSession(id) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  if (typeof entry.handle.compact !== "function") {
    const err = new Error(
      `session ${id} (provider ${entry.provider}) has no native compact: this backend does not expose one. ` +
      "codex (thread/compact/start) and claude/API (the CLI's /compact) both support it; others do not.",
    );
    err.code = "COMPACT_UNSUPPORTED";
    throw err;
  }
  const res = await entry.handle.compact();
  recordEvent({ event: "compact", id, provider: entry.provider, ...res, owner: owner() });
  return { id, provider: entry.provider, ...res };
}

/**
 * Adopt an EXISTING remote session (v2): registers an attach handle so this console
 * can chat with a session another manager spawned as shared.
 */
export async function attachSession({ node, remoteId }, _attach = null) {
  const n = typeof node === "object" ? node : resolveNode(node);
  const doAttach = _attach || attachRemoteSession;
  const handle = await doAttach({ ...n, id: remoteId });
  const id = `sess-${idFragment()}`;
  // model/effort/project unknown for a foreign-spawned session — nulls, not guesses.
  sessions.set(id, { handle, provider: "attached", model: null, effort: null, project: null, node: typeof node === "string" ? node : (n.host ?? null), cwd: null, createdAt: Date.now(), turns: 0 });
  return { id, provider: "attached", nativeId: remoteId, pid: null };
}

/**
 * Liveness as a THREE-valued fact: true, false, or null for "this backend does not
 * observe it". A handle that exposes no `alive` at all reports null — never the
 * optimistic default that made three of four backends claim life they never checked.
 */
function observedAlive(handle) {
  return "alive" in handle ? !!handle.alive : null;
}

export function listSessions() {
  return [...sessions.entries()].map(([id, e]) => ({
    id, provider: e.provider, kind: e.handle.kind ?? null, turns: e.turns, createdAt: e.createdAt,
    // The handle's own id: for a remote session that IS the peer's id — how the console
    // dedups its spawned sessions against the peer's own node/status list.
    nativeId: e.handle.id ?? null,
    // Identity facts: the resolved model/effort the session runs (null = unknown,
    // e.g. an attached foreign session) — never a re-spelled default.
    model: e.model ?? null, effort: e.effort ?? null, project: e.project ?? null,
    // Liveness facts (G3) — read from the handle, null when a backend has none.
    pid: e.handle.pid ?? null,
    alive: observedAlive(e.handle),
    lastActivity: e.handle.lastActivity ?? null,
    usage: e.handle.usage ?? null,
    // Capacity facts: whether this backend can compact its own context / run a native
    // goal loop. null = unknown.
    compactable: e.handle.compactable ?? null,
    goal: e.handle.goalActive ?? null,
    node: e.node, cwd: e.cwd,
  }));
}

/**
 * Answer liveness facts for one session WITHOUT sending a turn (G3). Remote handles
 * forward to the peer's node/ping; local handles answer from their own state. A peer
 * that cannot be reached is a FACT about the session (alive:false + reason), so this
 * reports it rather than rejecting — the caller asked "is it alive", not "reach it".
 */
export async function pingSession(id) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  const h = entry.handle;
  const base = { id, provider: entry.provider, kind: h.kind ?? null, compactable: h.compactable ?? null, goal: h.goalActive ?? null };
  if (typeof h.ping === "function") {
    try {
      return { ...base, ...(await h.ping()) };
    } catch (e) {
      return { ...base, turns: entry.turns, alive: false, reason: e?.code || e?.message || String(e) };
    }
  }
  return {
    ...base, turns: entry.turns,
    alive: observedAlive(h), pid: h.pid ?? null, lastActivity: h.lastActivity ?? null,
  };
}

export function getSessionProvider(id) {
  const entry = sessions.get(id);
  return entry ? entry.provider : null;
}

/**
 * View a session's content (transcript tail) + liveness facts, local or remote. A remote
 * handle forwards to the peer's node/view; a local claude/API child reads its own
 * always-recorded transcript. A backend with no content viewer (codex) reports
 * content:null with the reason, honestly — never a fabricated answer.
 */
export async function viewSession(id, { tailChars = 8000 } = {}) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  const h = entry.handle;
  const base = { id, provider: entry.provider, kind: h.kind ?? null, node: entry.node ?? null };
  if (typeof h.view === "function") {
    return { ...base, ...(await h.view({ tailChars })) };
  }
  return { ...base, content: null, reason: `${entry.provider}/${h.kind ?? "?"} exposes no content viewer — use session_send to continue it` };
}

/**
 * View a session on a peer WITHOUT it being in the local registry — list_nodes shows these
 * ids, and a peer session is viewable read-only by any token-holder (node/view is
 * visibility, not acting). Mirrors attachSession's {node, remoteId} shape. Returns the
 * peer's node/view result verbatim.
 */
export async function viewRemoteSession({ node, remoteId }, { tailChars = 8000 } = {}, _connect = null) {
  if (!node || !remoteId) throw new Error("viewRemoteSession: node and remoteId are required");
  const n = typeof node === "object" ? node : resolveNode(node);
  const doConnect = _connect || connectNode;
  const conn = await doConnect({ host: n.host, port: n.port, token: n.token, connectTimeoutMs: 5000 });
  try {
    return await conn.request("node/view", { id: remoteId, tailChars }, { timeoutMs: 30000 });
  } finally { conn.close(); }
}

// ── Team registry: fleet-of-workers abstraction ──────────────────────
// A "team" is a named group of persistent sessions (workers). Opus can
// spawn a team, send to individual workers, check status, and close the
// fleet. Builds on the session primitives — each worker IS a session.

const teams = new Map(); // teamId → { workers: Map<workerId, {sessionId, provider}>, createdAt }

export async function createTeam(workers, _open = openProviderSession) {
  if (!workers || !workers.length) throw new Error("createTeam: workers array is required and non-empty");
  for (const w of workers) {
    if (!w.id || !w.provider) throw new Error("createTeam: each worker needs id and provider");
  }
  const teamId = `team-${idFragment()}`;
  // Spawn in parallel — team latency was serial × child boot time. A partial failure
  // used to leave the already-spawned workers registered but unreachable by closeTeam,
  // i.e. leaked children until server restart (SR-031).
  const settled = await Promise.allSettled(workers.map((w) => createSession({
    provider: w.provider, model: w.model, write: !!w.write,
    cwd: w.cwd || process.cwd(), observe: false,
    node: w.node, project: w.project, profile: w.profile,
  }, _open)));

  const failure = settled.find((s) => s.status === "rejected");
  if (failure) {
    await Promise.allSettled(settled
      .filter((s) => s.status === "fulfilled")
      .map((s) => closeSession(s.value.id)));
    throw failure.reason;
  }

  const workerMap = new Map();
  const results = workers.map((w, i) => {
    const desc = settled[i].value;
    workerMap.set(w.id, { sessionId: desc.id, provider: w.provider, node: w.node ?? null });
    return { id: w.id, sessionId: desc.id, provider: w.provider, write: !!w.write, node: w.node ?? null };
  });
  teams.set(teamId, { workers: workerMap, createdAt: Date.now() });
  recordEvent({ event: "team", team: teamId, workers: results.map((r) => r.sessionId), owner: owner() });
  return { teamId, workers: results };
}

export async function sendToTeamWorker(teamId, workerId, text) {
  const team = teams.get(teamId);
  if (!team) throw new Error(`No such team: ${teamId}`);
  const worker = team.workers.get(workerId);
  if (!worker) throw new Error(`No worker "${workerId}" in team ${teamId}`);
  return sendToSession(worker.sessionId, text);
}

// ONE listSessions() per status call, indexed by id — this used to be a full linear
// scan of the registry per worker, i.e. O(workers × sessions) (SR-032).
export function getTeamStatus(teamId, _list = listSessions) {
  const team = teams.get(teamId);
  if (!team) throw new Error(`No such team: ${teamId}`);
  const byId = new Map(_list().map((s) => [s.id, s]));
  return [...team.workers.entries()].map(([id, w]) => ({
    id, provider: w.provider, sessionId: w.sessionId, turns: byId.get(w.sessionId)?.turns || 0,
  }));
}

export async function closeTeam(teamId) {
  const team = teams.get(teamId);
  if (!team) throw new Error(`No such team: ${teamId}`);
  const sessionIds = [...team.workers.values()].map((w) => w.sessionId);
  const results = [];
  for (const w of team.workers.values()) {
    try { results.push(await closeSession(w.sessionId)); } catch { results.push({ id: w.sessionId, closed: false }); }
  }
  teams.delete(teamId);
  recordEvent({ event: "team_close", team: teamId, workers: sessionIds, owner: owner() });
  return results;
}

// Test hook: drop all registry state without touching live handles.
export function _resetRegistry() { sessions.clear(); teams.clear(); sendChains.clear(); seq = 0; }
