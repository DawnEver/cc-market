// engine/providers.mjs — canonical multi-provider routing (L0 of the agent fabric).
// Lives in fabric/engine/ (NOT in cc-market/shared/) — fabric-owned canonical source.
// Only cc-market/shared/*.mjs is bundled into every plugin by the pre-push hook; this
// module stays fabric-only since the takeover merge. Single source of truth for reading
// ~/.claude/claude_env_settings.json and resolving a provider's real upstream, auth, and
// model aliases. Promoted from takeover/scripts/lib/config.mjs so the fabric plugin and
// takeover share one implementation instead of two.
//
// The config file declares providers as `providers.<name>` blocks (one per upstream). Each
// block has `url` + per-host fields: `claudeApiKeyEnv`/`claudePath`/`claudeModel`/
// `claudeExtras` (Anthropic-compatible side) and `codexApiKeyEnv`/`codexPath`/`codexModel`
// (codex side, used by the `codex` provider only). The `apiKey` value is sourced from
// the machine-local overlay (~/.claude/claude_env_settings.local.json) and projected into
// the named env var when spawning a child.
//
// See the root repo's `docs/providers.md` for the full schema; this module
// just reads it. The `fabric/migrations/migrate.mjs` one-shot converts pre-2026-08-25
// `env:<name>` local files to the new shape on first load.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const defaultConfigPath = path.join(os.homedir(), ".claude", "claude_env_settings.json");
// Generic env override; TAKEOVER_CONFIG_PATH kept for backward-compat with takeover.
export const getConfigPath = () =>
  process.env.CC_MARKET_CONFIG_PATH || process.env.TAKEOVER_CONFIG_PATH || defaultConfigPath;

// Env vars that any provider may inject; stripped from the parent env before projection
// so the merged result is the only source of these values. (No CLAUDE_CODE_USE_FOUNDRY
// / ANTHROPIC_FOUNDRY_* — Foundry mode was retired; see fabric's deepMerge cleanup.)
export const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
];

// Override-wins deep merge for the machine-local secrets overlay: plain objects recurse
// key-by-key; scalars/arrays are replaced wholesale by the override. The local file mirrors
// the registry shape, so this preserves shared base URLs / model pins while swapping keys.
function deepMerge(base, override) {
  const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    out[key] = isPlain(value) && isPlain(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/**
 * Read the raw registry (shared + machine-local overlay), or throw a helpful error.
 *
 * Secrets are machine-local: the config file rides the OneDrive-synced repo, so it must
 * NOT carry API keys. Each machine keeps its own in `claude_env_settings.local.json` next
 * to it (`~/.claude/...` — a REAL per-machine dir; setup.js only junctions specific
 * children into the repo, so this file never syncs). It is deep-merged over the shared
 * file here, so every loadProviderEnv/loadProviderConfig consumer sees the merged result.
 */
export function readRegistry(configPath) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}\nCreate it with your provider settings.`);
  }
  const shared = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const localPath = path.join(path.dirname(configPath), "claude_env_settings.local.json");
  if (fs.existsSync(localPath)) {
    return deepMerge(shared, JSON.parse(fs.readFileSync(localPath, "utf8")));
  }
  return shared;
}

/**
 * Project a single `providers.<name>` block into the per-child env. Returns
 * `{ env, error }` — error is set if the block is missing required fields.
 */
function projectProviderEnv(profile) {
  if (!profile.claudeApiKeyEnv) {
    return { env: null, error: 'claudeApiKeyEnv is required' };
  }
  if (!profile.apiKey) {
    return { env: null, error: `apiKey is required (add it to ~/.claude/claude_env_settings.local.json under providers.${profile._name || '?'}.apiKey)` };
  }
  const env = {};
  env[profile.claudeApiKeyEnv] = profile.apiKey;
  if (profile.url) env.ANTHROPIC_BASE_URL = profile.url + (profile.claudePath ?? '');
  if (profile.claudeModel) env.ANTHROPIC_MODEL = profile.claudeModel;
  if (profile.claudeExtras && typeof profile.claudeExtras === 'object') {
    for (const [k, v] of Object.entries(profile.claudeExtras)) {
      if (typeof v === 'string') env[k] = v;
    }
  }
  return { env, error: null };
}

/**
 * Full child-process env for a provider: strips provider keys, overlays the
 * provider's projected env. `claude` and `codex` return the bare env (native —
 * they use their own auth flow). Throws if the provider block is missing or
 * misconfigured.
 */
export function loadProviderEnv(provider, configPath = getConfigPath()) {
  const env = { ...process.env };
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  if (provider === 'claude' || provider === 'codex') return env;

  const config = readRegistry(configPath);
  const profile = config.providers?.[provider];
  if (!profile) {
    const available = Object.keys(config.providers || {}).join(', ');
    throw new Error(`Provider "${provider}" not found in ${configPath}. Available: ${available}`);
  }
  const { env: providerEnv, error } = projectProviderEnv({ ...profile, _name: provider });
  if (error) throw new Error(`Provider "${provider}" is misconfigured: ${error}`);
  Object.assign(env, providerEnv);
  return env;
}

const _configCache = new Map();

/**
 * Normalized provider config: `{ native, baseUrl, token, tokenStyle,
 * defaultSonnet/Opus/Haiku/Fable, subagent }`. Collapses the per-provider
 * shape into one form the observe proxy and takeover both consume. codex/claude
 * are `native` (no HTTP upstream).
 */
export function loadProviderConfig(provider, configPath = getConfigPath()) {
  if (provider === "codex" || provider === "claude") return { native: true, provider };

  const cached = _configCache.get(`${provider}:${configPath}`);
  if (cached && Date.now() - cached.ts < 60000) return cached.config;

  const config = readRegistry(configPath);
  const profile = config.providers?.[provider];
  if (!profile) {
    const available = Object.keys(config.providers || {}).join(', ');
    throw new Error(`Provider "${provider}" not found in ${configPath}. Available: ${available}`);
  }

  const baseUrl = profile.url ? profile.url + (profile.claudePath ?? '') : '';
  // Direct Anthropic-compatible providers may key their token as either
  // ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY — accept both, but remember which
  // var supplied it: the two map to different request headers, exactly as Claude
  // Code itself sends them (AUTH_TOKEN → `Authorization: Bearer`, API_KEY →
  // `x-api-key`). tokenStyle records that so the proxy/raw-HTTP path can emit
  // the matching header instead of guessing.
  const tokenStyle = profile.claudeApiKeyEnv === 'ANTHROPIC_AUTH_TOKEN' ? 'bearer' : 'x-api-key';
  if (!baseUrl) throw new Error(`Provider "${provider}" is missing url/claudePath in ${configPath}.`);
  if (!profile.apiKey) throw new Error(`Provider "${provider}" is missing apiKey in ~/.claude/claude_env_settings.local.json (under providers.${provider}).`);

  const result = {
    native: false, baseUrl, token: profile.apiKey, tokenStyle,
    defaultSonnet: profile.claudeExtras?.ANTHROPIC_DEFAULT_SONNET_MODEL,
    defaultOpus: profile.claudeExtras?.ANTHROPIC_DEFAULT_OPUS_MODEL,
    defaultHaiku: profile.claudeExtras?.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    defaultFable: profile.claudeExtras?.ANTHROPIC_DEFAULT_FABLE_MODEL,
    subagent: profile.claudeExtras?.CLAUDE_CODE_SUBAGENT_MODEL,
  };
  _configCache.set(`${provider}:${configPath}`, { config: result, ts: Date.now() });
  return result;
}

export function clearConfigCache() { _configCache.clear(); }

/**
 * Join an Anthropic-style base URL with a request suffix (e.g. '/v1/messages'),
 * mirroring how Claude Code appends '/v1/messages' to ANTHROPIC_BASE_URL.
 * Trims trailing slashes on the base and dedupes a base that already ends in
 * '/v1' so `https://example.test/v1` + '/v1/messages' doesn't become '/v1/v1/...'.
 */
export function anthropicEndpoint(baseUrl, suffix) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (base.endsWith('/v1') && suffix.startsWith('/v1/')) return base + suffix.slice(3);
  return base + suffix;
}

