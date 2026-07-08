// engine/codex/app-server.mjs — JSON-RPC 2.0 client for the codex app-server.
// Canonical single implementation shared by takeover and fabric (previously
// copy-forked into each plugin, differing only by the hardcoded client name).
// The client identifies itself by the nearest enclosing plugin's
// .claude-plugin/plugin.json — override via opts.clientInfo.
import { spawn } from "../../shared/spawn.mjs";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { findCodexBinary } from "./discovery.mjs";

// Walk up from startPath (default: the entry script) to the nearest
// .claude-plugin/plugin.json and return its {name, version}.
export function resolveClientInfo(startPath = process.argv[1]) {
  let dir = startPath ? dirname(startPath) : process.cwd();
  while (true) {
    const manifest = join(dir, ".claude-plugin", "plugin.json");
    if (existsSync(manifest)) {
      try {
        const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
        return { name: name || "cc-market", version: version || "0.0.0" };
      } catch {
        // Malformed manifest — keep walking up; a valid ancestor may still win.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { name: "cc-market", version: "0.0.0" };
}

export class CodexAppServerClient {
  constructor(opts = {}) {
    this.codexPath = opts.codexPath;
    this.timeout = opts.timeout ?? 600000;
    this.clientInfo = opts.clientInfo || resolveClientInfo();
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationHandlers = new Map();
    this.lineBuffer = "";
    this._closed = false;
    this._closePromise = null;
    this._closeResolve = null;
  }

  async start() {
    const bin = this.codexPath || findCodexBinary();
    this._closePromise = new Promise((resolve) => { this._closeResolve = resolve; });

    this.child = spawn(bin, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      shell: process.platform === "win32",
    });

    this.child.on("error", (err) => {
      this._closed = true;
      this._rejectAllPending(err);
    });

    this.child.on("close", (code) => {
      this._closed = true;
      this._rejectAllPending(new Error(`codex app-server exited ${code}`));
      if (this._closeResolve) { this._closeResolve(); this._closeResolve = null; }
    });

    this.child.stdout.on("data", (chunk) => {
      this.lineBuffer += chunk.toString();
      const lines = this.lineBuffer.split("\n");
      this.lineBuffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) this._handleLine(line);
      }
    });

    this.child.stderr.on("data", (d) => {
      process.stderr.write(`${this.clientInfo.name}[codex]: ${d.toString().trim()}\n`);
    });

    const initResult = await this.send("initialize", {
      protocolVersion: "1.0",
      clientInfo: this.clientInfo,
      capabilities: {
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/textDelta",
        ],
      },
    });

    return initResult;
  }

  send(method, params) {
    if (this._closed) throw new Error("App-server connection closed");
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${method}`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  // Reject every in-flight request and clear its timeout. Without clearing the
  // timer, a pending request rejected via the child's error/close events would
  // leave its (up to 10-min) setTimeout alive, keeping the event loop from
  // exiting long after the work is done.
  _rejectAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  notify(method, params) {
    if (!this._closed) {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }
  }

  onNotification(method, handler) {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, []);
    }
    this.notificationHandlers.get(method).push(handler);
  }

  removeNotificationHandler(method, handler) {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  }

  clearNotifications(method) {
    if (method) this.notificationHandlers.delete(method);
    else this.notificationHandlers.clear();
  }

  async stop() {
    if (!this._closed) {
      try { await this.send("shutdown", {}); } catch {}
      this._closed = true;
    }
    if (this.child) {
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      if (!this.child.killed) this.child.kill();
    }
    if (this._closeResolve) { this._closeResolve(); this._closeResolve = null; }
  }

  async waitForClose() {
    if (this._closePromise) await this._closePromise;
  }

  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }

    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      const handlers = this.notificationHandlers.get(msg.method) || [];
      for (const h of handlers) h(msg.params);
    }
  }
}

// ── Shared client singleton ─────────────────────────────────────────

let _sharedClient = null;
let _lock = Promise.resolve();
let _pendingCount = 0;

export async function getSharedClient(opts = {}) {
  if (!_sharedClient || _sharedClient._closed) {
    _sharedClient = new CodexAppServerClient(opts);
    await _sharedClient.start();
  }
  return _sharedClient;
}

export async function resetSharedClient() {
  if (_sharedClient && !_sharedClient._closed) {
    try { await _sharedClient.stop(); } catch {}
  }
  _sharedClient = null;
}

export function withSharedClient(fn, { timeout = 30000, _getClient = getSharedClient } = {}) {
  const prev = _lock;
  let release;
  // The shared lock chain only ever *resolves* (on release) — a waiter's timeout
  // must reject that waiter alone, never the chain the next caller inherits.
  _lock = new Promise((resolve) => { release = resolve; });

  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const queueDepth = _pendingCount || 0;
      reject(new Error(
        `Lock acquisition timed out after ${timeout}ms. ` +
        `This usually means the codex app-server process is stuck or has crashed. ` +
        `Pending requests in queue: ${queueDepth}. Run resetSharedClient() to force-restart.`
      ));
    }, timeout);
  });
  // If prev wins the race, nothing awaits timeoutPromise — swallow its rejection.
  timeoutPromise.catch(() => {});

  _pendingCount++;
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timeoutId);
    _pendingCount--;
  };

  return Promise.race([prev, timeoutPromise]).then(async () => {
    settle();
    try {
      const client = await _getClient();
      return await fn(client);
    } finally {
      release();
    }
  }, (err) => {
    // Only this caller's timeout lands here (prev never rejects). The previous
    // holder is still running — releasing now would let the next caller overlap
    // it. Keep the chain intact: this waiter's placeholder resolves only once
    // prev does, preserving mutual exclusion and FIFO order.
    settle();
    prev.then(release);
    throw err;
  });
}

// ── Client pool (concurrent codex calls) ─────────────────────────────
// withSharedClient serializes ALL codex work onto one client (one lane). For a
// fan-out — e.g. many image generations at once — that is the bottleneck.
//
// A pool instead keeps up to `size` warm app-server clients and lends each to
// one call at a time. Exclusive checkout gives every call the SAME isolation the
// mutex did (its own notification stream, no cross-talk — exactly how the
// persistent-session path already runs one client per session), while up to
// `size` calls proceed in parallel. Released clients stay warm for reuse; a
// crashed one is dropped and replaced on demand.

// A pooled call borrows one CodexAppServerClient for its EXCLUSIVE use. That
// gives it the same isolation the mutex did — each client owns a private
// per-instance notification registry (this.notificationHandlers), so clearing
// handlers on the client you hold can never touch another call's client.

// Guard config: a non-positive/non-finite size would deadlock (every caller
// queues, nothing ever creates) or go unbounded (Infinity). Clamp to a positive
// integer. (SR-048/049)
function sanitizeSize(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

const DEFAULT_POOL_SIZE = sanitizeSize(process.env.FABRIC_CODEX_POOL_SIZE, 8);

async function defaultCreateClient() {
  const client = new CodexAppServerClient();
  await client.start();
  return client;
}

function makePool(size, createClient) {
  return { size, createClient, idle: [], total: 0, waiters: [], closed: false };
}

// Two pools: the production singleton (one warm pool, keyed only by size), and an
// isolated pool for an injected factory so a test's _createClient can never swap
// out or orphan the live pool. (SR-047/058)
let _pool = null;
let _testPool = null;

function resolvePool(size, createClient, isTest) {
  if (isTest) {
    if (!_testPool || _testPool.size !== size || _testPool.createClient !== createClient) {
      _testPool = makePool(size, createClient);
    }
    return _testPool;
  }
  if (!_pool || _pool.size !== size) _pool = makePool(size, createClient);
  return _pool;
}

// Fill free capacity with fresh clients for queued waiters. Called from every
// slot-freeing path so a create failure or dead-client release can never leave a
// waiter stranded behind capacity that has already been freed — the invariant
// "waiters non-empty ⇒ total === size" is repaired here, not just asserted. (SR-044/045/053)
function pumpWaiters(pool) {
  while (!pool.closed && pool.waiters.length && pool.total < pool.size) {
    const waiter = pool.waiters.shift();
    pool.total++;
    pool.createClient().then(
      (client) => {
        if (pool.closed) { client.stop?.(); waiter.reject(new Error("codex pool closed")); return; }
        waiter.resolve(client);
      },
      (err) => { pool.total--; waiter.reject(err); pumpWaiters(pool); },
    );
  }
}

async function acquireFromPool(pool) {
  // Prefer a warm, live client.
  while (pool.idle.length) {
    const c = pool.idle.pop();
    if (!c._closed) return c;
    pool.total--; // discard a client that died while idle
  }
  // Room to grow: create a new client (count the slot before awaiting so
  // concurrent acquirers don't oversubscribe).
  if (pool.total < pool.size) {
    pool.total++;
    try {
      return await pool.createClient();
    } catch (err) {
      pool.total--;
      pumpWaiters(pool); // freed capacity — let any queued waiters try
      throw err;
    }
  }
  // At capacity — wait for a release (or a pumped creation) to hand us a client.
  return new Promise((resolve, reject) => pool.waiters.push({ resolve, reject }));
}

function releaseToPool(pool, client) {
  const dead = !client || client._closed;
  if (dead) {
    pool.total--;
    pumpWaiters(pool); // a dead release frees a slot — refill for waiters
    return;
  }
  if (pool.closed) { client.stop?.(); pool.total--; return; } // pool was reset under us
  const waiter = pool.waiters.shift();
  if (waiter) { waiter.resolve(client); return; } // hand the live client straight over
  pool.idle.push(client); // keep it warm
}

/**
 * Run `fn(client)` on a pooled codex client, allowing up to `size` calls to run
 * concurrently. Drop-in concurrent alternative to withSharedClient.
 * @param {Function} fn                receives a live CodexAppServerClient
 * @param {object}   [opts]
 * @param {number}   [opts.size]       max concurrent clients (default 8 / $FABRIC_CODEX_POOL_SIZE)
 * @param {Function} [opts._createClient] injectable client factory (tests) — routes to an isolated pool
 */
export function withPooledClient(fn, { size, _createClient } = {}) {
  const isTest = !!_createClient;
  const pool = resolvePool(sanitizeSize(size, DEFAULT_POOL_SIZE), _createClient || defaultCreateClient, isTest);
  return (async () => {
    const client = await acquireFromPool(pool);
    try {
      return await fn(client);
    } finally {
      releaseToPool(pool, client);
    }
  })();
}

// Test hook: close idle clients, reject queued waiters, and drop pool state.
// Checked-out clients aren't tracked; the `closed` flag makes their eventual
// release close them instead of re-idling into an orphaned pool. (SR-046/055)
export function _resetPool() {
  for (const pool of [_pool, _testPool]) {
    if (!pool) continue;
    pool.closed = true;
    for (const c of pool.idle.splice(0)) c.stop?.();
    for (const w of pool.waiters.splice(0)) w.reject(new Error("codex pool reset"));
  }
  _pool = null;
  _testPool = null;
}
