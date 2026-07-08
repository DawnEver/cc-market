// spawn.mjs — takeover policy wrapper over the shared claude child engine.
// The engine (binary resolution, provider env, stream-json, images, timeouts)
// lives in engine/spawn-child.mjs; this file only shapes the MCP result and
// applies takeover's usage-extraction priority. The wrapper consumes/normalizes
// provider (→ label, default "claude"), model, systemPrompt, images, signal, and
// timeoutMs (default 600000); all other options pass through to spawnChild untouched
// via rest-spread. Note: onText is always overridden by the stderr streamer, and
// prompt is always the userPrompt argument — callers cannot set either.
//
// Intentional behavior: for provider=claude the shared engine builds the child env via
// buildChildEnv → loadProviderEnv('claude'), which strips provider env keys
// (ANTHROPIC_BASE_URL, auth tokens, etc.) from the inherited environment. The claude
// child therefore always direct-connects with its own OAuth instead of inheriting a
// gateway/proxy env from the parent session.
import process from "node:process";

import { spawnChild, resolveClaudeExe } from "../../engine/spawn-child.mjs";
import { extractUsageFromStderr } from "./trace.mjs";

export { resolveClaudeExe };

export async function spawnClaudeP(userPrompt, opts = {}) {
  const {
    provider, model, systemPrompt, images, signal,
    timeoutMs = 600000, ...rest
  } = opts;
  const label = provider || "claude";
  process.stderr.write(`fabric: spawning claude (provider=${label} model=${model || "default"})...\n`);

  const res = await spawnChild({
    ...rest,
    provider: label,
    prompt: userPrompt,
    systemPrompt,
    images,
    model: model || undefined,
    signal,
    timeoutMs,
    onText: (t) => process.stderr.write(t),
  });

  if (res.code !== 0) throw new Error(`claude CLI (${label}) exited ${res.code}: ${res.stderr.trim()}`);
  const usage = extractUsageFromStderr(res.stderr) || res.usage;
  return { content: [{ type: "text", text: res.stdout.trim() }], _usage: usage };
}
