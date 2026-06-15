import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CodexAppServerClient, CLIENT_VERSION } from "../scripts/codex/app-server.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("CLIENT_VERSION", () => {
  test("matches plugin.json version (no hardcoded drift)", () => {
    const { version } = JSON.parse(
      readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"),
    );
    assert.equal(CLIENT_VERSION, version);
  });
});

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

    // Clean up pending promise — send() creates a timeout that fires after the test ends
    for (const [, entry] of client.pending) {
      clearTimeout(entry.timer);
    }
    client.pending.clear();
  });

  test("ignores invalid JSON lines", () => {
    const client = new CodexAppServerClient();
    assert.doesNotThrow(() => client._handleLine("not json"));
  });
});

describe("_rejectAllPending", () => {
  // Regression: child 'error'/'close' handlers rejected pending requests but never
  // cleared their setTimeout timers (up to 10 min), keeping the event loop alive long
  // after the work finished — so test runs and short-lived CLI calls hung until killed.
  test("rejects all pending and clears the map (timers cleared)", () => {
    const client = new CodexAppServerClient();
    client.child = { stdin: { write: () => {} } };
    client._closed = false;

    const p = client.send("test/method", { x: 1 });
    assert.equal(client.pending.size, 1);

    client._rejectAllPending(new Error("boom"));
    assert.equal(client.pending.size, 0);

    return assert.rejects(p, /boom/);
  });
});

describe("withSharedClient queue counter (source guard)", () => {
  // Regression: `_pendingCount` was declared with `let` inside withSharedClient and
  // referenced on its own RHS (`let _pendingCount = (_pendingCount || 0) + 1`), throwing
  // a TDZ error ("Cannot access '_pendingCount' before initialization") synchronously on
  // every call — which silently broke ALL codex routing (review/task). A runtime test would
  // spawn a real codex app-server, so guard the source statically instead.
  const src = readFileSync(
    join(__dirname, "..", "scripts", "codex", "app-server.mjs"),
    "utf8",
  );

  test("declares _pendingCount at module scope", () => {
    assert.match(src, /^let _pendingCount = 0;$/m);
  });

  test("does not re-declare _pendingCount inside a function (TDZ self-reference)", () => {
    assert.doesNotMatch(src, /let\s+_pendingCount\s*=\s*\(?\s*_pendingCount/);
  });
});
