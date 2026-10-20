import { CodexAppServerClient } from "../../engine/codex/app-server.mjs";
import { watchTurn } from "../../engine/codex/turn.mjs";
import { extractItemText } from "../../engine/codex/task.mjs";
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

// review/start (app-server v2) takes {threadId, target, delivery} — no model, and the
// `custom` target has ONE field, `instructions`; the model goes on thread/start and the
// diff inside the instructions. The verdict arrives as an `exitedReviewMode` item's
// `review` text; agentMessage text is the fallback.
export async function runCodexReview(diff, { model, context, cwd, client = null, timeoutMs = 600000 } = {}) {
  const ownClient = !client;
  if (ownClient) {
    client = new CodexAppServerClient({ timeout: timeoutMs });
    await client.start();
  } else {
    client.clearNotifications("item/completed");
  }

  const systemPrompt = loadReviewPrompt();
  let reviewInput = diff || "";
  if (context) reviewInput += `

## Additional Context
${context}`;

  let review = "";
  let messages = "";
  let resultUsage = null;

  client.onNotification("item/completed", (params) => {
    const item = params.item || {};
    if (item.usage && !resultUsage) resultUsage = item.usage;
    if (item.type === "exitedReviewMode") review += item.review || "";
    else if (item.type !== "enteredReviewMode") messages += extractItemText(item);
  });

  const turn = watchTurn(client, { timeoutMs, label: "review" });
  try {
    const threadParams = { cwd: cwd || process.cwd() };
    if (model) threadParams.model = model;
    const threadResp = await client.send("thread/start", threadParams);
    const threadId = threadResp.thread?.id || threadResp.id;

    const target = reviewInput
      ? { type: "custom", instructions: `${systemPrompt}

## Change under review
${reviewInput}` }
      : { type: "uncommittedChanges" };
    await client.send("review/start", { threadId, target });
    await turn.done;
  } finally {
    turn.dispose();
    client.clearNotifications("item/completed");
    if (ownClient) await client.stop();
  }

  const text = (review || messages).trim();
  return {
    content: [{ type: "text", text: text || "(review completed with no findings)" }],
    _usage: resultUsage ? {
      input_tokens: resultUsage.input_tokens || resultUsage.prompt_tokens || 0,
      output_tokens: resultUsage.output_tokens || resultUsage.completion_tokens || 0,
    } : null,
  };
}
