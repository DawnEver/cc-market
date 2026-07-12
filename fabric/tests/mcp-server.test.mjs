// Tests for the fabric MCP server — unified `call` primitive (ex takeover call_model ∪ fabric
// run_task), persistent-session tools, and provider introspection. No real claude/codex/
// network: `call` dispatch is validated via schema + routing + <command> parsing + injected
// fakes; sessions via injected registry deps.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOLS, handleToolCall, handleCall, send, encodeRpcMessage,
  API_DISPATCH, CLAUDE_DISPATCH, CODEX_DISPATCH,
} from "../scripts/mcp-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "scripts", "mcp-server.mjs");
const text = (r) => r.content[0].text;

function parseFramedMessage(output) {
  const headerEnd = output.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1, `missing framed header in: ${output}`);
  const match = /^Content-Length:\s*(\d+)$/im.exec(output.slice(0, headerEnd));
  assert.ok(match, "missing Content-Length");
  const length = Number(match[1]);
  return JSON.parse(output.slice(headerEnd + 4, headerEnd + 4 + length));
}

function runServer(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("mcp-server test timed out")); }, 3000);
    child.stdout.on("data", (c) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.write(input); child.stdin.end();
  });
}

// ── TOOLS registry ───────────────────────────────────────────────────

describe("TOOLS registry", () => {
  test("registers the expected tool names", () => {
    assert.deepEqual(TOOLS.map((t) => t.name).sort(),
      ["call", "codex_status", "list_providers", "list_sessions", "resolve_model",
       "session_close", "session_send", "spawn_session"]);
  });

  test("call schema: prompt required, mode enum, options present", () => {
    const tool = TOOLS.find((t) => t.name === "call");
    assert.ok(tool.description.length > 20);
    assert.ok(tool.inputSchema.properties.provider);
    assert.ok(tool.inputSchema.properties.prompt);
    assert.ok(tool.inputSchema.properties.observe, "observe folded in from run_task");
    assert.deepEqual(tool.inputSchema.properties.mode.enum,
      ["task", "review", "agent", "image-generate", "image-edit"]);
    assert.deepEqual(tool.inputSchema.properties.resultMode.enum,
      ["summary", "full", "truncate"]);
    assert.deepEqual(tool.inputSchema.required, ["prompt"]);
  });
});

// ── transport ────────────────────────────────────────────────────────

describe("send / transport", () => {
  test("encodes framed MCP messages", () => {
    const encoded = encodeRpcMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }, "framed");
    assert.match(encoded, /^Content-Length: \d+\r\n\r\n/);
    assert.deepEqual(parseFramedMessage(encoded), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } };

  test("newline-delimited initialize (Claude Code)", async () => {
    const { code, stdout, stderr } = await runServer(`${JSON.stringify(initialize)}\n`);
    assert.equal(code, 0); assert.equal(stderr, "");
    const r = JSON.parse(stdout.trim());
    assert.equal(r.result.serverInfo.name, "fabric");
  });

  test("Content-Length framed initialize (Codex)", async () => {
    const { code, stdout } = await runServer(encodeRpcMessage(initialize, "framed"));
    assert.equal(code, 0);
    assert.equal(parseFramedMessage(stdout).result.serverInfo.name, "fabric");
  });
});

// ── call: validation + dispatch routing ──────────────────────────────

describe("call primitive", () => {
  test("throws on empty / missing prompt", async () => {
    await assert.rejects(() => handleCall({ provider: "claude", prompt: "" }), /prompt must be non-empty/);
    await assert.rejects(() => handleCall({ provider: "claude" }), /prompt must be non-empty/);
  });

  test("throws when provider missing", async () => {
    await assert.rejects(() => handleCall({ prompt: "hi" }), /provider is required/);
  });

  test("rejects image modes for non-codex providers", async () => {
    await assert.rejects(() => handleCall({ provider: "claude", prompt: "x", mode: "image-generate" }), /not supported for provider/);
    await assert.rejects(() => handleCall({ provider: "deepseek", prompt: "x", mode: "image-generate" }), /not supported for provider/);
  });

  test("review mode is available for non-codex providers (sharp-review regression)", () => {
    assert.equal(typeof API_DISPATCH.review, "function");
    assert.equal(typeof CLAUDE_DISPATCH.review, "function");
    assert.equal(typeof CODEX_DISPATCH.review, "function");
  });

  test("parses provider + mode from <command> block", async () => {
    // Force claude spawn to fail fast so we exercise parse → native dispatch, no real CLI.
    const prev = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = path.join(__dirname, "_no_such_claude.exe");
    try {
      await assert.rejects(() => handleCall({ prompt: "<command>\n--provider claude\n</command>\ndo it" }));
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CLI_PATH; else process.env.CLAUDE_CLI_PATH = prev;
    }
  });

  test("observe:true (non-codex) routes to the observe/spawnChild path, not dispatch", async () => {
    let seen = null;
    const fakeSpawnChild = async (opts) => { seen = opts; return { code: 0, stdout: "captured", stderr: "", jsonlPath: null }; };
    const res = await handleCall({ provider: "deepseek", prompt: "trace me", observe: true }, { spawnChild: fakeSpawnChild });
    assert.equal(seen.observe, true);
    assert.equal(seen.provider, "deepseek");
    assert.match(text(res), /captured/);
  });
});

// ── introspection ────────────────────────────────────────────────────

describe("introspection tools", () => {
  test("list_providers lists claude + codex", async () => {
    const res = await handleToolCall("list_providers", {});
    assert.match(text(res), /claude/);
    assert.match(text(res), /codex/);
  });

  test("unknown tool throws", async () => {
    await assert.rejects(() => handleToolCall("nope", {}), /Tool not found/);
  });
});

// ── persistent session tools (injected registry) ─────────────────────

describe("session tools", () => {
  test("spawn_session creates + returns descriptor; requires provider", async () => {
    let seen = null;
    const fakeCreate = async (opts) => { seen = opts; return { id: "sess-1", provider: opts.provider, nativeId: "thread-1" }; };
    const res = await handleToolCall("spawn_session", { provider: "codex", write: true, cwd: "/repo" }, { createSession: fakeCreate });
    assert.equal(seen.provider, "codex");
    assert.equal(seen.write, true);
    assert.deepEqual(JSON.parse(text(res)), { id: "sess-1", provider: "codex", nativeId: "thread-1" });
    await assert.rejects(() => handleToolCall("spawn_session", {}), /provider is required/);
  });

  test("session_send routes to registry, returns reply; requires id+prompt", async () => {
    const fakeSend = async (id, prompt) => ({ text: `${id}:${prompt}`, turn: 3 });
    const res = await handleToolCall("session_send", { id: "sess-1", prompt: "go" }, { sendToSession: fakeSend });
    assert.equal(text(res), "sess-1:go");
    await assert.rejects(() => handleToolCall("session_send", { id: "x" }), /required/);
  });

  test("session_close + list_sessions", async () => {
    const res = await handleToolCall("session_close", { id: "sess-1" }, { closeSession: async (id) => ({ id, exitCode: 0, turns: 2 }) });
    assert.equal(JSON.parse(text(res)).exitCode, 0);
    const listed = await handleToolCall("list_sessions", {}, { listSessions: () => [{ id: "sess-1", provider: "codex", turns: 2, createdAt: 0 }] });
    assert.equal(JSON.parse(text(listed))[0].id, "sess-1");
  });
});
