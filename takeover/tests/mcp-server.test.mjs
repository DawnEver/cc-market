/**
 * Tests for takeover/scripts/mcp-server.mjs — MCP protocol, tool dispatch, validation.
 * Run: node --test cc-market/takeover/tests/mcp-server.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOLS,
  handleToolCall,
  handleCallModel,
  send,
  encodeRpcMessage,
  API_DISPATCH,
  CLAUDE_DISPATCH,
} from "../scripts/mcp-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "..", "scripts", "mcp-server.mjs");

function parseFramedMessage(output) {
  const headerEnd = output.indexOf("\r\n\r\n");
  assert.notEqual(headerEnd, -1, `missing framed header in: ${output}`);
  const header = output.slice(0, headerEnd);
  const match = /^Content-Length:\s*(\d+)$/im.exec(header);
  assert.ok(match, `missing Content-Length in: ${header}`);
  const length = Number(match[1]);
  const body = output.slice(headerEnd + 4, headerEnd + 4 + length);
  assert.equal(Buffer.byteLength(body, "utf8"), length);
  return JSON.parse(body);
}

function runServer(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("mcp-server test timed out"));
    }, 3000);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

// ── TOOLS definition ───────────────────────────────────────────────────────────

describe("TOOLS definition", () => {
  test("has exactly three tools", () => {
    assert.equal(TOOLS.length, 3);
    const names = TOOLS.map(t => t.name);
    assert.deepEqual(names, ["call_model", "list_models", "codex_status"]);
  });

  test("call_model has correct schema", () => {
    const tool = TOOLS.find(t => t.name === "call_model");
    assert.ok(tool);
    assert.ok(tool.description.length > 20);
    assert.ok(tool.inputSchema.properties.provider);
    assert.ok(tool.inputSchema.properties.userPrompt);
    assert.ok(tool.inputSchema.properties.model);
    assert.ok(tool.inputSchema.properties.mode);
    assert.deepEqual(tool.inputSchema.properties.mode.enum, ["task", "review", "image-generate", "image-edit", "agent"]);
    assert.deepEqual(tool.inputSchema.required, ["userPrompt"]);
  });

  test("list_models has empty properties schema", () => {
    const tool = TOOLS.find(t => t.name === "list_models");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema, { type: "object", properties: {} });
  });
});

// ── send ───────────────────────────────────────────────────────────────────────

describe("send", () => {
  test("writes JSON to stdout", () => {
    let captured;
    const orig = process.stdout.write;
    process.stdout.write = (data) => { captured = data; return true; };
    try {
      send({ jsonrpc: "2.0", id: 1, result: { ok: true } });
      assert.ok(captured.includes('"jsonrpc":"2.0"'));
      assert.ok(captured.includes('"result"'));
    } finally {
      process.stdout.write = orig;
    }
  });

  test("can encode standard MCP Content-Length frames", () => {
    const encoded = encodeRpcMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }, "framed");
    assert.match(encoded, /^Content-Length: \d+\r\n\r\n/);
    assert.deepEqual(parseFramedMessage(encoded), { jsonrpc: "2.0", id: 1, result: { ok: true } });
  });
});

// ── stdio transport ───────────────────────────────────────────────────────────

describe("stdio transport", () => {
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };

  test("handles newline-delimited JSON initialize for Claude Code compatibility", async () => {
    const { code, stdout, stderr } = await runServer(`${JSON.stringify(initialize)}\n`);
    assert.equal(code, 0);
    assert.equal(stderr, "");

    const response = JSON.parse(stdout.trim());
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "takeover");
    assert.deepEqual(response.result.capabilities, { tools: {} });
  });

  test("handles final newline-delimited JSON message without trailing newline", async () => {
    const { code, stdout, stderr } = await runServer(JSON.stringify(initialize));
    assert.equal(code, 0);
    assert.equal(stderr, "");

    const response = JSON.parse(stdout.trim());
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "takeover");
  });

  test("handles Content-Length framed initialize for Codex MCP clients", async () => {
    const { code, stdout, stderr } = await runServer(encodeRpcMessage(initialize, "framed"));
    assert.equal(code, 0);
    assert.equal(stderr, "");

    const response = parseFramedMessage(stdout);
    assert.equal(response.jsonrpc, "2.0");
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, "takeover");
    assert.deepEqual(response.result.capabilities, { tools: {} });
  });
});

// ── handleToolCall ─────────────────────────────────────────────────────────────

describe("handleToolCall", () => {
  test("routes to list_models handler", async () => {
    const result = await handleToolCall("list_models", {});
    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, "text");
    assert.ok(result.content[0].text.includes("claude"));
    assert.ok(result.content[0].text.includes("codex"));
  });

  test("throws on unknown tool name", async () => {
    await assert.rejects(
      () => handleToolCall("nonexistent_tool", {}),
      /Unknown tool: nonexistent_tool/
    );
  });
});

// ── handleCallModel validation ─────────────────────────────────────────────────

describe("handleCallModel", () => {
  test("throws on empty userPrompt", async () => {
    await assert.rejects(
      () => handleCallModel({ provider: "claude", userPrompt: "" }),
      /userPrompt must be non-empty/
    );
  });

  test("throws on whitespace-only userPrompt", async () => {
    await assert.rejects(
      () => handleCallModel({ provider: "claude", userPrompt: "   " }),
      /userPrompt must be non-empty/
    );
  });

  test("throws on missing userPrompt", async () => {
    await assert.rejects(
      () => handleCallModel({ provider: "claude" }),
      /userPrompt must be non-empty/
    );
  });
});

// ── handleCallModel dispatch routing ───────────────────────────────────────────

describe("handleCallModel dispatch routing", () => {
  test("rejects unsupported mode for claude provider", async () => {
    // image-generate is codex-only; claude (native) has no image dispatch.
    await assert.rejects(
      () => handleCallModel({ provider: "claude", userPrompt: "test", mode: "image-generate" }),
      /not supported for provider/
    );
  });

  test("rejects unsupported mode for API provider", async () => {
    // deepseek is an API provider — image modes only for codex
    await assert.rejects(
      () => handleCallModel({ provider: "deepseek", userPrompt: "test", mode: "image-generate" }),
      /not supported for provider/
    );
  });

  test("review mode is supported for non-codex providers (maps to task)", () => {
    // Regression: sharp-review sends mode="review" to deepseek/sonnet reviewers.
    // Previously rejected ("not supported"), silently zeroing those reviewers.
    // Assert the dispatch maps now expose a review handler.
    assert.equal(typeof API_DISPATCH.review, "function");
    assert.equal(typeof CLAUDE_DISPATCH.review, "function");
  });

  test("throws ConfigError on missing provider", async () => {
    await assert.rejects(
      () => handleCallModel({ userPrompt: "test" }),
      /provider is required/
    );
  });

  test("parses provider from <command> block", async () => {
    // Force the claude spawn to fail fast (ENOENT) so this exercises flag
    // parsing → native-claude dispatch without launching a real CLI.
    const prev = process.env.CLAUDE_CLI_PATH;
    process.env.CLAUDE_CLI_PATH = path.join(__dirname, "_no_such_claude_binary.exe");
    try {
      await assert.rejects(
        () => handleCallModel({ userPrompt: "<command>\n--provider claude\n</command>\ntest prompt" }),
      );
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = prev;
    }
  });
});

// ── handleToolCall error handling ──────────────────────────────────────────────

describe("handleToolCall error handling", () => {
  test("call_model with empty userPrompt returns error via handler dispatch", async () => {
    await assert.rejects(
      () => handleToolCall("call_model", { provider: "claude", userPrompt: "" }),
      /userPrompt must be non-empty/
    );
  });
});
