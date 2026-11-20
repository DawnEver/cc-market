// scripts/lib/agy.mjs — Antigravity CLI (`agy -p`) policy + child runner for fabric.
//
// Measured `agy 1.5.12` headless contracts:
//   1. Short single-line prompts (< 4000 chars, no newlines, no images):
//      `agy --output-format json --disable-slash-commands [--model M] [permFlags] -p <prompt>`
//      emits a single JSON object on stdout:
//        `{"conversation_id":"...","status":"SUCCESS","response":"...","usage":{...}}`
//   2. Long or multi-line prompts (safe on Windows where CreateProcess command line caps at 32 KB)
//      or prompts with images:
//      `agy --input-format stream-json --output-format stream-json --disable-slash-commands [--model M] [permFlags] -p ""`
//      reading one NDJSON message from stdin:
//        `{"event":"user","message":{"role":"user","content":"..."}}`
//      and emitting NDJSON lines (`init`, `step_update`, and final `{"event":"result","result":{...}}`).
//   3. Write policy:
//      - `!write` (default for task/review): `--mode plan --sandbox` (read-only plan mode + terminal sandbox).
//      - `write: true`: `--dangerously-skip-permissions` (headless auto-approve inside `cwd`).
//   4. Child env:
//      - `PROVIDER_ENV_KEYS` stripped so third-party Anthropic gateway env vars never leak into `agy`.
//      - `CC_CONFIG_AGY_SMOKE=1` + `CC_CONFIG_AGY_PRINT=1` set so global interactive hooks
//        (`agy-hook.mjs` bridge/notification/Stop gates) bypass cleanly and never stall a worker child.

import process from "node:process";
import { PROVIDER_ENV_KEYS } from "../../engine/providers.mjs";
import { ProviderError } from "../../engine/errors.mjs";
import { killTree, treeSpawnOptions } from "../../engine/kill-tree.mjs";
import { spawn as hiddenSpawn } from "../../shared/spawn.mjs";
import { findAgyBinary } from "../../engine/agy/discovery.mjs";

export const AGY_STDIN_THRESHOLD = 4000;

export function classifyAgyError(message) {
  const m = String(message || "").toLowerCase();
  if (/\b(not authenticated|unauthenticated|unauthorized|auth error|login|401|403)\b/.test(m)) return "auth";
  if (/\b(quota|exhausted|insufficient|credit|billing|402)\b/.test(m)) return "exhausted";
  if (/\b(rate[- ]?limit|too many requests|overloaded|429)\b/.test(m)) return "rate_limit";
  if (/\b(timed? out|deadline exceeded)\b/.test(m)) return "timeout";
  if (/\b(invalid model|unknown model|unsupported)\b/.test(m)) return "unsupported";
  return "failed";
}

export function buildAgyEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_PID;
  delete env.CODEX_THREAD_ID;
  env.CC_CONFIG_AGY_SMOKE = "1";
  env.CC_CONFIG_AGY_PRINT = "1";
  return env;
}

function buildAgyUserContent(prompt, images) {
  if (!images || images.length === 0) return prompt;
  const imageText = images
    .map((img) => img.path ? `[Image: ${img.path}]` : `data:${img.media_type || "image/png"};base64,${img.data}`)
    .join("\n");
  return `${prompt}\n\n[Attached images]\n${imageText}`;
}

/**
 * Parse stdout from either `--output-format json` (single JSON object) or
 * `--output-format stream-json` (NDJSON lines ending in `{"event":"result","result":{...}}`).
 */
export function parseAgyOutput(stdout, useStreamJson) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return { ok: false, error: "empty stdout from agy" };

  if (!useStreamJson) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === "object" && typeof obj.status === "string") {
        return { ok: true, result: obj };
      }
    } catch {
      // Fall through to NDJSON / line scan in case banners preceded the JSON object
    }
  }

  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let deltaAcc = "";
  let lastResult = null;
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (!msg || typeof msg !== "object") continue;
      if (msg.event === "step_update" && msg.step_update?.step_type === "agent_response" && typeof msg.step_update.text_delta === "string") {
        deltaAcc += msg.step_update.text_delta;
      } else if (msg.event === "result" && msg.result && typeof msg.result === "object") {
        lastResult = msg.result;
      } else if (typeof msg.status === "string" && ("response" in msg || "error" in msg)) {
        lastResult = msg;
      }
    } catch {}
  }

  if (lastResult) {
    if (!lastResult.response && deltaAcc) lastResult = { ...lastResult, response: deltaAcc };
    return { ok: true, result: lastResult };
  }
  return { ok: false, error: trimmed };
}

