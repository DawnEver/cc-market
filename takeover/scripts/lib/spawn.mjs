// spawn.mjs — takeover policy wrapper over the shared claude child engine.
// The engine (binary resolution, provider env, stream-json, images, timeouts)
// lives in shared/spawn-child.mjs; this file only shapes the MCP result and
// applies takeover's usage-extraction priority.
import process from "node:process";

import { spawnChild, resolveClaudeExe } from "../../shared/spawn-child.mjs";
import { extractUsageFromStderr } from "./trace.mjs";

export { resolveClaudeExe };

export async function spawnClaudeP(userPrompt, opts = {}) {
  const { provider, model, systemPrompt, images, configPath, signal } = opts;
  const label = provider || "claude";
  process.stderr.write(`mcp-takeover: spawning claude (provider=${label} model=${model || "default"})...\n`);

  const res = await spawnChild({
    provider: label,
    prompt: userPrompt,
    systemPrompt,
    images,
    model: model || undefined,
    configPath,
    signal,
    timeoutMs: 600000,
    onText: (t) => process.stderr.write(t),
  });

  if (res.code !== 0) throw new Error(`claude CLI (${label}) exited ${res.code}: ${res.stderr.trim()}`);
  const usage = extractUsageFromStderr(res.stderr) || res.usage;
  return { content: [{ type: "text", text: res.stdout.trim() }], _usage: usage };
}
