import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findCodexBinary } from "./discovery.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CLIENT_VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "..", ".claude-plugin", "plugin.json"), "utf8"),
).version;

export class CodexAppServerClient {
  constructor(opts = {}) {
    this.codexPath = opts.codexPath;
    this.timeout = opts.timeout ?? 600000;
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
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });

    this.child.on("close", (code) => {
      this._closed = true;
      for (const [, p] of this.pending) {
        p.reject(new Error(`codex app-server exited ${code}`));
      }
      this.pending.clear();
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
      process.stderr.write(`mcp-takeover[codex]: ${d.toString().trim()}\n`);
    });

    const initResult = await this.send("initialize", {
      protocolVersion: "1.0",
      clientInfo: { name: "takeover", version: CLIENT_VERSION },
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

export function withSharedClient(fn, { timeout = 30000 } = {}) {
  const prev = _lock;
  let release, rejectLock;
  _lock = new Promise((resolve, reject) => { release = resolve; rejectLock = reject; });

  const timeoutId = setTimeout(() => {
    const queueDepth = _pendingCount || 0;
    rejectLock(new Error(
      `Lock acquisition timed out after ${timeout}ms. ` +
      `This usually means the codex app-server process is stuck or has crashed. ` +
      `Pending requests in queue: ${queueDepth}. Run resetSharedClient() to force-restart.`
    ));
  }, timeout);

  _pendingCount++;

  return prev.then(async () => {
    clearTimeout(timeoutId);
    _pendingCount--;
    try {
      const client = await getSharedClient();
      return await fn(client);
    } finally {
      release();
    }
  }).catch(err => {
    clearTimeout(timeoutId);
    _pendingCount--;
    release();
    throw err;
  });
}
