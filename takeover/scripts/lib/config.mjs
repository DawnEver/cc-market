// config.mjs — provider config/env loading, model resolution, model listing.
// Re-exported via scripts/lib.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The plugin's scripts/ directory (this module lives in scripts/lib/). Kept pointing at
// scripts/ — not scripts/lib/ — so consumers like buildPrompt (join(SCRIPT_DIR, "..",
// "prompts")) resolve the plugin-root prompts/ dir exactly as before.
export const SCRIPT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const defaultConfigPath = path.join(os.homedir(), ".claude", "claude_env_settings.json");
export const getConfigPath = () => process.env.TAKEOVER_CONFIG_PATH || defaultConfigPath;

// ── Provider env keys (mirrors scripts/runtime/cc.js) ────────────────────────

export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
];

// ── Agent mode: spawn claude -p with provider env ────────────────────────────

export function loadProviderEnv(provider, configPath = getConfigPath()) {
  const env = { ...process.env };
  for (const key of PROVIDER_ENV_KEYS) delete env[key];

  if (provider === 'claude') return env; // OAuth/Pro subscription

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const profile = config[`env:${provider}`];
  if (!profile) {
    const available = Object.keys(config)
      .filter(k => k.startsWith('env:'))
      .map(k => k.slice(4))
      .join(', ');
    throw new Error(`Provider "${provider}" not found in ${configPath}. Available: ${available}`);
  }
  Object.assign(env, profile);
  return env;
}

// ── Provider config ──────────────────────────────────────────────────────────

const _configCache = new Map();

export function loadProviderConfig(provider, configPath = getConfigPath()) {
  if (provider === "codex") return { native: true, provider: "codex" };
  if (provider === "claude") return { native: true, provider: "claude" };

  const cached = _configCache.get(`${provider}:${configPath}`);
  if (cached && Date.now() - cached.ts < 60000) return cached.config;

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

  const result = { native: false, baseUrl, token, defaultSonnet, defaultOpus, defaultHaiku };
  _configCache.set(`${provider}:${configPath}`, { config: result, ts: Date.now() });
  return result;
}

export function clearConfigCache() { _configCache.clear(); }

// ── Model resolution ─────────────────────────────────────────────────────────

const TIER_MAP = { sonnet: 'defaultSonnet', opus: 'defaultOpus', haiku: 'defaultHaiku' };

export function resolveModel(providerConfig, requestedModel) {
  if (!requestedModel) return providerConfig.defaultSonnet;
  const tier = requestedModel.toLowerCase();
  const configKey = TIER_MAP[tier];
  if (configKey) return providerConfig[configKey] || providerConfig.defaultSonnet || requestedModel;
  return requestedModel;
}

// ── Model listing ────────────────────────────────────────────────────────────

export function listModels(configPath = getConfigPath()) {
  const lines = [];

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
