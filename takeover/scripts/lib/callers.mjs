// callers.mjs — model callers: Anthropic HTTP API (with retry + SSE streaming) and
// the Codex companion (app-server task). Re-exported via scripts/lib.mjs.
import process from "node:process";
import { setTimeout } from "node:timers/promises";

import { getConfigPath } from "./config.mjs";

function isRetryable(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export async function callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt, images = null, stream = false, signal = null) {
  if (!model) throw new Error(`No model resolved for provider. Set ANTHROPIC_DEFAULT_SONNET_MODEL in ${getConfigPath()}.`);

  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/messages`;

  let content;
  if (images && images.length > 0) {
    content = [{ type: "text", text: userPrompt }];
    for (const img of images) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.media_type || "image/png",
          data: img.data,
        },
      });
    }
  } else {
    content = userPrompt;
  }

  const body = {
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (stream) body.stream = true;

    // Use an AbortController with a clearable, unref'd timer rather than
    // AbortSignal.timeout(): the latter's timer is neither unref'd nor cleared
    // once the fetch settles, so it keeps the event loop alive for the full
    // timeout (5 min) after the request is already done. Note `setTimeout` is
    // imported from node:timers/promises at the top of this file, so reach for
    // the global timer explicitly here.
    let timeoutCtl, timeoutId;
    if (!signal) {
      timeoutCtl = new AbortController();
      timeoutId = globalThis.setTimeout(() => timeoutCtl.abort(new Error("Request timed out")), 300000);
      timeoutId.unref?.();
    }
    const fetchSignal = signal || timeoutCtl.signal;

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": providerConfig.token,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: fetchSignal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (signal?.aborted) throw new Error('Request cancelled');
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        process.stderr.write(`takeover: network error, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...\n`);
        await setTimeout(delay);
        continue;
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (res.ok) {
      if (stream && res.headers.get("content-type")?.includes("text/event-stream")) {
        try {
          return await parseSSEStream(res.body);
        } catch (streamErr) {
          process.stderr.write(`takeover: SSE streaming failed (${streamErr.message}), falling back to non-streaming...\n`);
          delete body.stream;
          continue;
        }
      }
      return res.json();
    }

    const errorText = await res.text();
    if (attempt < maxRetries && isRetryable(res.status)) {
      const delay = Math.pow(2, attempt) * 1000;
      process.stderr.write(`takeover: retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...\n`);
      await setTimeout(delay);
      continue;
    }

    throw new Error(`API error ${res.status}: ${errorText}`);
  }
}

async function parseSSEStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let accumulatedText = "";
  let usage = null;
  let stopReason = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    let currentEvent = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (currentEvent === "content_block_delta") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.delta?.type === "text_delta") {
              accumulatedText += parsed.delta.text;
              process.stderr.write(parsed.delta.text);
            }
          } catch {}
        } else if (currentEvent === "message_delta") {
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) usage = parsed.usage;
            if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
          } catch {}
        }
      }
      if (line === "") currentEvent = null;
    }
  }

  return { content: [{ type: "text", text: accumulatedText }], stop_reason: stopReason, usage };
}

export async function callCodexCompanion(userPrompt, systemPrompt, model, writeMode = false, images = null, client = null) {
  const { runCodexTask } = await import("../../shared/codex/task.mjs");
  return runCodexTask(userPrompt, systemPrompt, model, writeMode, process.cwd(), (msg) => {
    process.stderr.write(`mcp-takeover[codex]: ${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}\n`);
  }, images, client);
}
