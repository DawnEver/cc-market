// codex-turn.test.mjs — a codex turn's outcome is read from the app-server's own
// notifications (v2 protocol: `error` {error: TurnError, willRetry} and `turn/completed`
// {turn: {status, error: TurnError}}). A failed turn is a classified ProviderError, never
// the "(no output)" / "(no findings ...)" placeholder.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyTurnError } from "../engine/codex/turn.mjs";
import { runCodexTask } from "../engine/codex/task.mjs";
import { runCodexReview } from "../scripts/codex/review.mjs";

// A pooled-client stand-in: replies to requests and, on the turn-starting request,
// plays a scripted list of notifications.
class FakeClient {
  constructor(script, startMethod) {
    this.script = script;
    this.startMethod = startMethod;
    this.handlers = new Map();
    this.requests = [];
  }
  onNotification(method, h) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(h);
  }
  removeNotificationHandler(method, h) {
    const hs = this.handlers.get(method) || [];
    const i = hs.indexOf(h);
    if (i >= 0) hs.splice(i, 1);
  }
  clearNotifications(method) { if (method) this.handlers.delete(method); else this.handlers.clear(); }
  async send(method, params) {
    this.requests.push({ method, params });
    if (method === "thread/start") return { thread: { id: "th1" } };
    if (method === this.startMethod) {
      setImmediate(() => {
        for (const [m, p] of this.script) for (const h of [...(this.handlers.get(m) || [])]) h(p);
      });
      return { turn: { id: "tu1", status: "inProgress", items: [] } };
    }
    return {};
  }
}

const failedTurn = (codexErrorInfo, message = "boom") => ["turn/completed", {
  threadId: "th1",
  turn: { id: "tu1", items: [], status: "failed", error: { message, codexErrorInfo } },
}];
const completedTurn = ["turn/completed", { threadId: "th1", turn: { id: "tu1", items: [], status: "completed" } }];

describe("classifyTurnError", () => {
  it("maps the declared CodexErrorInfo variants to kinds", () => {
    assert.equal(classifyTurnError({ codexErrorInfo: "usageLimitExceeded" }), "exhausted");
    assert.equal(classifyTurnError({ codexErrorInfo: "sessionBudgetExceeded" }), "exhausted");
    assert.equal(classifyTurnError({ codexErrorInfo: "unauthorized" }), "auth");
    assert.equal(classifyTurnError({ codexErrorInfo: "rateLimitExceeded" }), "rate_limit");
    assert.equal(classifyTurnError({ codexErrorInfo: "serverOverloaded" }), "rate_limit");
    assert.equal(classifyTurnError({ codexErrorInfo: "contextWindowExceeded" }), "failed");
    assert.equal(classifyTurnError({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } }), "auth");
    assert.equal(classifyTurnError({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }), "rate_limit");
    assert.equal(classifyTurnError({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }), "failed");
    assert.equal(classifyTurnError(null), "failed");
  });
});

describe("runCodexTask", () => {
  it("a usage-limit turn is `exhausted`, not (no output)", async () => {
    const client = new FakeClient([
      ["error", { threadId: "th1", turnId: "tu1", willRetry: false, error: { message: "You've hit your usage limit", codexErrorInfo: "usageLimitExceeded" } }],
      failedTurn("usageLimitExceeded", "You've hit your usage limit"),
    ], "turn/start");
    await assert.rejects(runCodexTask("hi", { cwd: ".", client }),
      (e) => e.kind === "exhausted" && /usage limit/.test(e.message));
  });

  it("an auth failure is `auth`", async () => {
    const client = new FakeClient([failedTurn("unauthorized", "401 Unauthorized")], "turn/start");
    await assert.rejects(runCodexTask("hi", { cwd: ".", client }), (e) => e.kind === "auth");
  });

  it("a failed turn without a classified error is `failed`, using the last non-retried error", async () => {
    const client = new FakeClient([
      ["error", { threadId: "th1", turnId: "tu1", willRetry: true, error: { message: "retrying", codexErrorInfo: "rateLimitExceeded" } }],
      ["error", { threadId: "th1", turnId: "tu1", willRetry: false, error: { message: "stream gone", codexErrorInfo: "other" } }],
      ["turn/completed", { threadId: "th1", turn: { id: "tu1", items: [], status: "failed", error: null } }],
    ], "turn/start");
    await assert.rejects(runCodexTask("hi", { cwd: ".", client }),
      (e) => e.kind === "failed" && /stream gone/.test(e.message));
  });

  it("an interrupted turn is `failed`", async () => {
    const client = new FakeClient([["turn/completed", { threadId: "th1", turn: { id: "tu1", items: [], status: "interrupted", error: null } }]], "turn/start");
    await assert.rejects(runCodexTask("hi", { cwd: ".", client }),
      (e) => e.kind === "failed" && /interrupted/.test(e.message));
  });

  it("a completed turn returns its text and turn id", async () => {
    const client = new FakeClient([
      ["item/completed", { item: { type: "agentMessage", id: "i1", text: "answer" } }],
      completedTurn,
    ], "turn/start");
    const res = await runCodexTask("hi", { cwd: ".", client });
    assert.equal(res.content[0].text, "answer");
    assert.equal(res.turnId, "tu1");
  });
});

describe("runCodexReview", () => {
  it("a usage-limit review is `exhausted`, not (no findings ...)", async () => {
    const client = new FakeClient([failedTurn("usageLimitExceeded", "usage limit")], "review/start");
    await assert.rejects(runCodexReview("diff --git a b", { cwd: ".", client }), (e) => e.kind === "exhausted");
  });

  it("returns the review text the app-server delivers in exitedReviewMode", async () => {
    const client = new FakeClient([
      ["item/completed", { item: { type: "enteredReviewMode", id: "r0", review: "the request" } }],
      ["item/completed", { item: { type: "exitedReviewMode", id: "r1", review: "HIGH: race in x" } }],
      completedTurn,
    ], "review/start");
    const res = await runCodexReview("diff --git a b", { cwd: ".", client });
    assert.equal(res.content[0].text, "HIGH: race in x");
  });

  it("sends the diff inside the custom target's instructions, the only field it has", async () => {
    const client = new FakeClient([completedTurn], "review/start");
    await runCodexReview("DIFF-BODY", { cwd: ".", client });
    const target = client.requests.find((r) => r.method === "review/start").params.target;
    assert.equal(target.type, "custom");
    assert.deepEqual(Object.keys(target).sort(), ["instructions", "type"]);
    assert.match(target.instructions, /DIFF-BODY/);
  });

  it("puts the model on thread/start, since review/start takes none", async () => {
    const client = new FakeClient([completedTurn], "review/start");
    await runCodexReview("d", { model: "gpt-x", cwd: ".", client });
    assert.equal(client.requests.find((r) => r.method === "thread/start").params.model, "gpt-x");
    assert.equal(client.requests.find((r) => r.method === "review/start").params.model, undefined);
  });
});
