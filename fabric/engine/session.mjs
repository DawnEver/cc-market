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
import { buildChildEnv } from "./spawn-child.mjs";
import { spawn } from "../shared/spawn.mjs";

// ── Write-capable stateless session (non-codex) ─────────────────────
// Spawns a fresh `claude -p` with tools per turn; accumulates history in memory. Each
// turn repays for prior context, but gives full write capability without a persistent harness.

function openWriteSession({ provider, model, cwd }) {
  const history = [];
  const bin = process.platform === "win32" ? "claude.cmd" : "claude";
  const env = buildChildEnv({ provider, observe: false });

  return {
    id: `write-${idFragment()}`,
    async send(text) {
      history.push(`User: ${text}`);
      const prompt = history.join("\n\n");
      const child = spawn(bin, [
        "-p",
        ...(model ? ["--model", model] : []),
        "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
        "--permission-mode", "bypassPermissions",
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
 * @param {object} opts  provider (required), model?, write?, cwd?, observe?, runDir?
 */
export async function openProviderSession(opts = {}) {
  const { provider, write } = opts;
  if (!provider) throw new Error("openProviderSession: provider is required");
  if (provider === "codex") {
    return openCodexSession({ model: opts.model, write, cwd: opts.cwd, _client: opts._client });
  }
  if (write) return openWriteSession(opts);
  const runDir = opts.runDir || join(tmpdir(), `fabric-session-${idFragment()}`);
  return openSession({ ...opts, runDir });
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
  sessions.set(id, { handle, provider: opts.provider, createdAt: Date.now(), turns: 0 });
  return { id, provider: opts.provider, nativeId: handle.id ?? null };
}

export async function sendToSession(id, text) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (may have been closed)`);
  if (!text || !String(text).trim()) throw new Error("session_send: prompt must be non-empty");
  const res = await entry.handle.send(text);
  entry.turns = res.turn ?? entry.turns + 1;
  return res;
}

export async function closeSession(id) {
  const entry = sessions.get(id);
  if (!entry) throw new Error(`No such session: ${id} (already closed?)`);
  let exitCode = null;
  try { exitCode = await entry.handle.close(); }
  finally { sessions.delete(id); }
  return { id, exitCode: exitCode ?? null, turns: entry.turns };
}

export function listSessions() {
  return [...sessions.entries()].map(([id, e]) => ({
    id, provider: e.provider, turns: e.turns, createdAt: e.createdAt,
  }));
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
    }, _open);
    workerMap.set(w.id, { sessionId: desc.id, provider: w.provider });
    results.push({ id: w.id, sessionId: desc.id, provider: w.provider, write: !!w.write });
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
