// callers.mjs — the codex companion caller. Re-exported via scripts/lib.mjs.
import process from "node:process";

// opts: {systemPrompt, model, write, images, client, cwd, timeoutMs} — see runCodexTask.
export async function callCodexCompanion(userPrompt, opts = {}) {
  const { runCodexTask } = await import("../../engine/codex/task.mjs");
  return runCodexTask(userPrompt, {
    ...opts,
    onProgress: (msg) => process.stderr.write(`fabric[codex]: ${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}\n`),
  });
}
