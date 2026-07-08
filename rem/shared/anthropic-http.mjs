// shared/anthropic-http.mjs — raw Anthropic-compatible HTTP engine (retry + SSE).
// A single-turn /messages call with no CC harness and no tools: the light path for
// direct-connect API providers (deepseek etc.). Promoted from takeover's callers.mjs;
// the CC-harness path is shared/spawn-child.mjs, the codex path shared/codex/.
import process from "node:process";
import { setTimeout } from "node:timers/promises";

import { getConfigPath } from "./providers.mjs";

function isRetryable(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

// Build the user-message content: a plain string, or text + image blocks.
// Shared with spawn-child.mjs (stream-json stdin payload uses the same shape).
export function buildUserContent(prompt, images) {
  if (!images || images.length === 0) return prompt;
  const content = [{ type: "text", text: prompt }];
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
  return content;
}

export async function callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt, images = null, stream = false, signal = null, { sseIdleTimeoutMs = 300000 } = {}) {
  if (!model) throw new Error(`No model resolved for provider. Set ANTHROPIC_DEFAULT_SONNET_MODEL in ${getConfigPath()}.`);

  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/messages`;

  const body = {
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content: buildUserContent(userPrompt, images) }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const maxRetries = 2;
  let useStream = stream; // mutable: cleared by the SSE fallback so the retry really is non-streaming
  let lastError = null; // last retryable API error, surfaced by the exhaustion backstop

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (useStream) body.stream = true;
    else delete body.stream;

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
        process.stderr.write(`anthropic-http: network error, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...\n`);
        await setTimeout(delay);
        continue;
      }
      throw err;
    }
    clearTimeout(timeoutId);

    if (res.ok) {
      if (useStream && res.headers.get("content-type")?.includes("text/event-stream")) {
        try {
          return await parseSSEStream(res.body, { idleTimeoutMs: sseIdleTimeoutMs, signal });
        } catch (streamErr) {
          if (signal?.aborted) throw new Error("Request cancelled");
          process.stderr.write(`anthropic-http: SSE streaming failed (${streamErr.message}), falling back to non-streaming...\n`);
          // The streaming→non-streaming downgrade must not consume an attempt:
          // on the final attempt a plain `continue` would exit the loop and
          // resolve undefined. Safe from looping — useStream is now false, so
          // this branch can't be re-entered.
          useStream = false;
          attempt--;
          continue;
        }
      }
      return res.json();
    }

    const errorText = await res.text();
    if (!isRetryable(res.status)) throw new Error(`API error ${res.status}: ${errorText}`);
    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000;
      process.stderr.write(`anthropic-http: retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...\n`);
      await setTimeout(delay);
      continue;
    }
    lastError = new Error(`API error ${res.status}: ${errorText}`);
  }

  // Backstop: no path may fall out of the loop and resolve undefined.
  throw new Error(`anthropic-http: retries exhausted${lastError ? `: ${lastError.message}` : ""}`);
}

// Read an SSE body with an idle watchdog: each reader.read() races an unref'd
// timer (reset per chunk) so a server that stalls mid-stream can't hang the
// call forever, plus an optional caller abort signal. On stall/abort the
// reader is cancelled and a descriptive error thrown — callAnthropicAPI's
// catch turns a stall into the non-streaming retry.
export async function parseSSEStream(body, { idleTimeoutMs = 300000, signal = null } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let accumulatedText = "";
  let usage = null;
  let stopReason = null;
  let buffer = "";

  // Race a read against the idle timer (and the abort signal, if given).
  const guardedRead = () => new Promise((resolve, reject) => {
    let timerId, onAbort;
    const cleanup = () => {
      clearTimeout(timerId);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    };
    timerId = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`SSE stream stalled after ${idleTimeoutMs}ms`));
    }, idleTimeoutMs);
    timerId.unref?.();
    if (signal) {
      onAbort = () => { cleanup(); reject(new Error("Request aborted during SSE stream")); };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    reader.read().then(
      (result) => { cleanup(); resolve(result); },
      (err) => { cleanup(); reject(err); }
    );
  });

  while (true) {
    let done, value;
    try {
      ({ done, value } = await guardedRead());
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    }
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
