// engine/codex/session.mjs — PERSISTENT multi-turn codex session.
//
// The codex app-server is natively multi-turn: one `thread/start` yields a threadId, then
// each `turn/start` on that same threadId continues the conversation with full context. This
// wraps that lifecycle behind the same `{ id, send(text), close() }` surface as the claude
// `openSession`, so the session registry can hold either provider uniformly. One long-lived
// CodexAppServerClient + one thread per session; turns are serialized (one turn at a time).

import { CodexAppServerClient } from "./app-server.mjs";
import { extractItemText } from "./task.mjs";

/**
 * Open a persistent codex session (one app-server client + one thread).
 * @param {object} opts  model?, write?, cwd?, _client? (test injection)
 * @returns {Promise<{provider, id, turns, send, close}>}
 *   send(text) → Promise<{text, turn, usage}>   (await sequentially; one turn at a time)
 *   close()    → Promise<number|null>
 */
export async function openCodexSession(opts = {}) {
  const { model, write = false, cwd, _client, compactConfirmTimeoutMs = 300_000 } = opts;
  const client = _client || new CodexAppServerClient({ timeout: 600000 });
  if (!_client) await client.start();

  let threadId = null;
  let current = null; // { resolve, text } for the in-flight turn

  client.onNotification("thread/started", (p) => { threadId = p?.thread?.id || threadId; });
  client.onNotification("item/completed", (p) => {
    if (!current) return;
    const t = extractItemText(p?.item || {});
    if (t) current.text += (current.text ? "\n" : "") + t;
  });
  client.onNotification("turn/completed", (p) => {
    if (!current) return;
    const c = current; current = null;
    c.resolve({ text: c.text.trim(), usage: p?.usage || null });
  });

  const threadResp = await client.send("thread/start", { cwd: cwd || process.cwd() });
  threadId = threadResp?.thread?.id || threadResp?.id || threadId;

  let turnCount = 0;
  let chain = Promise.resolve(); // serialize send() calls — one turn at a time

  function send(text) {
    const run = () => new Promise((resolve, reject) => {
      current = { resolve, text: "" };
      const turnParams = {
        threadId,
        input: [{ type: "text", text }],
        tools: write ? undefined : { disabled: true },
      };
      if (model) turnParams.model = model;
      client.send("turn/start", turnParams).catch((e) => { current = null; reject(e); });
    }).then((r) => ({ text: r.text, turn: ++turnCount, usage: r.usage }));
    chain = chain.then(run, run);
    return chain;
  }

  // Native context compaction: the app-server compacts the thread (summarizes the
  // conversation and trims it) — `thread/compact/start` is the protocol's manual
  // compaction, same operation the CLI's /compact runs. Compaction runs as its own
  // async turn, so after the request is accepted we await a completion signal
  // (context_compacted notification, or a compaction/context_compaction item landing)
  // with a deadline. A signal never observed is reported honestly: confirmed:false.
  function compact() {
    const run = () => new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (settled) return; settled = true; cleanup(); fn(v); };
      let timer = null;
      const cleanup = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        client.removeNotificationHandler("context_compacted", onCompacted);
        client.removeNotificationHandler("item/completed", onItem);
      };
      const onCompacted = () => finish(resolve, { compacted: true, confirmed: true });
      const onItem = (p) => {
        const t = p?.item?.type;
        if (t === "compaction" || t === "context_compaction") onCompacted();
      };
      client.onNotification("context_compacted", onCompacted);
      client.onNotification("item/completed", onItem);
      timer = setTimeout(() => finish(resolve, { compacted: true, confirmed: false }), compactConfirmTimeoutMs);
      timer.unref?.();
      client.send("thread/compact/start", { threadId }).catch((e) => { finish(reject, e); });
    });
    chain = chain.then(run, run);
    return chain;
  }

  async function close() {
    await client.stop();
    return 0;
  }

  return {
    provider: "codex",
    get id() { return threadId; },
    get turns() { return turnCount; },
    // Native compaction — the app-server protocol has thread/compact/start.
    get compactable() { return true; },
    // Liveness fact for the console: `current` is the in-flight turn — non-null while a
    // turn is being generated. The "is it still outputting" signal for codex sessions.
    get working() { return current !== null; },
    send,
    compact,
    close,
  };
}
