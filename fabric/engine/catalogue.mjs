// engine/catalogue.mjs — the live-probed capability catalogue (console v2). Never
// hardcoded, always identified: claude shows its VERSION and SUBSCRIPTION, codex its
// version and auth state, an API provider shows what each tier alias ACTUALLY maps to.
// Every probe carries probed_at so a stale catalogue looks stale.
//
// ALL probes are async — the sync versions blocked the single-threaded HTTP server for
// up to ~40s per catalogue refresh (execFileSync claude --version, spawnSync codex
// doctor), which froze the console's fleet/chat polling. A probe may still take seconds;
// it just never blocks the loop, so a fresh catalogue arrives when it's ready and the
// previous one keeps showing until then.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getConfigPath } from "./providers.mjs";
import { resolveClaudeExe, EFFORT_LEVELS } from "./spawn-child.mjs";
import { checkCodexStatusAsync } from "./codex/discovery.mjs";
import { loadFabricConfig } from "./node-config.mjs";

const execFileP = promisify(execFile);
/** Await `cmd --version` → trimmed stdout, or null on any failure. Never blocks. */
async function versionOf(cmd, timeoutMs = 15000) {
  try {
    const { stdout } = await execFileP(cmd, ["--version"], { timeout: timeoutMs, encoding: "utf8", windowsHide: true });
    return String(stdout).trim().split(/\s+/)[0] || null;
  } catch { return null; }
}

async function probeClaude() {
  const version = await versionOf(resolveClaudeExe());
  let subscription = null;
  try {
    const cred = JSON.parse(readFileSync(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json"), "utf8"));
    subscription = cred?.claudeAiOauth?.subscriptionType ?? null;
  } catch { /* not logged in */ }
  return {
    name: "claude", kind: "native", version,
    identity: subscription ? `${subscription} subscription` : "not logged in",
    available: !!version && !!subscription,
    models: [
      { alias: "haiku", actual: "claude-haiku-4-5" },
      { alias: "sonnet", actual: "claude-sonnet-5" },
      { alias: "opus", actual: "claude-opus-5" },
      { alias: "fable", actual: "claude-fable-5" },
    ],
  };
}

async function probeCodex() {
  let st = { installed: false, authenticated: false, version: null };
  try { st = await checkCodexStatusAsync(null); } catch { /* discovery failed */ }
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

/**
 * Full catalogue with identity and freshness. Cache with TTL; force=true re-probes.
 * Async: probes never block the event loop. A concurrent force while a probe runs is
 * coalesced (one in-flight probe feeds both callers) — re-probes must not stack.
 */
let _cache = null;
let _inflight = null;
export function liveCatalogue({ ttlMs = 15 * 60 * 1000, force = false, _configPath = getConfigPath, _config = loadFabricConfig, _now = Date.now } = {}) {
  if (!force && _cache && _now() - _cache.probed_at < ttlMs) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    let nodes = [];
    let defaults = null;
    try { nodes = Object.keys(_config().nodes || {}); defaults = _config().sessionDefaults || null; } catch { /* no fabric block */ }
    const [claude, codex] = await Promise.all([probeClaude(), probeCodex()]);
    _cache = {
      probed_at: _now(),
      providers: [claude, codex, ...probeApiProviders(_configPath())],
      nodes,
      efforts: Object.entries(EFFORT_LEVELS).map(([name, tokens]) => ({ name, tokens })),
      defaults,
    };
    return _cache;
  })().finally(() => { _inflight = null; });
  return _inflight;
}
export function _resetCatalogueCache() { _cache = null; _inflight = null; }
