// engine/catalogue.mjs — the live-probed capability catalogue (console v2). Never
// hardcoded, always identified: claude shows its VERSION and SUBSCRIPTION, codex its
// version and auth state, an API provider shows what each tier alias ACTUALLY maps to.
// Every probe carries probed_at so a stale catalogue looks stale.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "../shared/spawn.mjs";
import { getConfigPath } from "./providers.mjs";
import { resolveClaudeExe, EFFORT_LEVELS } from "./spawn-child.mjs";
import { checkCodexStatus } from "./codex/discovery.mjs";
import { loadFabricConfig } from "./node-config.mjs";

function probeClaude() {
  let version = null, subscription = null;
  try { version = String(execFileSync(resolveClaudeExe(), ["--version"], { timeout: 15000 })).trim().split(/\s+/)[0]; } catch { /* not installed */ }
  try {
    const cred = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json"), "utf8"));
    subscription = cred?.claudeAiOauth?.subscriptionType ?? null;
  } catch { /* not logged in */ }
  return {
    name: "claude", kind: "native", version,
    identity: subscription ? `${subscription} subscription` : "not logged in",
    available: !!version && !!subscription,
    models: [{ alias: "haiku", actual: "claude haiku (CLI alias)" }, { alias: "sonnet", actual: "claude sonnet (CLI alias)" }, { alias: "opus", actual: "claude opus (CLI alias)" }],
  };
}

function probeCodex() {
  let st = { installed: false, authenticated: false, version: null };
  try { st = checkCodexStatus(null); } catch { /* discovery failed */ }
  return {
    name: "codex", kind: "native", version: st.version ?? null,
    identity: st.authenticated ? "authenticated" : (st.installed ? "installed, not authenticated" : "not installed"),
    available: !!st.installed && !!st.authenticated,
    models: [], // codex picks its default; no alias table to show
  };
}

const ALIAS_VARS = [["haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"], ["sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"],
                    ["opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"], ["fable", "ANTHROPIC_DEFAULT_FABLE_MODEL"]];

function probeApiProviders(configPath) {
  const out = [];
  try {
    if (!existsSync(configPath)) return out;
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    for (const k of Object.keys(cfg)) {
      if (!k.startsWith("env:")) continue;
      const env = cfg[k];
      const baseUrl = env.ANTHROPIC_FOUNDRY_BASE_URL || env.ANTHROPIC_BASE_URL;
      if (!baseUrl) continue;
      out.push({
        name: k.slice(4), kind: "api", version: null,
        identity: baseUrl, available: true,
        models: ALIAS_VARS.filter(([, v]) => env[v]).map(([alias, v]) => ({ alias, actual: env[v] })),
      });
    }
  } catch { /* config unreadable */ }
  return out;
}

/** Full catalogue with identity and freshness. Cache with TTL; force=true re-probes. */
let _cache = null;
export function liveCatalogue({ ttlMs = 15 * 60 * 1000, force = false, _configPath = getConfigPath, _config = loadFabricConfig, _now = Date.now } = {}) {
  if (!force && _cache && _now() - _cache.probed_at < ttlMs) return _cache;
  let nodes = [];
  try { nodes = Object.keys(_config().nodes || {}); } catch { /* no fabric block */ }
  _cache = {
    probed_at: _now(),
    providers: [probeClaude(), probeCodex(), ...probeApiProviders(_configPath())],
    nodes,
    efforts: Object.entries(EFFORT_LEVELS).map(([name, tokens]) => ({ name, tokens })),
  };
  return _cache;
}
export function _resetCatalogueCache() { _cache = null; }
