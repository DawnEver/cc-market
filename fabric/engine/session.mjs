// engine/session.mjs — persistent multi-turn session registry.
//
// The "handle-holding daemon" the roadmap called for turns out not to need a separate
// process: an MCP stdio server is ALREADY long-lived (it stays up for the whole host
// session), so it can hold live session handles in-process across discrete tool calls. This
// module is that in-process registry plus a provider-dispatching opener, kept in shared/ so
// it is unit-testable and reusable by any orchestrator (fabric's MCP server today).
//
// Both backends expose the same surface — `{ id, send(text) → {text, turn}, close() }`:
//   - codex        → openCodexSession   (app-server thread, natively multi-turn)
//   - claude / API → openSession        (long-lived `claude` stream-json child)

import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { openSession } from "./open-session.mjs";
import { openCodexSession } from "./codex/session.mjs";
import { openRemoteSession } from "./node-client.mjs";
import { resolveNode, loadFabricConfig } from "./node-config.mjs";
import { resolveProfile, applyProfileEnv } from "./profile.mjs";
import { buildChildEnv, resolveClaudeExe } from "./spawn-child.mjs";
import { spawn } from "../shared/spawn.mjs";
import { recordEvent } from "./journal.mjs";

// ── Write-capable stateless session (non-codex) ─────────────────────
// Spawns a fresh `claude -p` with tools per turn; accumulates history in memory. Each
// turn repays for prior context, but gives full write capability without a persistent harness.

