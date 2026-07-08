// shared/providers.mjs — canonical multi-provider routing (L0 of the agent fabric).
// Bundled into every plugin's shared/ by the pre-push hook. Single source of truth for
// reading ~/.claude/claude_env_settings.json and resolving a provider's real upstream,
// auth, and model aliases. Promoted from takeover/scripts/lib/config.mjs so the fabric
// plugin and takeover share one implementation instead of two.
//
// The config file keys providers as `env:<name>` (e.g. env:deepseek). A provider block
// is either vanilla (ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN) or Foundry
// (CLAUDE_CODE_USE_FOUNDRY=1 + ANTHROPIC_FOUNDRY_*). resolveUpstream normalizes both.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultConfigPath = path.join(os.homedir(), ".claude", "claude_env_settings.json");
// Generic env override; TAKEOVER_CONFIG_PATH kept for backward-compat with takeover.
export const getConfigPath = () =>
  process.env.CC_MARKET_CONFIG_PATH || process.env.TAKEOVER_CONFIG_PATH || defaultConfigPath;

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

/** Read the raw registry, or throw a helpful error if absent. */
function readRegistry(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}\nCreate it with your provider settings.`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

/**
 * Full child-process env for a provider: strips all provider keys from the current env,
 * then overlays the provider block. `claude` returns the bare env (native OAuth). This is
 * the "normal mode" env — includes Foundry vars, so the child direct-connects to DeepSeek.
 */
export function loadProviderEnv(provider, configPath = getConfigPath()) {
  const env = { ...process.env };
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  if (provider === 'claude') return env; // OAuth/Pro subscription

  const config = readRegistry(configPath);
  const profile = config[`env:${provider}`];
  if (!profile) {
    const available = Object.keys(config).filter(k => k.startsWith('env:')).map(k => k.slice(4)).join(', ');
    throw new Error(`Provider "${provider}" not found in ${configPath}. Available: ${available}`);
  }
  Object.assign(env, profile);
  return env;
}

const _configCache = new Map();

/**
 * Normalized provider config: `{ native, baseUrl, token, defaultSonnet/Opus/Haiku }`.
 * Collapses the vanilla-vs-Foundry distinction into one shape — the observe proxy and
 * takeover both consume this. codex/claude are `native` (no HTTP upstream).
 */
export function loadProviderConfig(provider, configPath = getConfigPath()) {
  if (provider === "codex") return { native: true, provider: "codex" };
  if (provider === "claude") return { native: true, provider: "claude" };

  const cached = _configCache.get(`${provider}:${configPath}`);
  if (cached && Date.now() - cached.ts < 60000) return cached.config;

  const config = readRegistry(configPath);
  const env = config[`env:${provider}`];
  if (!env) throw new Error(`Provider "${provider}" not found in ${configPath}. Add an "env:${provider}" block.`);

  const useFoundry = env.CLAUDE_CODE_USE_FOUNDRY === "1" || env.CLAUDE_CODE_USE_FOUNDRY === 1;
  const baseUrl = useFoundry ? env.ANTHROPIC_FOUNDRY_BASE_URL : env.ANTHROPIC_BASE_URL;
  const token = useFoundry ? env.ANTHROPIC_FOUNDRY_API_KEY : env.ANTHROPIC_AUTH_TOKEN;
  if (!baseUrl) throw new Error(`Provider "${provider}" is missing ${useFoundry ? "ANTHROPIC_FOUNDRY_BASE_URL" : "ANTHROPIC_BASE_URL"} in ${configPath}.`);
  if (!token)   throw new Error(`Provider "${provider}" is missing ${useFoundry ? "ANTHROPIC_FOUNDRY_API_KEY" : "ANTHROPIC_AUTH_TOKEN"} in ${configPath}.`);

  const result = {
    native: false, baseUrl, token,
    defaultSonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    defaultOpus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    defaultHaiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  };
  _configCache.set(`${provider}:${configPath}`, { config: result, ts: Date.now() });
  return result;
}

export function clearConfigCache() { _configCache.clear(); }

const TIER_MAP = { sonnet: 'defaultSonnet', opus: 'defaultOpus', haiku: 'defaultHaiku' };

/** Resolve a bare tier word ('opus'/'sonnet'/'haiku') to the provider's model id. */
export function resolveModel(providerConfig, requestedModel) {
  if (!requestedModel) return providerConfig.defaultSonnet;
  const configKey = TIER_MAP[requestedModel.toLowerCase()];
  if (configKey) return providerConfig[configKey] || providerConfig.defaultSonnet || requestedModel;
  return requestedModel;
}

/**
 * Resolve a FULL Claude model id (e.g. "claude-haiku-4-5-20251001") to the provider's id
 * by tier substring. This is what the observe proxy needs: the child sends a real Claude
 * model id (it thinks it's talking to Anthropic), and the proxy must remap it in-body.
 * Falls back to the opus-tier default, then the original id.
 */
export function resolveModelFromId(providerConfig, fullId) {
  if (typeof fullId !== 'string') return fullId;
  const m = fullId.toLowerCase();
  if (m.includes('haiku') && providerConfig.defaultHaiku) return providerConfig.defaultHaiku;
  if (m.includes('sonnet') && providerConfig.defaultSonnet) return providerConfig.defaultSonnet;
  if (m.includes('opus') && providerConfig.defaultOpus) return providerConfig.defaultOpus;
  return providerConfig.defaultOpus || providerConfig.defaultSonnet || fullId;
}

/**
 * Everything the observe proxy needs to reach a provider:
 * `{ baseUrl, token, resolveModel: (fullId) => upstreamId }`.
 * Throws for native providers (codex/claude) — they don't go through the HTTP proxy.
 */
export function resolveUpstream(provider, configPath = getConfigPath()) {
  const cfg = loadProviderConfig(provider, configPath);
  if (cfg.native) throw new Error(`Provider "${provider}" is native (${provider}) — not routable through the observe proxy.`);
  return {
    baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    token: cfg.token,
    resolveModel: (fullId) => resolveModelFromId(cfg, fullId),
  };
}

export function listModels(configPath = getConfigPath()) {
  const lines = [
    "claude   — Native Claude CLI (OAuth/Pro subscription)",
    "codex    — OpenAI Codex (via codex app-server; supports --review, --image, --write)",
  ];
  if (!fs.existsSync(configPath)) return [...lines, "", `Config file not found at ${configPath}.`].join("\n");

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const apiProviders = Object.keys(config)
    .filter((k) => k.startsWith("env:") && (config[k].ANTHROPIC_BASE_URL || config[k].ANTHROPIC_FOUNDRY_BASE_URL))
    .map((k) => k.slice(4));
  if (apiProviders.length === 0) return [...lines, "", "No API-based providers configured."].join("\n");

  lines.push("");
  for (const name of apiProviders) {
    const env = config[`env:${name}`];
    const models = [];
    if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) models.push(`haiku=${env.ANTHROPIC_DEFAULT_HAIKU_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) models.push(`sonnet=${env.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) models.push(`opus=${env.ANTHROPIC_DEFAULT_OPUS_MODEL}`);
    const baseUrl = env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_BASE_URL || "?";
    lines.push(`${name.padEnd(8)} → ${baseUrl}  [${models.length ? models.join(", ") : "no defaults set"}]`);
  }
  return lines.join("\n");
}
