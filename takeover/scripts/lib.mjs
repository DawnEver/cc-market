import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const defaultConfigPath = path.join(os.homedir(), ".claude", "claude_env_settings.json");
export const CONFIG_PATH = process.env.TAKEOVER_CONFIG_PATH || defaultConfigPath;

// ── Provider config ──────────────────────────────────────────────────────────

export function loadProviderConfig(provider, configPath = CONFIG_PATH) {
  if (provider === "codex") return { native: true, provider: "codex" };
  if (provider === "claude") return { native: true, provider: "claude" };

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
      `Create it with your provider settings.`
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const envKey = `env:${provider}`;
  const env = config[envKey];
  if (!env) {
    throw new Error(
      `Provider "${provider}" not found in ${configPath}. ` +
      `Add an "env:${provider}" block.`
    );
  }

  const useFoundry = env.CLAUDE_CODE_USE_FOUNDRY === "1" || env.CLAUDE_CODE_USE_FOUNDRY === 1;
  const baseUrl = useFoundry ? env.ANTHROPIC_FOUNDRY_BASE_URL : env.ANTHROPIC_BASE_URL;
  const token = useFoundry ? env.ANTHROPIC_FOUNDRY_API_KEY : env.ANTHROPIC_AUTH_TOKEN;
  const defaultSonnet = env.ANTHROPIC_DEFAULT_SONNET_MODEL;
  const defaultOpus = env.ANTHROPIC_DEFAULT_OPUS_MODEL;
  const defaultHaiku = env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
  if (!baseUrl) throw new Error(`Provider "${provider}" is missing ${useFoundry ? "ANTHROPIC_FOUNDRY_BASE_URL" : "ANTHROPIC_BASE_URL"} in ${configPath}.`);
  if (!token)   throw new Error(`Provider "${provider}" is missing ${useFoundry ? "ANTHROPIC_FOUNDRY_API_KEY" : "ANTHROPIC_AUTH_TOKEN"} in ${configPath}.`);

  return { native: false, baseUrl, token, defaultSonnet, defaultOpus, defaultHaiku };
}

// ── Model resolution ─────────────────────────────────────────────────────────

// Map logical tier names to provider-specific model names.
// This prevents passing "sonnet"/"opus"/"haiku" literally to providers like
// DeepSeek that only accept their own model name strings (e.g. deepseek-v4-flash).
const TIER_MAP = { sonnet: 'defaultSonnet', opus: 'defaultOpus', haiku: 'defaultHaiku' };

export function resolveModel(providerConfig, requestedModel) {
  if (!requestedModel) return providerConfig.defaultSonnet;
  const tier = requestedModel.toLowerCase();
  const configKey = TIER_MAP[tier];
  if (configKey) return providerConfig[configKey] || providerConfig.defaultSonnet || requestedModel;
  return requestedModel;
}

// ── Command block parsing ──────────────────────────────────────────────────────

/**
 * Parse a <command> block from userPrompt for --provider and --model flags.
 * The takeover agent embeds the raw user request in a <command> block so the
 * MCP server can parse flags deterministically — no LLM parsing needed.
 *
 * Returns { flags: { provider?, model? }, cleanPrompt: string }.
 * cleanPrompt has the <command> block stripped.
 */
export function parseCommandBlock(prompt) {
  if (prompt == null) return { flags: {}, cleanPrompt: prompt || "" };
  const re = /^\s*<command>\s*\n?(.*?)\n?\s*<\/command>\s*\n?/s;
  const match = prompt.match(re);
  if (!match) return { flags: {}, cleanPrompt: prompt };

  const cmdText = match[1].trim();
  const flags = {};

  const providerMatch = cmdText.match(/--provider\s+(\S+)/);
  if (providerMatch) flags.provider = providerMatch[1];

  const modelMatch = cmdText.match(/--model\s+(\S+)/);
  if (modelMatch) flags.model = modelMatch[1];

  // Mode flags — review is adversarial by default
  if (cmdText.match(/--review/)) flags.mode = "review";
  if (cmdText.match(/--image-edit/)) flags.mode = "image-edit";
  else if (cmdText.match(/--image/)) flags.mode = "image-generate";

  const cleanPrompt = prompt.replace(re, "");
  return { flags, cleanPrompt };
}

