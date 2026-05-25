import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export const CONFIG_PATH = path.join(os.homedir(), ".claude", "claude_env_settings.json");

// ── Provider config ──────────────────────────────────────────────────────────

export function loadProviderConfig(provider, configPath = CONFIG_PATH) {
  if (provider === "codex") return { native: true, provider: "codex" };
  if (provider === "claude") return { native: true, provider: "claude" };

  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}\n` +
      `Create it with your provider settings.`
    );
  }
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const envKey = `env:${provider}`;
  const env = config[envKey];
  if (!env) {
    throw new Error(
      `Provider "${provider}" not found in ${configPath}. ` +
      `Add an "env:${provider}" block.`
    );
  }

  const { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_DEFAULT_SONNET_MODEL: defaultSonnet } = env;
  if (!baseUrl) throw new Error(`Provider "${provider}" is missing ANTHROPIC_BASE_URL in ${configPath}.`);
  if (!token)   throw new Error(`Provider "${provider}" is missing ANTHROPIC_AUTH_TOKEN in ${configPath}.`);

  return { native: false, baseUrl, token, defaultSonnet };
}

// ── Model resolution ─────────────────────────────────────────────────────────

export function resolveModel(providerConfig, requestedModel) {
  if (requestedModel) return requestedModel;
  return providerConfig.defaultSonnet;
}

// ── Prompt building ──────────────────────────────────────────────────────────

export function buildPrompt(subcommand, userPrompt) {
  const promptsDir = path.join(SCRIPT_DIR, "..", "prompts");
  let systemPrompt = "";
  const templateFile = path.join(promptsDir, `${subcommand}.md`);
  if (fs.existsSync(templateFile)) {
    systemPrompt = fs.readFileSync(templateFile, "utf8").trim();
  }
  return { systemPrompt, userPrompt: userPrompt.trim() };
}

// ── Codex discovery ──────────────────────────────────────────────────────────

export function findCodexCompanion() {
  if (process.env.TAKEOVER_CODEX_COMPANION) {
    const override = process.env.TAKEOVER_CODEX_COMPANION;
    if (!fs.existsSync(override)) throw new Error(`TAKEOVER_CODEX_COMPANION path not found: ${override}`);
    return override;
  }
  const base = path.join(os.homedir(), ".claude/plugins/cache/openai-codex/codex");
  if (!fs.existsSync(base)) {
    throw new Error("Codex plugin not installed. Run /codex:setup first, or set TAKEOVER_CODEX_COMPANION.");
  }
  const versions = fs.readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  if (!versions.length) throw new Error("No codex plugin versions found in ~/.claude/plugins/cache/openai-codex/codex/");
  versions.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  });
  const companion = path.join(base, versions[0], "scripts", "codex-companion.mjs");
  if (!fs.existsSync(companion)) throw new Error(`codex-companion.mjs not found at: ${companion}`);
  return companion;
}

// ── Text extraction ──────────────────────────────────────────────────────────

export function extractText(data) {
  const content = data.content || [];
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text && content.length > 0) {
    const types = [...new Set(content.map((b) => b.type))].join(", ");
    process.stderr.write(`takeover: warning — response contained no text blocks (got: ${types})\n`);
  }
  return text;
}

// ── CLI args ─────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const options = { provider: null, model: null, write: false };
  const positionals = [];
  let i = 0;
  let endOfOptions = false;
  while (i < argv.length) {
    if (endOfOptions) {
      positionals.push(argv[i++]);
      continue;
    }
    switch (argv[i]) {
      case "--":
        endOfOptions = true;
        break;
      case "--provider":
        if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--provider requires a value.");
        options.provider = argv[++i];
        break;
      case "--model":
      case "-m":
        if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--model requires a value.");
        options.model = argv[++i];
        break;
      case "--write":
        options.write = true;
        break;
      default:
        positionals.push(argv[i]);
    }
    i++;
  }
  return { options, prompt: positionals.join(" ") };
}

// ── Model listing ────────────────────────────────────────────────────────────

export function listModels(configPath = CONFIG_PATH) {
  const lines = [];

  // Native providers (hardcoded, no config needed)
  lines.push("claude   — Native Claude CLI (OAuth/Pro subscription)");
  lines.push("codex    — OpenAI Codex (via codex-companion, --model supported)");

  if (!fs.existsSync(configPath)) {
    lines.push("");
    lines.push(`Config file not found at ${configPath}.`);
    return lines.join("\n");
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const apiProviders = Object.keys(config)
    .filter((k) => k.startsWith("env:") && config[k].ANTHROPIC_BASE_URL)
    .map((k) => k.slice(4));

  if (apiProviders.length === 0) {
    lines.push("");
    lines.push("No API-based providers configured.");
    return lines.join("\n");
  }

  lines.push("");
  for (const name of apiProviders) {
    const env = config[`env:${name}`];
    const models = [];
    if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL) models.push(`haiku=${env.ANTHROPIC_DEFAULT_HAIKU_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_SONNET_MODEL) models.push(`sonnet=${env.ANTHROPIC_DEFAULT_SONNET_MODEL}`);
    if (env.ANTHROPIC_DEFAULT_OPUS_MODEL) models.push(`opus=${env.ANTHROPIC_DEFAULT_OPUS_MODEL}`);
    const baseUrl = env.ANTHROPIC_BASE_URL || "?";
    const modelInfo = models.length > 0 ? models.join(", ") : "no defaults set";
    lines.push(`${name.padEnd(8)} → ${baseUrl}  [${modelInfo}]`);
  }

  return lines.join("\n");
}

// ── Stdin ────────────────────────────────────────────────────────────────────

export function readStdin() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8").trim();
}
