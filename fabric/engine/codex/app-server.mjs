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
