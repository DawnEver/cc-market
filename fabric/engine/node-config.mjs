// engine/node-config.mjs — fabric LAN-node configuration, read from the same
// claude_env_settings.json that carries provider env blocks (so it syncs across machines
// with the rest of the config). Shape:
//
//   "fabric": {
//     "token": "shared-secret",                       // PRIMARY token this machine accepts
//     "tokens": ["peer-b-secret"],                    // additional ACCEPTED tokens
//     "nodes": { "desktop": { "host": "10.0.0.2", "port": 7677, "token": "peer-b-secret" } },
//     "serve": {
//       "port": 7677,                                 // defaults for every machine
//       "maxSessions": 64,                            // static ceiling on concurrent sessions
//       "projects": { "thesis": "C:/work/thesis" },
//       "byHost": {                                   // per-machine overrides, keyed by hostname
//         "my-desktop": { "projects": { "thesis": "D:/repos/thesis" } }
//       }
//     }
//   }
//
// The config file is SYNCED across machines, so `serve` is shared — `byHost` lets each
// machine override port/name/host/projects. Keys match os.hostname() case-insensitively,
// by FQDN or short (first-label) name. `projects` maps merge (override wins per alias).
//
// Nodes exchange MESSAGES only — no shared filesystem is ever assumed. A remote task runs
// in the remote machine's own project directory (referenced by alias, never by path).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigPath, readRegistry } from "./providers.mjs";

const _fabricCache = new Map(); // configPath → { mtimeMs, readAt, fabric }
// mtimeMs has 1-second granularity on Windows, so an edit landing in the same second as
// the last read is invisible to mtime alone — permanently, for a daemon (SR-053). The TTL
// bounds that blindness to a couple of seconds without re-reading on every call.
export const CONFIG_CACHE_TTL_MS = 2000;

/**
 * Resolve the platform system-prompt file to an absolute path, machine-independently.
 * Convention (first-principles, 2026-08-11): shared configs reference the platform prompts
 * via the per-machine symlinks setup.js creates — `~/.claude/system-prompt/claude-base.md`
 * and `~/.codex/system-prompt/codex-base.md` both resolve into the synced repo, so a
 * config NEVER carries a machine-specific (OneDrive) path. Resolution:
 *   - `~`-prefixed → expand to the home dir (the dir-symlink does the rest)
 *   - ABSOLUTE    → used as-is (backward compat / explicit override)
 *   - RELATIVE    → resolve against the config file's REAL dir (the repo root, via the
 *                   ~/.claude/claude_env_settings.json symlink) — a fallback that works
 *                   even on a machine that has not run setup yet
 * The fleet has mixed usernames (linxu vs ezxmb14); baking one box's absolute path into
 * the file made every session on the other box exit 1 at startup (reproduced on WS1).
 */
export function resolveSystemPromptFile(promptFile, configPath) {
  if (!promptFile) return null;
  let p = String(promptFile);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(2));
  }
  if (path.isAbsolute(p)) return p;
  try { return path.resolve(path.dirname(fs.realpathSync(configPath)), p); }
  catch { return path.resolve(path.dirname(configPath), p); }
}

/**
 * The `fabric` block of the config, or {} if absent/unreadable.
 * Cached per path by mtime AND a short TTL.
 */
export function loadFabricConfig(configPath = getConfigPath(), { ttlMs = CONFIG_CACHE_TTL_MS } = {}) {
  try {
    const { mtimeMs } = fs.statSync(configPath);
    // readRegistry merges the machine-local secrets overlay (claude_env_settings.local.json,
    // next to the config); track ITS mtime too so a local edit invalidates this cache.
    const localPath = path.join(path.dirname(configPath), "claude_env_settings.local.json");
    const localMtime = fs.existsSync(localPath) ? fs.statSync(localPath).mtimeMs : -1;
    const hit = _fabricCache.get(configPath);
    if (hit && hit.mtimeMs === mtimeMs && hit.localMtime === localMtime && Date.now() - hit.readAt < ttlMs) return hit.fabric;
    const fabric = readRegistry(configPath).fabric || {};
    // Resolve BEFORE caching so every consumer (open-session, spawn-child, the MCP API
    // path, catalogue) reads the machine-correct absolute path from the shared config.
    if (fabric.systemPromptFile) fabric.systemPromptFile = resolveSystemPromptFile(fabric.systemPromptFile, configPath);
    _fabricCache.set(configPath, { mtimeMs, localMtime, readAt: Date.now(), fabric });
    return fabric;
  } catch {
    return {};
  }
}

/**
 * This machine's effective serve config: `serve` defaults with the matching `serve.byHost`
 * entry merged on top (hostname matched case-insensitively, FQDN or short name; `projects`
 * maps merge per-alias). Returns `{port?, host?, name?, projects, token?, tokens}`.
 *
 * `tokens` is the ACCEPTED SET, unioned across fabric/serve/byHost: revoking a peer means
 * deleting one entry here, not re-keying every machine (SR-051). `token` stays primary.
 */
export function loadServeConfig(configPath = getConfigPath(), hostName = os.hostname()) {
  const fab = loadFabricConfig(configPath);
  const { byHost, ...base } = fab.serve || {};
  const shortOf = (h) => String(h).toLowerCase().split(".")[0];
  const match = Object.entries(byHost || {}).find(([key]) =>
    key.toLowerCase() === String(hostName).toLowerCase() || shortOf(key) === shortOf(hostName));
  const override = match ? match[1] : {};
  return {
    ...base, ...override,
    projects: { ...(base.projects || {}), ...(override.projects || {}) },
    token: override.token || base.token || fab.token,
    tokens: [...new Set([...(fab.tokens || []), ...(base.tokens || []), ...(override.tokens || [])])],
  };
}

/** Resolve a node name to `{host, port, token}`; per-node token falls back to fabric.token. */
export function resolveNode(name, configPath = getConfigPath()) {
  const fab = loadFabricConfig(configPath);
  const node = fab.nodes?.[name];
  if (!node) {
    const available = Object.keys(fab.nodes || {}).join(", ") || "(none configured)";
    throw new Error(`fabric node "${name}" not found in ${configPath}. Available: ${available}`);
  }
  return { ...node, token: node.token || fab.token };
}
