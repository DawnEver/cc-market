// engine/node-config.mjs — fabric LAN-node configuration, read from the same
// claude_env_settings.json that carries provider env blocks (so it syncs across machines
// with the rest of the config). Shape:
//
//   "fabric": {
//     "token": "shared-secret",                       // auth for all nodes (per-node override allowed)
//     "nodes": { "desktop": { "host": "10.0.0.2", "port": 7677 } },   // host may be an IP or DNS name
//     "serve": {
//       "port": 7677,                                 // defaults for every machine
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
import { getConfigPath } from "./providers.mjs";

/** The `fabric` block of the config, or {} if absent/unreadable. */
export function loadFabricConfig(configPath = getConfigPath()) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")).fabric || {};
  } catch {
    return {};
  }
}

/**
 * This machine's effective serve config: `serve` defaults with the matching `serve.byHost`
 * entry merged on top (hostname matched case-insensitively, FQDN or short name; `projects`
 * maps merge per-alias). Returns `{port?, host?, name?, projects, token?}`.
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