function openWriteSession({ provider, model, cwd, profile = null, _spawn = spawn }) {
  const history = [];
  // resolveClaudeExe, never a `.cmd` shim: Node ≥20.12 rejects .cmd without shell:true
  // (spawn EINVAL); same defect as open-session.mjs had, fixed at both sites 2026-08-09.
  const bin = resolveClaudeExe();
  const env = applyProfileEnv(buildChildEnv({ provider, observe: false }), profile);
  const allowedTools = profile?.allowedTools
    ? (Array.isArray(profile.allowedTools) ? profile.allowedTools.join(",") : profile.allowedTools)
    : "Bash,Read,Write,Edit,Glob,Grep";
  // With a profile present the default is the SAFE mode — bypassPermissions stays the
  // default only for the profile-less legacy write path (sharp-review SR-010).
  const permissionMode = profile ? (profile.permissionMode || "default") : "bypassPermissions";

  return {
    id: `write-${idFragment()}`,
    async send(text) {
      history.push(`User: ${text}`);
      const prompt = history.join("\n\n");
      const child = _spawn(bin, [
        "-p",
        ...(model ? ["--model", model] : []),
        "--allowedTools", allowedTools,
        "--permission-mode", permissionMode,
        prompt,
      ], { cwd: cwd || process.cwd(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      const code = await new Promise((resolve) => child.on("close", resolve));
      if (code !== 0) throw new Error(`write session (${provider}): exited ${code}: ${stderr.slice(0, 300)}`);
      const reply = stdout.trim();
      history.push(`Assistant: ${reply}`);
      return { text: reply, turn: Math.floor(history.length / 2) };
    },
    async close() {},
  };
}

/**
 * Open a persistent session for any provider, returning a uniform handle.
 * @param {object} opts  provider (required), model?, write?, cwd?, observe?, runDir?,
 *                       node? (peer node name or {host,port,token} — runs the session on
 *                       that machine; `project` is the REMOTE node's project alias)
 */
export async function openProviderSession(opts = {}) {
  const { provider, write } = opts;
  if (!provider) throw new Error("openProviderSession: provider is required");
  if (opts.node) {
    // A remote spawn forwards the profile NAME — the peer resolves it against its OWN
    // config (enforcement lives there; sharp-review SR-001). Inline objects stay local.
    if (opts.profile != null && typeof opts.profile !== "string") {
      throw new Error("openProviderSession: a remote spawn takes a profile NAME registered on the peer, not an object");
    }
    const node = typeof opts.node === "object" ? opts.node : resolveNode(opts.node);
    return openRemoteSession({ ...node, provider, model: opts.model, write, project: opts.project, profile: opts.profile ?? null, visible: !!opts.visible });
  }
  // Local: resolve a NAME once so every backend below receives the object.
  const profile = resolveProfile(opts.profile, opts._fabricConfig ?? loadFabricConfig());
  if (provider === "codex") {
    return openCodexSession({ model: opts.model, write, cwd: opts.cwd, _client: opts._client });
  }
  if (write) return openWriteSession({ ...opts, profile });
  const runDir = opts.runDir || join(tmpdir(), `fabric-session-${idFragment()}`);
  return openSession({ ...opts, profile, runDir });
}

// ── In-process registry (held by the long-lived MCP server) ──────────

const sessions = new Map();
let seq = 0;

function idFragment() {
  // Monotonic + wall-clock so ids stay unique across a server's lifetime.
  return `${(++seq).toString(36)}-${Date.now().toString(36)}`;
}

/**
 * Create a session and register it. Returns a lightweight descriptor (never the live handle
 * — the handle stays inside the registry so callers reference it only by id).
 */
export async function createSession(opts, _open = openProviderSession) {
  const handle = await _open(opts);
  const id = `sess-${idFragment()}`;
  sessions.set(id, { handle, provider: opts.provider, node: opts.node ?? null, createdAt: Date.now(), turns: 0 });
  recordEvent({ event: "spawn", id, pid: handle.pid ?? null, nativeId: handle.id ?? null, provider: opts.provider, node: opts.node ?? null });
  return { id, provider: opts.provider, nativeId: handle.id ?? null, pid: handle.pid ?? null };
}

export async function sendToSession(id, text) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  if (!text || !String(text).trim()) throw new Error("session_send: prompt must be non-empty");
  let res;
  try {
    res = await entry.handle.send(text);
  } catch (e) {
    // A lost remote connection means the handle is gone for good — journal the loss so
    // reconcile() does not report it as an orphan forever.
    if (e?.code === "CONNECTION_LOST") {
      sessions.delete(id);
      recordEvent({ event: "loss", id, reason: e.message });
    }
    throw e;
  }
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

export function listSessions() {
  return [...sessions.entries()].map(([id, e]) => ({
    id, provider: e.provider, turns: e.turns, createdAt: e.createdAt,
    // Liveness facts (G3) — read from the handle, null when a backend has none.
    pid: e.handle.pid ?? null,
    alive: e.handle.alive ?? null,
    lastActivity: e.handle.lastActivity ?? null,
    usage: e.handle.usage ?? null,
    node: e.node,
  }));
}

/**
 * Answer liveness facts for one session WITHOUT sending a turn (G3). Remote handles
 * forward to the peer's node/ping; local handles answer from their own state.
 */
export async function pingSession(id) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  const h = entry.handle;
  if (typeof h.ping === 'function') return { id, provider: entry.provider, ...(await h.ping()) };
  return {
    id, provider: entry.provider, turns: entry.turns,
    // null = this backend does not observe liveness; never claim true by default (SR-005).
    alive: h.alive ?? null, pid: h.pid ?? null, lastActivity: h.lastActivity ?? null,
  };
}

export function getSessionProvider(id) {
  const entry = sessions.get(id);
  return entry ? entry.provider : null;
}

// ── Team registry: fleet-of-workers abstraction ──────────────────────
// A "team" is a named group of persistent sessions (workers). Opus can
// spawn a team, send to individual workers, check status, and close the
// fleet. Builds on the session primitives — each worker IS a session.

const teams = new Map(); // teamId → { workers: Map<workerId, {sessionId, provider}>, createdAt }

export async function createTeam(workers, _open = openProviderSession) {
  if (!workers || !workers.length) throw new Error("createTeam: workers array is required and non-empty");
  const teamId = `team-${idFragment()}`;
  const workerMap = new Map();
  const results = [];
  for (const w of workers) {
    if (!w.id || !w.provider) throw new Error("createTeam: each worker needs id and provider");
    const desc = await createSession({
      provider: w.provider, model: w.model, write: !!w.write,
      cwd: w.cwd || process.cwd(), observe: false,
      node: w.node, project: w.project,
    }, _open);
    workerMap.set(w.id, { sessionId: desc.id, provider: w.provider, node: w.node ?? null });
    results.push({ id: w.id, sessionId: desc.id, provider: w.provider, write: !!w.write, node: w.node ?? null });
  }
  teams.set(teamId, { workers: workerMap, createdAt: Date.now() });
  return { teamId, workers: results };
}

export async function sendToTeamWorker(teamId, workerId, text) {
  const team = teams.get(teamId);
  if (!team) throw new Error(`No such team: ${teamId}`);
  const worker = team.workers.get(workerId);
  if (!worker) throw new Error(`No worker "${workerId}" in team ${teamId}`);
  return sendToSession(worker.sessionId, text);
}

export function getTeamStatus(teamId) {
  const team = teams.get(teamId);
  if (!team) throw new Error(`No such team: ${teamId}`);
  return [...team.workers.entries()].map(([id, w]) => {
    const all = listSessions();
    const s = all.find((x) => x.id === w.sessionId);
    return { id, provider: w.provider, sessionId: w.sessionId, turns: s?.turns || 0 };
  });
}

export async function closeTeam(teamId) {
  const team = teams.get(teamId);
  if (!team) throw new Error(`No such team: ${teamId}`);
  const results = [];
  for (const [id, w] of team.workers) {
    try { results.push(await closeSession(w.sessionId)); } catch { results.push({ id: w.sessionId, closed: false }); }
  }
  teams.delete(teamId);
  return results;
}

// Test hook: drop all registry state without touching live handles.
export function _resetRegistry() { sessions.clear(); teams.clear(); seq = 0; }
