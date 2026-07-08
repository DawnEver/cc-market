// shared/codex/session.mjs — PERSISTENT multi-turn codex session.
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
  const { model, write = false, cwd, _client } = opts;
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

  async function close() {
    await client.stop();
    return 0;
  }

  return {
    provider: "codex",
    get id() { return threadId; },
    get turns() { return turnCount; },
    send,
    close,
  };
}
