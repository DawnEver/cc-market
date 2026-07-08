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

// ── Concurrent dispatch (the fan-out fix) ─────────────────────────────
// The read loop must NOT await each tool call to completion before reading the
// next request — that serializes fan-out to one lane. It should dispatch
// concurrently, bounded by maxConcurrency, and drain all in-flight work before
// main() resolves.

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// An async-iterable that yields N `tools/call` request lines, then ends.
function requestStream(n) {
  return (async function* () {
    for (let i = 1; i <= n; i++) {
      yield Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "slow", arguments: {} } }) + "\n");
    }
  })();
}

test("main dispatches tool calls concurrently instead of serializing them", async () => {
  const gate = deferred();
  let started = 0, completed = 0;
  const allStarted = deferred();
  const handleToolCall = async () => {
    started++;
    if (started === 3) allStarted.resolve();
    await gate.promise;
    completed++;
    return { content: [{ type: "text", text: "ok" }] };
  };
  const sent = [];
  const out = { write: (s) => { sent.push(JSON.parse(s.trim())); return true; } };
  const rpc = createStdioServer({ serverInfo: { name: "t", version: "9" }, tools: [], handleToolCall, out, maxConcurrency: 8 });

  const done = rpc.main(requestStream(3));
  await allStarted.promise;            // all three ran before any could finish → concurrent
  assert.equal(completed, 0, "no handler should have completed while the gate is closed");
  gate.resolve();
  await done;
  assert.equal(completed, 3);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((m) => m.id).sort(), [1, 2, 3]);
});

test("main bounds concurrency to maxConcurrency", async () => {
  const gate = deferred();
  let started = 0, completed = 0;
  const twoStarted = deferred();
  const handleToolCall = async () => {
    started++;
    if (started === 2) twoStarted.resolve();
    await gate.promise;
    completed++;
    return { content: [{ type: "text", text: "ok" }] };
  };
  const out = { write: () => true };
  const rpc = createStdioServer({ serverInfo: { name: "t", version: "9" }, tools: [], handleToolCall, out, maxConcurrency: 2 });

  const done = rpc.main(requestStream(3));
  await twoStarted.promise;
  // Give any errant third dispatch a few microtasks to (wrongly) start.
  await Promise.resolve(); await Promise.resolve();
  assert.equal(started, 2, "third call must wait for a free slot (cap = 2)");
  gate.resolve();
  await done;
  assert.equal(completed, 3);
});

// SR-048: a non-positive/non-finite maxConcurrency would make acquire() queue
// forever (active never increments) and stall the whole read loop. It must be
// clamped to a working default, not taken literally.
test("main clamps an invalid maxConcurrency instead of deadlocking", async () => {
  let completed = 0;
  const handleToolCall = async () => { completed++; return { content: [{ type: "text", text: "ok" }] }; };
  const out = { write: () => true };
  const rpc = createStdioServer({ serverInfo: { name: "t", version: "9" }, tools: [], handleToolCall, out, maxConcurrency: 0 });
  await rpc.main(requestStream(2));
  assert.equal(completed, 2, "requests still processed under a clamped cap");
});

// SR-050/056: an escape from a handler (e.g. a throwing out.write inside the
// error path) must not surface as an unhandled rejection — one bad call cannot
// crash the process. The dispatcher must swallow escapes, not rely on
// handleRpcRequest's internal catch.
test("main does not leak an unhandled rejection when a write escapes", async () => {
  const leaked = [];
  const onUnhandled = (err) => leaked.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    let calls = 0;
    const written = [];
    const out = {
      write: (s) => {
        calls++;
        // Throw on the result write AND the error-path write for request 1, so the
        // failure escapes handleRpcRequest entirely and reaches the dispatcher.
        if (calls <= 2) throw new Error("stdout exploded");
        written.push(JSON.parse(s.trim()));
        return true;
      },
    };
    const handleToolCall = async () => ({ content: [{ type: "text", text: "ok" }] });
    const rpc = createStdioServer({ serverInfo: { name: "t", version: "9" }, tools: [], handleToolCall, out, maxConcurrency: 1 });
    await rpc.main(requestStream(2));                 // must resolve, not reject
    await new Promise((r) => setTimeout(r, 20));       // let any rejection surface
    assert.deepEqual(leaked.filter((e) => e?.message === "stdout exploded"), [], "no unhandled rejection");
    assert.ok(written.length >= 1, "a later request still processed after the earlier write threw");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
  }
});
