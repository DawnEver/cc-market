// A provider-cache fixture in the shape `python -m ai_lab.providers --json` publishes (the
// contract setup copies into ~/.claude/provider-cache.json), next to a registry file, in a
// fresh temp dir. Returns the registry path: providers.mjs finds the cache beside it.
import crypto from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function row({ endpoints = {}, models = {}, host = "api.example.test", protocol = "openai" } = {}) {
  return {
    wire: "fixture", protocol, url: `https://${host}`, host,
    paths: {}, endpoints, auth: "api", key_name: "EXAMPLE_API_KEY",
    key_usernames: { default: "api-key", "pr-review": "api-key-pr-review" },
    vision: true, vendor: "fixture", model_wires: {}, models,
  };
}

export const FIXTURE_PROVIDERS = {
  acme: row({ host: "api.acme.test", endpoints: { anthropic: "https://api.acme.test/anthropic", openai: "https://api.acme.test/v1" },
    models: { base: "acme-flash", opus: "acme-pro[1m]", sonnet: "acme-pro[1m]" } }),
  plain: row({ host: "api.plain.test", endpoints: { anthropic: "https://plain.test/v1/" }, models: { base: "big-model" } }),
  tiered: row({ host: "api.tiered.test", endpoints: { anthropic: "https://api.tiered.test/coding/" }, models: { base: "t3-256k", fable: "t3[1m]" } }),
  openonly: row({ host: "api.openonly.test", endpoints: { openai: "https://api.openonly.test/v1" } }),
};

export function providerCacheFixture({ providers = FIXTURE_PROVIDERS, registry = {}, generatedAt = new Date().toISOString(), python = "python-fixture", extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fabric-cache-"));
  const packaged = join(dir, "providers.toml");
  writeFileSync(packaged, "# fixture catalogue\n");
  const bytes = Buffer.from("# fixture catalogue\n");
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const doc = {
    schema_version: 1, generated_at: generatedAt, ai_lab_version: "0.0.0-fixture", python,
    inputs: [{ path: packaged, exists: true, sha256: sha }, { path: join(dir, "user-providers.toml"), exists: false, sha256: null }],
    source_sha256: sha, protocols: ["anthropic", "openai"], providers, ...extra,
  };
  writeFileSync(join(dir, "provider-cache.json"), JSON.stringify(doc));
  const configPath = join(dir, "claude_env_settings.json");
  // The ai-lab ledger stays in the fixture dir: no test writes under the real ~/.claude.
  writeFileSync(configPath, JSON.stringify({ ...registry, fabric: { ledger: join(dir, "ledger.jsonl"), ...registry.fabric } }));
  return { configPath, dir, packaged, cachePath: join(dir, "provider-cache.json") };
}

// Keys the fixtures' credential store holds, `<username>@<host>` -> key.
export const FIXTURE_KEYS = {
  "api-key@api.acme.test": "sk-test",
  "api-key-pr-review@api.acme.test": "sk-acme-review",
  "api-key@api.plain.test": "tok-abc",
  "api-key@api.tiered.test": "sk-tiered",
};
export const fixtureKeySource = (keys = FIXTURE_KEYS) => (host, username) => keys[`${username}@${host}`] ?? null;
