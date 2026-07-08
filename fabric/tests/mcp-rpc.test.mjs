// Tests for engine/mcp-rpc.mjs — the shared JSON-RPC stdio transport factory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeRpcMessage, createStdioServer, LINE, FRAMED } from "../engine/mcp-rpc.mjs";

test("encodeRpcMessage: line vs framed", () => {
  const msg = { jsonrpc: "2.0", id: 1, result: { ok: true } };
  assert.equal(encodeRpcMessage(msg, LINE), JSON.stringify(msg) + "\n");
  const framed = encodeRpcMessage(msg, FRAMED);
  assert.match(framed, /^Content-Length: \d+\r\n\r\n/);
  const body = framed.slice(framed.indexOf("\r\n\r\n") + 4);
  assert.equal(Buffer.byteLength(body, "utf8"), Number(/Content-Length:\s*(\d+)/.exec(framed)[1]));
});

function harness(tools, handleToolCall) {
  const sent = [];
  const out = { write: (s) => { sent.push(JSON.parse(s.trim())); return true; } };
  const rpc = createStdioServer({ serverInfo: { name: "t", version: "9" }, tools, handleToolCall, out });
  return { rpc, sent };
}

test("initialize returns serverInfo + tools capability", async () => {
  const { rpc, sent } = harness([], async () => {});
  await rpc.handleRpcRequest({ id: 1, method: "initialize", params: {} });
  assert.equal(sent[0].result.serverInfo.name, "t");
  assert.deepEqual(sent[0].result.capabilities, { tools: {} });
});

test("tools/list returns the registry; tools/call routes to handleToolCall", async () => {
  const tools = [{ name: "x", inputSchema: { type: "object", properties: {} } }];
  const { rpc, sent } = harness(tools, async (name, args) => ({ content: [{ type: "text", text: `${name}:${args.v}` }] }));
  await rpc.handleRpcRequest({ id: 1, method: "tools/list", params: {} });
  assert.deepEqual(sent[0].result.tools, tools);
  await rpc.handleRpcRequest({ id: 2, method: "tools/call", params: { name: "x", arguments: { v: 5 } } });
  assert.equal(sent[1].result.content[0].text, "x:5");
});

test("unknown method → -32601; handler throwing 'not found' → -32602; other → -32000", async () => {
  const { rpc, sent } = harness([], async () => { throw new Error("Tool not found: z"); });
  await rpc.handleRpcRequest({ id: 1, method: "bogus", params: {} });
  assert.equal(sent[0].error.code, -32601);
  await rpc.handleRpcRequest({ id: 2, method: "tools/call", params: { name: "z" } });
  assert.equal(sent[1].error.code, -32602);
  const { rpc: rpc2, sent: sent2 } = harness([], async () => { throw new Error("boom"); });
  await rpc2.handleRpcRequest({ id: 3, method: "tools/call", params: { name: "q" } });
  assert.equal(sent2[0].error.code, -32000);
});

test("notifications/initialized is a no-op (no reply)", async () => {
  const { rpc, sent } = harness([], async () => {});
  await rpc.handleRpcRequest({ id: undefined, method: "notifications/initialized", params: {} });
  assert.equal(sent.length, 0);
});
