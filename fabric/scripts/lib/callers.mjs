// callers.mjs — takeover's codex companion caller. The raw Anthropic HTTP engine
// (retry + SSE) lives in shared/anthropic-http.mjs and is re-exported here so
// `./lib.mjs` import sites stay stable.
import process from "node:process";

export { callAnthropicAPI } from "../../shared/anthropic-http.mjs";

export async function callCodexCompanion(userPrompt, systemPrompt, model, writeMode = false, images = null, client = null) {
  const { runCodexTask } = await import("../../shared/codex/task.mjs");
  return runCodexTask(userPrompt, systemPrompt, model, writeMode, process.cwd(), (msg) => {
    process.stderr.write(`fabric[codex]: ${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}\n`);
  }, images, client);
}
