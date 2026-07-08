// Tests for engine/anthropic-http.mjs — fetch is mocked (style follows
// takeover/tests/lib.test.mjs § callAnthropicAPI).

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { callAnthropicAPI, buildUserContent, parseSSEStream } from "../engine/anthropic-http.mjs";

// A body whose reader yields one chunk, then never resolves again.
function stallingBody({ onCancel } = {}) {
  let reads = 0;
  return {
    getReader: () => ({
      read: async () => {
        reads++;
        if (reads === 1) {
          return { done: false, value: new TextEncoder().encode('event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"hi"}}\n\n') };
        }
        return new Promise(() => {}); // stalls forever
      },
      cancel: async () => { onCancel?.(); },
    }),
  };
}

describe("callAnthropicAPI SSE fallback", () => {
  test("retries non-streaming when the SSE stream fails mid-read", async () => {
    const fetches = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      fetches.push({ url, init });
      if (fetches.length === 1) {
        // ok SSE response whose body reader throws mid-stream
        return {
          ok: true,
          headers: { get: () => "text/event-stream" },
          body: {
            getReader: () => ({
              read: async () => { throw new Error("connection reset"); },
            }),
          },
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ content: [{ type: "text", text: "fallback ok" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      const result = await callAnthropicAPI(
        { baseUrl: "https://api.example.com", token: "sk-test" },
        "model", null, "user", null, true
      );
      assert.equal(fetches.length, 2);
      assert.equal(JSON.parse(fetches[0].init.body).stream, true, "first request streams");
      assert.equal("stream" in JSON.parse(fetches[1].init.body), false, "retry is genuinely non-streaming");
      assert.equal(result.content[0].text, "fallback ok");
    } finally {
      globalThis.fetch = undefined;
    }
  });
});

describe("parseSSEStream idle watchdog", () => {
  test("rejects with a stall error and cancels the reader when reads go idle", async () => {
    let cancelled = false;
    await assert.rejects(
      parseSSEStream(stallingBody({ onCancel: () => { cancelled = true; } }), { idleTimeoutMs: 50 }),
      /SSE stream stalled after 50ms/
    );
    assert.equal(cancelled, true, "reader.cancel() called on stall");
  });

  test("honors the caller's abort signal mid-stream", async () => {
    const ctl = new AbortController();
    let cancelled = false;
    const p = parseSSEStream(stallingBody({ onCancel: () => { cancelled = true; } }), { idleTimeoutMs: 60000, signal: ctl.signal });
    globalThis.setTimeout(() => ctl.abort(), 10);
    await assert.rejects(p, /abort/i);
    assert.equal(cancelled, true);
  });
});

describe("callAnthropicAPI stalled-stream fallback", () => {
  test("falls back to non-streaming when the SSE body stalls", async () => {
    const fetches = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      fetches.push({ url, init });
      if (fetches.length === 1) {
        return { ok: true, headers: { get: () => "text/event-stream" }, body: stallingBody() };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ content: [{ type: "text", text: "fallback ok" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      const result = await callAnthropicAPI(
        { baseUrl: "https://api.example.com", token: "sk-test" },
        "model", null, "user", null, true, null, { sseIdleTimeoutMs: 50 }
      );
      assert.equal(fetches.length, 2);
      assert.equal("stream" in JSON.parse(fetches[1].init.body), false, "retry is non-streaming");
      assert.equal(result.content[0].text, "fallback ok");
    } finally {
      globalThis.fetch = undefined;
    }
  });
});

describe("callAnthropicAPI never resolves undefined (SR-20260708-035)", () => {
  test("SSE failure on the final attempt still yields a result or rejection, never undefined", async () => {
    // Attempts 1..2 burn the retry budget with retryable 429s (stream still on),
    // attempt 3 (the final one) returns an ok SSE response whose reader throws
    // immediately — with the old code the downgrade `continue` on the last
    // attempt exits the loop and resolves undefined.
    const fetches = [];
    globalThis.fetch = mock.fn(async (url, init) => {
      fetches.push({ url, init });
      if (fetches.length <= 2) {
        return { ok: false, status: 429, headers: { get: () => "application/json" }, text: async () => "rate limited" };
      }
      if (fetches.length === 3) {
        return {
          ok: true,
          headers: { get: () => "text/event-stream" },
          body: { getReader: () => ({ read: async () => { throw new Error("connection reset"); } }) },
        };
      }
      return {
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ content: [{ type: "text", text: "downgrade ok" }], stop_reason: "end_turn", usage: {} }),
      };
    });

    try {
      let result, error;
      try {
        result = await callAnthropicAPI(
          { baseUrl: "https://api.example.com", token: "sk-test" },
          "model", null, "user", null, true
        );
      } catch (err) {
        error = err;
      }
      if (!error) {
        assert.notEqual(result, undefined, "must never resolve undefined");
        assert.equal(result.content[0].text, "downgrade ok", "downgrade gets a real non-streaming retry");
        assert.equal("stream" in JSON.parse(fetches.at(-1).init.body), false, "final retry is non-streaming");
      }
    } finally {
      globalThis.fetch = undefined;
    }
  });

  test("plain retryable exhaustion rejects with 'retries exhausted', never resolves undefined", async () => {
    globalThis.fetch = mock.fn(async () => (
      { ok: false, status: 503, headers: { get: () => "application/json" }, text: async () => "overloaded" }
    ));
    try {
      await assert.rejects(
        callAnthropicAPI(
          { baseUrl: "https://api.example.com", token: "sk-test" },
          "model", null, "user", null, false
        ),
        /retries exhausted/
      );
    } finally {
      globalThis.fetch = undefined;
    }
  });
});

describe("buildUserContent", () => {
  test("returns the plain string when there are no images", () => {
    assert.equal(buildUserContent("hello", null), "hello");
    assert.equal(buildUserContent("hello", []), "hello");
  });

  test("returns text + image blocks when images are given", () => {
    const content = buildUserContent("look", [{ media_type: "image/jpeg", data: "aGk=" }, { data: "eW8=" }]);
    assert.deepEqual(content, [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGk=" } },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "eW8=" } },
    ]);
  });
});
