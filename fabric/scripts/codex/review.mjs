import { CodexAppServerClient } from "../../engine/codex/app-server.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts");

function loadReviewPrompt() {
  const p = path.join(PROMPTS_DIR, "review.md");
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  return `You are Codex performing an adversarial code review. Your job is to break confidence in the change, not to validate it.

Default to skepticism. Assume the change can fail in subtle, high-cost, or user-visible ways.

Attack surface priorities:
- Auth/permissions
- Data loss/corruption
- Rollback safety, retries, idempotency
- Race conditions, stale state
- Null/timeout/degraded behavior
- Version skew, schema drift
- Observability gaps

Report only material findings. Do not include style feedback, naming feedback, or speculative concerns.

For each finding include: severity (critical/high/medium/low), title, description, file path, and recommendation. Be concrete — cite specific lines where possible.`;
}

export async function runCodexReview(diff, model, context, cwd, client = null) {
  const ownClient = !client;
  if (ownClient) {
    client = new CodexAppServerClient({ timeout: 600000 });
    await client.start();
  } else {
    client.clearNotifications("turn/completed");
    client.clearNotifications("item/completed");
  }

  const systemPrompt = loadReviewPrompt();
  let reviewInput = diff || "";

  if (context) reviewInput += `\n\n## Additional Context\n${context}`;

  let resultText = "";
  let resultUsage = null;

  client.onNotification("item/completed", (params) => {
    const item = params.item || {};
    if (item.usage && !resultUsage) resultUsage = item.usage;
    if (item.type === "userMessage") return; // skip the app-server's input echo
    if (item.text) resultText += item.text;
    else if (item.content) {
      if (typeof item.content === "string") resultText += item.content;
      else if (Array.isArray(item.content)) {
        resultText += item.content
          .filter((b) => b.type === "text" || b.type === "output_text")
          .map((b) => b.text).join("\n");
      }
    }
  });

  const reviewDone = new Promise((resolve) => {
    client.onNotification("turn/completed", (params) => {
      if (params?.usage && !resultUsage) resultUsage = params.usage;
      resolve();
    });
  });

  try {
    // Start a thread first — review/start requires threadId
    const threadResp = await client.send("thread/start", { cwd: cwd || process.cwd() });
    const threadId = threadResp.thread?.id || threadResp.id;

    const reviewParams = {
      threadId,
      target: reviewInput
        ? { type: "custom", diff: reviewInput, instructions: systemPrompt }
        : { type: "uncommittedChanges", instructions: systemPrompt },
    };
    if (model) reviewParams.model = model;

    await client.send("review/start", reviewParams);

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for review completion")), 600000)
    );
    await Promise.race([reviewDone, timeout]);
  } catch (err) {
    client.clearNotifications("turn/completed");
    client.clearNotifications("item/completed");
    if (ownClient) await client.stop();
    throw err;
  }

  client.clearNotifications("turn/completed");
  client.clearNotifications("item/completed");
  if (ownClient) await client.stop();

  return {
    content: [{ type: "text", text: resultText.trim() || "(no findings — review may have completed without text output)" }],
    _usage: resultUsage ? {
      input_tokens: resultUsage.input_tokens || resultUsage.prompt_tokens || 0,
      output_tokens: resultUsage.output_tokens || resultUsage.completion_tokens || 0,
    } : null,
  };
}
