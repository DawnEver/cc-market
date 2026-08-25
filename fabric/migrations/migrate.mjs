// fabric/migrations/migrate.mjs — one-shot conversion of the host project's
// `~/.claude/claude_env_settings.local.json` from the pre-2026-08-25
// `env:<provider>` shape to the new `providers.<provider>.apiKey` shape.
//
// Pre-refactor local file:
//   { "env:deepseek": { "ANTHROPIC_API_KEY": "sk-..." }, ... }
//
// Post-refactor local file:
//   { "providers": { "deepseek": { "apiKey": "sk-..." }, ... } }
//
// fabric/engine/providers.mjs reads the new shape; without this migration
// the user gets "Provider 'deepseek' not found" from any fabric call after
// the root repo's setup.js auto-migrated their file. Idempotent — no-op once
// the local file is in the new shape (or is mixed/empty/malformed).
//
// Backup written next to the file with the `.setup-bak` suffix the root repo's
// linkEntry() uses, so the user has a single recovery convention.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function migrateLocalEnvSettings({ localPath }) {
  if (!existsSync(localPath)) return { status: "no-file" };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(localPath, "utf8"));
  } catch (err) {
    return { status: "malformed", error: err.message };
  }

  const topKeys = Object.keys(parsed);
  const hasLegacy = topKeys.some((k) => k.startsWith("env:"));
  const providers = parsed.providers;
  const hasNew = providers && typeof providers === "object"
    && Object.keys(providers).length > 0;

  if (!hasLegacy) return { status: "current" };
  if (hasNew) return { status: "mixed" };

  const migrated = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith("env:")) { migrated[k] = v; continue; }
    const name = k.slice("env:".length);
    if (!migrated.providers) migrated.providers = {};
    if (migrated.providers[name]) continue;
    const stringValues = Object.values(v || {}).filter((x) => typeof x === "string");
    if (stringValues.length === 0) continue;
    migrated.providers[name] = { apiKey: stringValues[0] };
  }

  const backupPath = localPath + ".setup-bak";
  copyFileSync(localPath, backupPath);
  writeFileSync(localPath, JSON.stringify(migrated, null, 2) + "\n");
  return {
    status: "migrated",
    providers: Object.keys(migrated.providers || {}),
    backupPath,
  };
}

export async function migrate(projectRoot) {
  // projectRoot is the host project (where the .claude/ is symlinked to claude_env_settings.json
  // by the root repo's setup.js). The machine-local file lives in ~/.claude/, a real
  // per-machine dir — not a symlink into any project. projectRoot is not read here because
  // the local-file path is always ~/.claude/ (per-machine, not per-project).
  void projectRoot;
  const localPath = join(homedir(), ".claude", "claude_env_settings.local.json");
  const result = migrateLocalEnvSettings({ localPath });

  if (result.status === "migrated") {
    return {
      changed: true,
      summary: [
        `Migrated ${result.providers.length} provider(s) from env:<name> to providers.<name>.apiKey`,
        `  backup: ${result.backupPath}`,
      ],
    };
  }
  if (result.status === "malformed") {
    return { changed: false, summary: [`could not parse local file: ${result.error}`] };
  }
  if (result.status === "mixed") {
    return {
      changed: false,
      summary: [
        "local file is in mixed shape (both env: and providers: present); left untouched — fabric/engine/providers.mjs will surface a clear error",
      ],
    };
  }
  return { changed: false, summary: [] };
}
