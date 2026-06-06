/**
 * Tests for takeover/scripts/mcp-server.mjs — MCP protocol, tool dispatch, validation.
 * Run: node --test cc-market/takeover/tests/mcp-server.test.mjs
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

import { TOOLS, handleToolCall, handleCallModel, send } from "../scripts/mcp-server.mjs";

// ── TOOLS definition ───────────────────────────────────────────────────────────

describe("TOOLS definition", () => {
  test("has exactly two tools", () => {
    assert.equal(TOOLS.length, 2);
    const names = TOOLS.map(t => t.name);
    assert.deepEqual(names, ["call_model", "list_models"]);
  });

  test("call_model has correct schema", () => {
    const tool = TOOLS.find(t => t.name === "call_model");
    assert.ok(tool);
    assert.ok(tool.description.length > 20);
    assert.ok(tool.inputSchema.properties.provider);
    assert.ok(tool.inputSchema.properties.userPrompt);
    assert.ok(tool.inputSchema.properties.model);
    assert.ok(tool.inputSchema.properties.mode);
    assert.deepEqual(tool.inputSchema.properties.mode.enum, ["task", "plan", "handoff-msg"]);
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

// ── handleToolCall error handling ──────────────────────────────────────────────

describe("handleToolCall error handling", () => {
  test("call_model with empty userPrompt returns error via handler dispatch", async () => {
    await assert.rejects(
      () => handleToolCall("call_model", { provider: "claude", userPrompt: "" }),
      /userPrompt must be non-empty/
    );
  });
});
