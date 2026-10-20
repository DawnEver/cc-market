// engine/providers.mjs — provider routing for the host-only paths (agent mode, observe proxy).
//
// The provider CATALOGUE is ai-lab's (`python -m ai_lab.providers --json`); setup projects it
// into `provider-cache.json` next to the registry (`~/.claude/`). This module only READS that
// cache, and refuses a stale or absent one as `unsupported`, naming the remedy — it never
// regenerates it and never falls back to provider data of its own. `claude` and `codex` are
// HOST CLIs (their own auth), not API rows, so they are the two rows declared here.
//
// The registry (`claude_env_settings.json`) keeps only host projection rules: per provider,
// `claudeApiKeyEnv` (which env var a `claude` child reads the key from), plus the `fabric` block.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ProviderError } from "./errors.mjs";

const defaultConfigPath = path.join(os.homedir(), ".claude", "claude_env_settings.json");
export const getConfigPath = () => process.env.CC_MARKET_CONFIG_PATH || defaultConfigPath;

/** The provider cache sits next to the registry: one directory, one override. */
export const cachePathFor = (configPath = getConfigPath()) =>
  path.join(path.dirname(configPath), "provider-cache.json");

export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const SETUP_REMEDY = "node scripts/setup/setup.js";

/** Host CLIs: not in ai-lab's API catalogue, they authenticate themselves. */
export const HOST_PROVIDERS = Object.freeze({
  claude: "Native Claude CLI (its own sign-in)",
  codex: "OpenAI Codex (codex app-server; supports review, image, write)",
});

// Env vars that any provider may inject; stripped from the parent env before projection.
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

