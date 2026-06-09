import { CodexAppServerClient } from "./app-server.mjs";

export async function runCodexTask(prompt, systemPrompt, model, write = false, cwd, onProgress) {
  const client = new CodexAppServerClient({ timeout: 600000 });
  await client.start();

  const result = { text: "", threadId: null, turnId: null, usage: null };

  const turnDone = new Promise((resolve) => {
    client.onNotification("turn/completed", (params) => {
      // Extract token usage from turn completion (Codex returns usage data)
      result.usage = params?.usage || null;
      resolve();
    });
  });

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
    // Capture usage from final item if available
    if (item.usage && !result.usage) result.usage = item.usage;
  });

  try {
    const threadResp = await client.send("thread/start", { cwd: cwd || process.cwd() });
    const threadId = threadResp.thread?.id || threadResp.id;

    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push({ role: "user", content: prompt });

    const turnParams = {
      threadId,
      messages,
      tools: write ? undefined : { disabled: true },
    };
    if (model) turnParams.model = model;

    const turn = await client.send("turn/start", turnParams);
    result.turnId = turn.id;

    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout waiting for turn completion")), 600000)
    );
    await Promise.race([turnDone, timeout]);
  } catch (err) {
    await client.stop();
    throw err;
  }

  await client.stop();
  return {
    content: [{ type: "text", text: result.text.trim() || "(no output)" }],
    threadId: result.threadId,
    turnId: result.turnId,
    _usage: result.usage ? {
      input_tokens: result.usage.input_tokens || result.usage.prompt_tokens || 0,
      output_tokens: result.usage.output_tokens || result.usage.completion_tokens || 0,
    } : null,
  };
}

function extractItemText(item) {
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