const TIER_MAP = { sonnet: 'defaultSonnet', opus: 'defaultOpus', haiku: 'defaultHaiku', fable: 'defaultFable' };

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
 * Falls back to the fable/opus-tier default, then the original id.
 */
export function resolveModelFromId(providerConfig, fullId) {
  if (typeof fullId !== 'string') return fullId;
  const m = fullId.toLowerCase();
  if (m.includes('haiku') && providerConfig.defaultHaiku) return providerConfig.defaultHaiku;
  if (m.includes('fable') && providerConfig.defaultFable) return providerConfig.defaultFable;
  if (m.includes('sonnet') && providerConfig.defaultSonnet) return providerConfig.defaultSonnet;
  if (m.includes('opus') && providerConfig.defaultOpus) return providerConfig.defaultOpus;
  return providerConfig.defaultFable || providerConfig.defaultOpus || providerConfig.defaultSonnet || fullId;
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
    tokenStyle: cfg.tokenStyle,
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
  const apiProviders = Object.entries(config.providers || {})
    .filter(([, p]) => p && p.url)
    .map(([name]) => name)
    .sort();
  if (apiProviders.length === 0) return [...lines, "", "No API-based providers configured."].join("\n");

  lines.push("");
  for (const name of apiProviders) {
    const p = config.providers[name];
    const baseUrl = p.url + (p.claudePath ?? '');
    const models = [];
    if (p.claudeExtras?.ANTHROPIC_DEFAULT_HAIKU_MODEL) models.push(`haiku=${p.claudeExtras.ANTHROPIC_DEFAULT_HAIKU_MODEL}`);
    if (p.claudeExtras?.ANTHROPIC_DEFAULT_FABLE_MODEL) models.push(`fable=${p.claudeExtras.ANTHROPIC_DEFAULT_FABLE_MODEL}`);
    if (p.claudeExtras?.ANTHROPIC_DEFAULT_SONNET_MODEL) models.push(`sonnet=${p.claudeExtras.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
    if (p.claudeExtras?.ANTHROPIC_DEFAULT_OPUS_MODEL) models.push(`opus=${p.claudeExtras.ANTHROPIC_DEFAULT_OPUS_MODEL}`);
    lines.push(`${name.padEnd(8)} → ${baseUrl}  [${models.length ? models.join(", ") : "no defaults set"}]`);
  }
  return lines.join("\n");
}
