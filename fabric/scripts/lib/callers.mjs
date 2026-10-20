// callers.mjs — takeover's codex companion caller. The raw Anthropic HTTP engine
// (retry + SSE) lives in engine/anthropic-http.mjs and is re-exported here so
// `./lib.mjs` import sites stay stable.
import process from "node:process";

export { callAnthropicAPI } from "../../engine/anthropic-http.mjs";

// opts: {systemPrompt, model, write, images, client, cwd, timeoutMs} — see runCodexTask.
export async function callCodexCompanion(userPrompt, opts = {}) {
  const { runCodexTask } = await import("../../engine/codex/task.mjs");
  return runCodexTask(userPrompt, {
    ...opts,
    onProgress: (msg) => process.stderr.write(`fabric[codex]: ${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}\n`),
  });
}