// ── Prompt building ──────────────────────────────────────────────────────────

export function buildPrompt(subcommand, userPrompt) {
  const promptsDir = path.join(SCRIPT_DIR, "..", "prompts");
  let systemPrompt = "";
  const templateFile = path.join(promptsDir, `${subcommand}.md`);
  if (fs.existsSync(templateFile)) {
    systemPrompt = fs.readFileSync(templateFile, "utf8").trim();
  }
  return { systemPrompt, userPrompt: userPrompt.trim() };
}

// ── Codex integration ────────────────────────────────────────────────────────

export { findCodexBinary, checkCodexStatus } from "./codex/discovery.mjs";

// ── Text extraction ──────────────────────────────────────────────────────────

export function extractText(data) {
  const content = data.content || [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text && content.length > 0) {
    const types = [...new Set(content.map((b) => b.type))].join(", ");
    process.stderr.write(`takeover: warning — response contained no text blocks (got: ${types})\n`);
  }
  return text;
}

// ── Model listing ────────────────────────────────────────────────────────────

export function listModels(configPath = CONFIG_PATH) {
  const lines = [];

  // Native providers (no config needed)
  lines.push("claude   — Native Claude CLI (OAuth/Pro subscription)");
  lines.push("codex    — OpenAI Codex (via codex app-server; supports --review, --image, --write)");

  if (!fs.existsSync(configPath)) {
    lines.push("");
    lines.push(`Config file not found at ${configPath}.`);
    return lines.join("\n");
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const apiProviders = Object.keys(config)
    .filter((k) => k.startsWith("env:") && (config[k].ANTHROPIC_BASE_URL || config[k].ANTHROPIC_FOUNDRY_BASE_URL))
    .map((k) => k.slice(4));

  if (apiProviders.length === 0) {
    lines.push("");
    lines.push("No API-based providers configured.");
    return lines.join("\n");
  }

  lines.push("");
  for (const name of apiProviders) {
    const env = config[`env:${name}`];
    const models = [];
    if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) models.push(`haiku=${env.ANTHROPIC_DEFAULT_HAIKU_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) models.push(`sonnet=${env.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) models.push(`opus=${env.ANTHROPIC_DEFAULT_OPUS_MODEL}`);
    const baseUrl = env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_BASE_URL || "?";
    const modelInfo = models.length > 0 ? models.join(", ") : "no defaults set";
    lines.push(`${name.padEnd(8)} → ${baseUrl}  [${modelInfo}]`);
  }

  return lines.join("\n");
}

// ── Callers ──────────────────────────────────────────────────────────────────

function isRetryable(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Call an Anthropic-compatible Messages API with retry on transient errors.
 */
export async function callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt) {
  if (!model) throw new Error(`No model resolved for provider. Set ANTHROPIC_DEFAULT_SONNET_MODEL in ${CONFIG_PATH}.`);

  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/messages`;
  const body = {
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
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
        signal: AbortSignal.timeout(300000),
      });
    } catch (err) {
      // Network error or timeout — retry if attempts remain
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        process.stderr.write(`takeover: network error, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...\n`);
        await setTimeout(delay);
        continue;
      }
      throw err;
    }

    if (res.ok) return res.json();

    // HTTP error — only retry transient status codes
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

/**
 * Call Codex via app-server JSON-RPC. Prompt is sent in the turn/start message body.
 * Delegates to scripts/codex/task.mjs which spawns `codex app-server` directly.
 */
export async function callCodexCompanion(userPrompt, systemPrompt, model, writeMode = false) {
  const { runCodexTask } = await import("./codex/task.mjs");
  return runCodexTask(userPrompt, systemPrompt, model, writeMode, process.cwd(), (msg) => {
    process.stderr.write(`mcp-takeover[codex]: ${msg.slice(0, 200)}${msg.length > 200 ? "..." : ""}\n`);
  });
}

/**
 * Call native Claude CLI via `claude -p`.
 */
export function callNativeClaude(userPrompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
    const child = spawn("claude", ["-p", fullPrompt], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      shell: process.platform === "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ content: [{ type: "text", text: stdout.trim() }] });
      else reject(new Error(`claude CLI exited ${code}: ${stderr.trim()}`));
    });
  });
}
