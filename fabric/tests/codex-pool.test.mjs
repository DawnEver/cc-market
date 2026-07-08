// codex-pool.test.mjs — withPooledClient: concurrent codex calls over a bounded
// pool of warm app-server clients. Each call borrows a client for EXCLUSIVE use
// (no notification cross-talk, the same isolation the shared-mutex path had),
// but N calls run at once instead of serializing on one client.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withPooledClient, _resetPool } from "../engine/codex/app-server.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

describe("withPooledClient", () => {
  it("runs overlapping calls concurrently on distinct clients", async () => {
    _resetPool();
    let created = 0;
    const _createClient = async () => ({ n: ++created, _closed: false });
    const gate = deferred();
    let started = 0;
    const bothStarted = deferred();
    const seen = [];
    const run = () => withPooledClient(async (c) => {
      seen.push(c.n);
      if (++started === 2) bothStarted.resolve();
      await gate.promise;
      return c.n;
    }, { size: 4, _createClient });

    const p1 = run(), p2 = run();
    await bothStarted.promise;            // both ran before either finished → concurrent
    assert.equal(created, 2, "two calls → two distinct clients");
    assert.notEqual(seen[0], seen[1]);
    gate.resolve();
    assert.deepEqual((await Promise.all([p1, p2])).sort(), [1, 2]);
  });

  it("reuses a warm client for sequential calls", async () => {
    _resetPool();
    let created = 0;
    const _createClient = async () => ({ n: ++created, _closed: false });
    const a = await withPooledClient((c) => c.n, { size: 4, _createClient });
    const b = await withPooledClient((c) => c.n, { size: 4, _createClient });
    assert.equal(created, 1, "the warm client is reused, not re-created");
    assert.equal(a, b);
  });

  it("bounds concurrency to size and queues the rest", async () => {
    _resetPool();
    let created = 0;
    const _createClient = async () => ({ n: ++created, _closed: false });
    const gate = deferred();
    let started = 0;
    const twoStarted = deferred();
    const run = () => withPooledClient(async (c) => {
      if (++started === 2) twoStarted.resolve();
      await gate.promise;
      return c.n;
    }, { size: 2, _createClient });

    const ps = [run(), run(), run()];
    await twoStarted.promise;
    await Promise.resolve(); await Promise.resolve();  // let any errant 3rd start
    assert.equal(started, 2, "third call must wait for a free client (size = 2)");
    assert.equal(created, 2, "no more than `size` clients are created");
    gate.resolve();
    await Promise.all(ps);
    assert.equal(created, 2, "the queued call reused a released client — no new one");
  });

  it("discards a closed client and creates a fresh one next time", async () => {
    _resetPool();
    let created = 0;
    const _createClient = async () => ({ n: ++created, _closed: false });
    const a = await withPooledClient((c) => { c._closed = true; return c.n; }, { size: 2, _createClient });
    const b = await withPooledClient((c) => c.n, { size: 2, _createClient });
    assert.equal(created, 2, "a crashed/closed client is not handed out again");
    assert.notEqual(a, b);
  });

  it("releases the client even when fn throws", async () => {
    _resetPool();
    let created = 0;
    const _createClient = async () => ({ n: ++created, _closed: false });
    await assert.rejects(withPooledClient(() => { throw new Error("boom"); }, { size: 1, _createClient }));
    // Pool of 1: if the client leaked, this second call would hang forever.
    const v = await withPooledClient((c) => c.n, { size: 1, _createClient });
    assert.equal(v, 1, "the client returned to the pool and was reused");
  });

  // SR-045/053: a createClient failure while callers are queued must not strand
  // the rest of the queue. size=1: A holds the only client and releases it dead;
  // the replacement create fails (rejecting B); C must still get a fresh client,
  // not hang forever.
  it("a failed replacement create does not strand other waiters (size=1)", async () => {
    _resetPool();
    let calls = 0;
    const _createClient = async () => {
      calls++;
      if (calls === 2) throw new Error("create failed");  // the replacement fails
      return { n: calls, _closed: false };
    };
    const gateA = deferred();
    const aHolds = deferred();
    const pA = withPooledClient(async (c) => {
      aHolds.resolve();
      await gateA.promise;
      c._closed = true;   // A returns a dead client
      return "A";
    }, { size: 1, _createClient });
    await aHolds.promise;

    let bOutcome, cOutcome;
    const pB = withPooledClient((c) => (bOutcome = c.n), { size: 1, _createClient }).catch(() => (bOutcome = "rejected"));
    const pC = withPooledClient((c) => (cOutcome = c.n), { size: 1, _createClient }).catch(() => (cOutcome = "rejected"));

    gateA.resolve();
    await Promise.all([pA, pB, pC]);
    assert.equal(bOutcome, "rejected", "B got the failed replacement create");
    assert.equal(cOutcome, 3, "C got a fresh client instead of hanging forever");
  });

  // SR-049: a bad size must not deadlock — clamp to the default instead.
  it("clamps a non-positive size and still runs", async () => {
    _resetPool();
    let created = 0;
    const _createClient = async () => ({ n: ++created, _closed: false });
    const v = await withPooledClient((c) => c.n, { size: 0, _createClient });
    assert.equal(v, 1, "size 0 clamped to the default; the call ran");
  });

  // SR-046/055: reset must not silently orphan warm clients — it should close them.
  it("_resetPool closes idle clients", async () => {
    _resetPool();
    const stopped = [];
    const _createClient = async () => ({ n: stopped.length, _closed: false, stop() { stopped.push(this); } });
    await withPooledClient((c) => c.n, { size: 2, _createClient });  // leaves one warm client idle
    _resetPool();
    assert.equal(stopped.length, 1, "the idle client was closed on reset");
  });
});