/** The registry (host projection rules + the fabric block), `{}` when absent. */
export function readRegistry(configPath = getConfigPath()) {
  if (!fs.existsSync(configPath)) return {};
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

const stale = (cachePath, why) =>
  new ProviderError("unsupported", `provider cache ${cachePath} ${why}; run \`${SETUP_REMEDY}\` to rebuild it`);

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/**
 * The provider cache, checked for expiry: schema version, age, and every recorded catalogue
 * input still matching its sha256 (so `source_sha256` still describes the files on disk).
 * Throws ProviderError(unsupported) naming the remedy otherwise.
 */
export function readCatalogue(configPath = getConfigPath(), { now = Date.now(), maxAgeMs = CACHE_MAX_AGE_MS } = {}) {
  const cachePath = cachePathFor(configPath);
  if (!fs.existsSync(cachePath)) throw stale(cachePath, "is absent");
  let doc;
  try { doc = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch (e) { throw stale(cachePath, `is unreadable (${e.message})`); }
  if (doc?.schema_version !== CACHE_SCHEMA_VERSION) throw stale(cachePath, `has schema_version ${doc?.schema_version}, expected ${CACHE_SCHEMA_VERSION}`);
  const age = now - Date.parse(doc.generated_at);
  if (!(age <= maxAgeMs)) throw stale(cachePath, `is older than ${Math.round(maxAgeMs / 86400000)} d (generated_at ${doc.generated_at})`);
  const digest = crypto.createHash("sha256");
  for (const input of doc.inputs || []) {
    const exists = fs.existsSync(input.path);
    if (exists !== !!input.exists) throw stale(cachePath, `recorded ${input.path} as ${input.exists ? "present" : "absent"}, it is now ${exists ? "present" : "absent"}`);
    if (!exists) continue;
    const bytes = fs.readFileSync(input.path);
    if (sha256(bytes) !== input.sha256) throw stale(cachePath, `is out of date: ${input.path} changed since it was generated`);
    digest.update(bytes);
  }
  if (doc.source_sha256 && digest.digest("hex") !== doc.source_sha256) throw stale(cachePath, "has a source_sha256 that does not match its inputs");
  return doc;
}

/**
 * The Claude model env vars of a `models` map: `base` -> ANTHROPIC_MODEL, each role key
 * overrides its class default, falling back to `base`. No `base`: no model vars.
 */
export function modelEnv(models) {
  const m = models || {};
  if (!m.base) return {};
  return {
    ANTHROPIC_MODEL: m.base,
    ANTHROPIC_DEFAULT_FABLE_MODEL: m.fable ?? m.base,
    ANTHROPIC_DEFAULT_OPUS_MODEL: m.opus ?? m.base,
    ANTHROPIC_DEFAULT_SONNET_MODEL: m.sonnet ?? m.base,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: m.haiku ?? m.base,
    CLAUDE_CODE_SUBAGENT_MODEL: m.subagent ?? m.base,
  };
}

/** The catalogue row of an API provider; ProviderError(unsupported) naming the known ones. */
export function catalogueRow(provider, configPath = getConfigPath()) {
  const doc = readCatalogue(configPath);
  const row = doc.providers?.[provider];
  if (!row) {
    const known = [...Object.keys(HOST_PROVIDERS), ...Object.keys(doc.providers || {})].join(", ");
    throw new ProviderError("unsupported", `provider "${provider}" is not in the catalogue (${cachePathFor(configPath)}); known: ${known}`);
  }
  return row;
}

// The key a provider's API takes, for the given task. Interim: the registry's apiKey field.
function apiKey(provider, configPath) {
  const key = readRegistry(configPath).providers?.[provider]?.apiKey;
  if (!key) throw new ProviderError("auth", `no key for provider "${provider}"`);
  return key;
}

/**
 * Normalized provider config: `{ native, provider }` for host CLIs, else
 * `{ native:false, provider, row, baseUrl, keyEnv, tokenStyle, default<Tier>, subagent }`.
 * `baseUrl` is the row's anthropic-protocol endpoint (what a `claude` child and the observe
 * proxy speak), or null when the provider has none.
 */
export function loadProviderConfig(provider, configPath = getConfigPath()) {
  if (provider in HOST_PROVIDERS) return { native: true, provider };
  const row = catalogueRow(provider, configPath);
  const keyEnv = readRegistry(configPath).providers?.[provider]?.claudeApiKeyEnv || "ANTHROPIC_API_KEY";
  const m = modelEnv(row.models);
  return {
    native: false, provider, row,
    baseUrl: row.endpoints?.anthropic ?? null,
    keyEnv,
    // ANTHROPIC_AUTH_TOKEN -> `Authorization: Bearer`, ANTHROPIC_API_KEY -> `x-api-key`,
    // exactly as Claude Code itself sends them.
    tokenStyle: keyEnv === "ANTHROPIC_AUTH_TOKEN" ? "bearer" : "x-api-key",
    defaultSonnet: m.ANTHROPIC_DEFAULT_SONNET_MODEL,
    defaultOpus: m.ANTHROPIC_DEFAULT_OPUS_MODEL,
    defaultHaiku: m.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    defaultFable: m.ANTHROPIC_DEFAULT_FABLE_MODEL,
    subagent: m.CLAUDE_CODE_SUBAGENT_MODEL,
  };
}

function requireAnthropic(cfg, use) {
  if (!cfg.baseUrl) {
    throw new ProviderError("unsupported", `provider "${cfg.provider}" has no anthropic-protocol endpoint, so it cannot ${use}`);
  }
  return cfg.baseUrl.replace(/\/+$/, "");
}

/**
 * Full child-process env for a `claude` child on a provider: strips provider keys, overlays
 * the anthropic endpoint, the key and the model pins. Host CLIs get the bare env.
 */
export function loadProviderEnv(provider, configPath = getConfigPath()) {
  const env = { ...process.env };
  for (const key of PROVIDER_ENV_KEYS) delete env[key];
  const cfg = loadProviderConfig(provider, configPath);
  if (cfg.native) return env;
  // Claude Code appends /v1/messages to ANTHROPIC_BASE_URL itself.
  env.ANTHROPIC_BASE_URL = requireAnthropic(cfg, "run a claude child").replace(/\/v1$/, "");
  env[cfg.keyEnv] = apiKey(provider, configPath);
  Object.assign(env, modelEnv(cfg.row.models));
  return env;
}

/**
 * Join an Anthropic-style base URL with a request suffix (e.g. '/v1/messages'), deduping a
 * base that already ends in '/v1'.
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
 * Resolve a FULL Claude model id (e.g. "claude-haiku-4-5-20251001") to the provider's id by
 * tier substring — what the observe proxy needs to remap a child's request body.
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

/** `{ baseUrl, token, tokenStyle, resolveModel }` for the observe proxy; refuses host CLIs. */
export function resolveUpstream(provider, configPath = getConfigPath()) {
  const cfg = loadProviderConfig(provider, configPath);
  if (cfg.native) throw new Error(`Provider "${provider}" is native (${provider}) — not routable through the observe proxy.`);
  return {
    baseUrl: requireAnthropic(cfg, "be observed"),
    token: apiKey(provider, configPath),
    tokenStyle: cfg.tokenStyle,
    resolveModel: (fullId) => resolveModelFromId(cfg, fullId),
  };
}

/** One line per provider: the host CLIs, then the catalogue's rows (or why there are none). */
export function listModels(configPath = getConfigPath()) {
  const lines = Object.entries(HOST_PROVIDERS).map(([name, what]) => `${name.padEnd(10)} — ${what}`);
  let doc;
  try { doc = readCatalogue(configPath); } catch (e) { return [...lines, "", e.message].join("\n"); }
  lines.push("");
  for (const [name, row] of Object.entries(doc.providers || {}).sort(([a], [b]) => a.localeCompare(b))) {
    const m = modelEnv(row.models);
    const models = [['haiku', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], ['fable', 'ANTHROPIC_DEFAULT_FABLE_MODEL'],
      ['sonnet', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], ['opus', 'ANTHROPIC_DEFAULT_OPUS_MODEL']]
      .filter(([, k]) => m[k]).map(([role, k]) => `${role}=${m[k]}`);
    const endpoints = Object.values(row.endpoints || {}).join(" ");
    lines.push(`${name.padEnd(10)} → ${endpoints}  [${models.length ? models.join(", ") : "no defaults set"}]`);
  }
  return lines.join("\n");
}
