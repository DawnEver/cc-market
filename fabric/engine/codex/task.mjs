import { CodexAppServerClient } from "./app-server.mjs";
import path from "node:path";
import { watchTurn } from "./turn.mjs";

// The turn's write permission, as the app-server enforces it (TurnStartParams.sandboxPolicy /
// approvalPolicy). write=false is the readOnly sandbox; write=true may write inside cwd only.
// approvalPolicy "never": no escalation prompt exists headless, so an escalation is denied.
export function turnPolicy(write, cwd) {
  return {
    sandboxPolicy: write ? { type: "workspaceWrite", writableRoots: [path.resolve(cwd)] } : { type: "readOnly" },
    approvalPolicy: "never",
  };
}

export async function runCodexTask(prompt, { systemPrompt, model, write = false, cwd, onProgress, images = null, client = null, timeoutMs = 600000 } = {}) {
  const ownClient = !client;
  if (ownClient) {
    client = new CodexAppServerClient({ timeout: timeoutMs });
    await client.start();
  } else {
    client.clearNotifications("thread/started");
    client.clearNotifications("item/completed");
  }

  const result = { text: "", threadId: null, turnId: null, usage: null };

  client.onNotification("thread/started", (params) => {
    result.threadId = params.thread?.id;
  });

  client.onNotification("item/completed", (params) => {
    const item = params.item || {};
    const text = extractItemText(item);
    if (text) {
      result.text += text;
      if (onProgress) onProgress(text);
    }
    if (item.usage && !result.usage) result.usage = item.usage;
  });

  const turn = watchTurn(client, { timeoutMs, label: "task" });
  try {
    const workDir = path.resolve(cwd || process.cwd());
    const threadResp = await client.send("thread/start", { cwd: workDir });
    const threadId = threadResp.thread?.id || threadResp.id;
    result.threadId ||= threadId;

    const input = [];
    if (systemPrompt) input.push({ type: "text", text: systemPrompt });
    input.push({ type: "text", text: prompt });

    // Append images as type=image items with data: URLs (codex v0.139+ protocol)
    if (images && images.length > 0) {
      for (const img of images) {
        const mime = img.media_type || "image/png";
        const dataUrl = `data:${mime};base64,${img.data}`;
        input.push({ type: "image", url: dataUrl });
      }
    }

    const turnParams = {
      threadId,
      input,
      cwd: workDir,
      ...turnPolicy(write, workDir),
    };
    if (model) turnParams.model = model;

    const started = await client.send("turn/start", turnParams);
    result.turnId = started?.turn?.id ?? null;
    const completed = await turn.done;
    result.turnId ||= completed.id ?? null;
  } finally {
    turn.dispose();
    client.clearNotifications("thread/started");
    client.clearNotifications("item/completed");
    if (ownClient) await client.stop();
  }

  return {
    content: [{ type: "text", text: result.text.trim() || "(turn completed with no text output)" }],
    threadId: result.threadId,
    turnId: result.turnId,
    _usage: result.usage ? {
      input_tokens: result.usage.input_tokens || result.usage.prompt_tokens || 0,
      output_tokens: result.usage.output_tokens || result.usage.completion_tokens || 0,
    } : null,
  };
}

export function extractItemText(item) {
  // The app-server echoes the turn's input back as a `userMessage` item/completed before the
  // real answer. Skip it — otherwise the caller's own prompt is prepended to every reply.
  if (item?.type === "userMessage") return "";
  if (item.text) return item.text;
  if (item.content) {
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content
        .filter((b) => b.type === "text" || b.type === "output_text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}
