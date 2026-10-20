// engine/fabric-config.mjs — the `fabric` block of claude_env_settings.json (synced with
// the provider env blocks). Keys read: `systemPromptFile` (platform prompt for spawned
// children and the API path), `sessionDefaults` ({provider, model} fallback for `call`), and
// `summarizer` / `synthesizer` ({provider, model?}; absent = none, never a built-in default),
// `fanOutConcurrency` (positive integer; calls fan_out runs at once), and `ledger` (the ai-lab
// ledger file every one-shot API call is recorded in).

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
 * The fleet has mixed usernames (`<user-a>` vs `<user-b>`); baking one box's absolute path into
 * the file made every session on the other box exit 1 at startup (reproduced on host-b).
 */
export function resolveSystemPromptFile(promptFile, configPath) {
  if (!promptFile) return null;
  let p = String(promptFile);
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(2));
  }
  // Shared config can be inspected on an OS different from the one that owns
  // an explicit override. Recognize both path grammars instead of interpreting
  // a Windows drive path as POSIX-relative (or vice versa).
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return p;
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
    const hit = _fabricCache.get(configPath);
    if (hit && hit.mtimeMs === mtimeMs && Date.now() - hit.readAt < ttlMs) return hit.fabric;
    const fabric = readRegistry(configPath).fabric || {};
    // Resolve BEFORE caching so every consumer (spawn-child, the MCP API path) reads the machine-correct absolute path from the shared config.
    if (fabric.systemPromptFile) fabric.systemPromptFile = resolveSystemPromptFile(fabric.systemPromptFile, configPath);
    _fabricCache.set(configPath, { mtimeMs, readAt: Date.now(), fabric });
    return fabric;
  } catch {
    return {};
  }
}
