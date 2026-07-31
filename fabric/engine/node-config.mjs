// engine/node-config.mjs — fabric LAN-node configuration, read from the same
// claude_env_settings.json that carries provider env blocks (so it syncs across machines
// with the rest of the config). Shape:
//
//   "fabric": {
//     "token": "shared-secret",                       // auth for all nodes (per-node override allowed)
//     "nodes": { "desktop": { "host": "10.0.0.2", "port": 7677 } },
//     "serve": { "port": 7677, "name": "laptop",      // this machine's node server
//                "projects": { "thesis": "C:/work/thesis" } }   // alias → local path
//   }
//
// Nodes exchange MESSAGES only — no shared filesystem is ever assumed. A remote task runs
// in the remote machine's own project directory (referenced by alias, never by path).

import fs from "node:fs";
import { getConfigPath } from "./providers.mjs";

/** The `fabric` block of the config, or {} if absent/unreadable. */
export function loadFabricConfig(configPath = getConfigPath()) {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")).fabric || {};
  } catch {
    return {};
  }
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
