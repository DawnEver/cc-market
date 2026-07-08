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
import { openSession } from "./open-session.mjs";
import { openCodexSession } from "./codex/session.mjs";

/**
 * Open a persistent session for any provider, returning a uniform handle.
 * @param {object} opts  provider (required), model?, write?, cwd?, observe?, runDir?
 */
export async function openProviderSession(opts = {}) {
  const { provider } = opts;
  if (!provider) throw new Error("openProviderSession: provider is required");
  if (provider === "codex") {
    return openCodexSession({ model: opts.model, write: opts.write, cwd: opts.cwd, _client: opts._client });
  }
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

// Test hook: drop all registry state without touching live handles.
export function _resetRegistry() { sessions.clear(); seq = 0; }