function armKillTimer(child, ms, onTimeout, kill) {
  return globalThis.setTimeout(() => {
    try { kill(child); } catch {}
    onTimeout();
  }, ms);
}

/**
 * Spawn a headless `agy -p` session and collect its structured output.
 */
export async function spawnAgyP(userPrompt, opts = {}) {
  const {
    systemPrompt,
    model,
    write = false,
    images = null,
    cwd,
    timeoutMs = 600000,
    signal,
    onText,
    agyPath,
    _spawn = hiddenSpawn,
    _bin,
    _killTree = killTree,
  } = opts;

  if (!userPrompt || !String(userPrompt).trim()) {
    throw new Error("spawnAgyP: prompt is required");
  }

  let bin = _bin;
  if (!bin) {
    try {
      bin = findAgyBinary(agyPath);
    } catch (e) {
      throw new ProviderError("unsupported", e.message);
    }
  }

  const combined = systemPrompt
    ? `[System instructions]\n${systemPrompt}\n\n${userPrompt}`
    : userPrompt;
  const fullContent = buildAgyUserContent(combined, images);
  const useStdin =
    fullContent.length > AGY_STDIN_THRESHOLD ||
    fullContent.includes("\n") ||
    Boolean(images && images.length > 0);

  const args = [];
  if (useStdin) {
    args.push("--input-format", "stream-json", "--output-format", "stream-json");
  } else {
    args.push("--output-format", "json");
  }

  if (model) args.push("--model", model);

  if (write) {
    args.push("--dangerously-skip-permissions", "--disable-slash-commands");
  } else {
    // Note: `agy` prints a warning if `--mode plan` is combined with `--disable-slash-commands`,
    // so read-only calls omit `--disable-slash-commands` and enforce `--mode plan --sandbox`.
    args.push("--mode", "plan", "--sandbox");
  }

  args.push("-p", useStdin ? "" : fullContent);

  const env = buildAgyEnv(process.env);

  const raw = await new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderError("failed", "spawnAgyP: request cancelled"));
      return;
    }

    let child;
    try {
      child = _spawn(bin, args, {
        cwd: cwd || process.cwd(),
        env,
        stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        ...treeSpawnOptions(),
      });
    } catch (e) {
      const kind = e?.code === "ENOENT" ? "unsupported" : "failed";
      reject(new ProviderError(kind, `agy spawn failed: ${e.message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (fn, val) => {
      if (!settled) {
        settled = true;
        cleanup();
        fn(val);
      }
    };
    const onAbort = () => {
      try { _killTree(child); } catch {}
      settle(reject, new ProviderError("failed", "spawnAgyP: request cancelled"));
    };
    const killTimer = armKillTimer(
      child,
      timeoutMs,
      () => settle(reject, new ProviderError("timeout", `agy -p: timeout after ${timeoutMs}ms`)),
      _killTree,
    );
    const cleanup = () => {
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    let lineBuffer = "";
    const emitDelta = (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg?.event === "step_update" && msg.step_update?.step_type === "agent_response" && msg.step_update.text_delta) {
          onText(msg.step_update.text_delta);
        }
      } catch {}
    };

    child.stdout?.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      if (onText && useStdin) {
        lineBuffer += s;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop();
        for (const l of lines.filter((x) => x.trim())) emitDelta(l);
      }
    });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      const kind = e?.code === "ENOENT" ? "unsupported" : "failed";
      settle(reject, new ProviderError(kind, `agy spawn failed: ${e.message}`));
    });
    child.on("close", (code) => {
      if (onText && useStdin && lineBuffer.trim()) emitDelta(lineBuffer.trim());
      settle(resolve, { code, stdout, stderr });
    });

    if (useStdin) {
      child.stdin?.write(JSON.stringify({ event: "user", message: { role: "user", content: fullContent } }) + "\n");
      child.stdin?.end();
    }
  });

  const parsed = parseAgyOutput(raw.stdout, useStdin);
  if (parsed.ok) {
    const res = parsed.result;
    if (res.status === "SUCCESS") {
      return {
        content: [{ type: "text", text: String(res.response ?? "").trim() }],
        usage: res.usage ?? null,
        _usage: res.usage ?? null,
        conversation_id: res.conversation_id ?? null,
      };
    }
    const detail = res.error || raw.stderr.trim() || `agy status ${res.status}`;
    throw new ProviderError(classifyAgyError(detail), `agy CLI failed: ${detail}`);
  }

  const errDetail = raw.stderr.trim() || parsed.error || `exited with code ${raw.code}`;
  throw new ProviderError(classifyAgyError(errDetail), `agy CLI exited ${raw.code}: ${errDetail}`);
}
