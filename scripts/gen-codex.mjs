#!/usr/bin/env node
// gen-codex.mjs — Generate Codex plugin artifacts from the Claude-Code source of truth.
//
// For each plugin listed in `.claude-plugin/marketplace.json`, transpile its
// `.claude-plugin/plugin.json` → `.codex-plugin/plugin.json` (Codex's accepted shape),
// then emit a Codex marketplace at `.agents/plugins/marketplace.json`.
//
// Codex ingests Claude artifacts directly: it auto-discovers `hooks.json`/`.mcp.json`/`skills/`
// and substitutes `${CLAUDE_PLUGIN_ROOT}` itself, so those files are NOT rewritten — only the
// manifest (which rejects Claude-only keys like `commands`/`hooks`) and the marketplace need
// generating. See CODEX-SUPPORT.md §7 for the validated contract.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keys Codex's plugin validator accepts; everything else is dropped from the manifest.
const CODEX_MANIFEST_KEYS = ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'];

/** Trim a string to at most `max` chars without cutting mid-word where avoidable. */
function clamp(str, max) {
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** Title-case a marketplace category ("productivity" → "Productivity"). */
function titleCase(s) {
  return String(s || 'Productivity').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Build the Codex `interface` block. Prefer an explicit `codexInterface` override on the source
 * manifest; otherwise synthesize required fields from the manifest + marketplace entry.
 */
export function buildInterface(manifest, marketEntry = {}) {
  const override = manifest.codexInterface || {};
  const displayName = override.displayName || marketEntry.displayName || manifest.name;
  const longDescription = override.longDescription || marketEntry.description || manifest.description || displayName;
  return {
    displayName,
    shortDescription: clamp(override.shortDescription || manifest.description || displayName, 80),
    longDescription,
    developerName: override.developerName || manifest.author?.name || 'Unknown',
    category: titleCase(override.category || marketEntry.category),
    capabilities: override.capabilities || ['Interactive'],
    defaultPrompt: (override.defaultPrompt || [`Use the ${displayName} plugin.`]).slice(0, 3).map((p) => clamp(p, 128)),
  };
}

/**
 * Transpile a Claude plugin manifest into the Codex `.codex-plugin/plugin.json` shape.
 * Drops Claude-only keys (`commands`, `hooks`), keeps the accepted subset, adds `interface`,
 * and wires `mcpServers`/`skills` contract paths when those components exist on disk.
 */
export function transpileManifest(manifest, { marketEntry = {}, pluginDir = null } = {}) {
  const out = {};
  for (const k of CODEX_MANIFEST_KEYS) {
    if (manifest[k] !== undefined) out[k] = manifest[k];
  }
  // Component contract paths (Codex also auto-discovers these, but declaring is harmless and explicit).
  if (pluginDir) {
    if (existsSync(join(pluginDir, '.mcp.json'))) out.mcpServers = './.mcp.json';
    if (existsSync(join(pluginDir, 'skills'))) out.skills = './skills/';
  }
  out.interface = buildInterface(manifest, marketEntry);
  return out;
}

/** Build a single Codex marketplace plugin entry from a Claude marketplace entry. */
export function transpileMarketEntry(entry) {
  return {
    name: entry.name,
    source: { source: 'local', path: `./${entry.name}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
    category: titleCase(entry.category),
  };
}

/** Build the full Codex marketplace manifest from the Claude one. */
export function transpileMarketplace(market) {
  return {
    name: market.name,
    interface: { displayName: market.metadata?.displayName || titleCase(market.name) },
    plugins: market.plugins.map(transpileMarketEntry),
  };
}

function readJSON(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJSON(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Generate all Codex artifacts under `repoRoot` (the cc-market dir). Returns a summary of
 * written files. Pure-ish: only touches `.codex-plugin/` and `.agents/plugins/`.
 */
export function generate(repoRoot, { write = true } = {}) {
  const market = readJSON(join(repoRoot, '.claude-plugin', 'marketplace.json'));
  const written = [];
  const byName = Object.fromEntries(market.plugins.map((p) => [p.name, p]));

  for (const entry of market.plugins) {
    const pluginDir = join(repoRoot, entry.name);
    const srcManifestPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    if (!existsSync(srcManifestPath)) continue;
    const manifest = readJSON(srcManifestPath);
    const codexManifest = transpileManifest(manifest, { marketEntry: entry, pluginDir });
    const dest = join(pluginDir, '.codex-plugin', 'plugin.json');
    if (write) writeJSON(dest, codexManifest);
    written.push(dest);
  }

  const codexMarket = transpileMarketplace(market);
  const marketDest = join(repoRoot, '.agents', 'plugins', 'marketplace.json');
  if (write) writeJSON(marketDest, codexMarket);
  written.push(marketDest);

  return { written, market: codexMarket, byName };
}

// CLI entry
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
  const { written } = generate(repoRoot);
  for (const f of written) console.log('wrote', f);
}
