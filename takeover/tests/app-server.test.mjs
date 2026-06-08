import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CodexAppServerClient } from "../scripts/codex/app-server.mjs";

describe("CodexAppServerClient constructor", () => {
  test("sets default timeout to 600000", () => {
    const client = new CodexAppServerClient();
    assert.equal(client.timeout, 600000);
  });

  test("accepts custom timeout", () => {
    const client = new CodexAppServerClient({ timeout: 30000 });
    assert.equal(client.timeout, 30000);
  });

  test("sets up empty pending map and notification handlers", () => {
    const client = new CodexAppServerClient();
    assert.equal(client.pending.size, 0);
    assert.equal(client.notificationHandlers.size, 0);
    assert.equal(client._closed, false);
  });
});

describe("CodexAppServerClient onNotification", () => {
  test("registers and dispatches notification handlers", () => {
    const client = new CodexAppServerClient();
    const calls = [];
    const handler = (params) => calls.push(params);

    client.onNotification("test/method", handler);
    assert.equal(client.notificationHandlers.get("test/method").length, 1);

    // Simulate notification dispatch
    client._handleLine(JSON.stringify({ method: "test/method", params: { x: 1 } }));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { x: 1 });
  });

  test("removeNotificationHandler deregisters", () => {
    const client = new CodexAppServerClient();
    const handler = () => {};
    client.onNotification("test/method", handler);
    client.removeNotificationHandler("test/method", handler);
    assert.equal(client.notificationHandlers.get("test/method").length, 0);
  });
});

describe("CodexAppServerClient _handleLine", () => {
  test("routes responses to pending promises", () => {
    const client = new CodexAppServerClient();
    client.child = { stdin: { write: () => {} } };
    client._closed = false;

    const promise = client.send("test/method", { x: 1 });
    client._handleLine(JSON.stringify({ id: 1, result: { ok: true } }));

    return promise.then((result) => {
      assert.deepEqual(result, { ok: true });
    });
  });

  test("routes errors to pending promises", () => {
    const client = new CodexAppServerClient();
    client.child = { stdin: { write: () => {} } };
    client._closed = false;

    const id = client.nextId; // capture next id before send increments
    const promise = client.send("test/method", { x: 1 });
    client._handleLine(JSON.stringify({ id, error: { code: -32000, message: "fail" } }));

    return promise.catch((err) => {
      assert.ok(err.message.includes("fail"));
    });
  });

  test("sends JSON-RPC formatted message", () => {
    const client = new CodexAppServerClient();
    const writes = [];
    client.child = {
      stdin: {
        write: (data) => { writes.push(data); },
      },
    };
    client._closed = false;

    client.send("test/method", { x: 1 });
    const written = JSON.parse(writes[0]);
    assert.equal(written.jsonrpc, "2.0");
    assert.equal(written.method, "test/method");
    assert.deepEqual(written.params, { x: 1 });
    assert.ok(written.id > 0);
  });

  test("ignores invalid JSON lines", () => {
    const client = new CodexAppServerClient();
    assert.doesNotThrow(() => client._handleLine("not json"));
  });
});
