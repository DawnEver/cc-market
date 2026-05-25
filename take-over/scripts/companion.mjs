#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH =
  process.env.TAKE_OVER_CONFIG ||
  path.join(os.homedir(), ".claude", "take-over.json");

// ── Provider config ──────────────────────────────────────────────────────────

function loadProviderConfig(provider) {
  if (provider === "codex") {
    return { native: true, provider: "codex" };
  }

  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config file not found: ${CONFIG_PATH}\n` +
      `Create it with your provider settings, or set TAKE_OVER_CONFIG to point to your config file.`
    );
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const envKey = `env:${provider}`;
  const env = config[envKey];
  if (!env) {
    throw new Error(
      `Provider "${provider}" not found in ${CONFIG_PATH}. ` +
      `Add an "env:${provider}" block.`
    );
  }

  const isEmpty = !env.ANTHROPIC_AUTH_TOKEN && !env.ANTHROPIC_BASE_URL;
  if (isEmpty && provider === "claude") {
    return { native: true, provider: "claude" };
  }

  return {
    native: false,
    baseUrl: env.ANTHROPIC_BASE_URL,
    token: env.ANTHROPIC_AUTH_TOKEN,
    defaultOpus: env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    defaultSonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    defaultHaiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  };
}

function resolveModel(providerConfig, requestedModel) {
  if (requestedModel) return requestedModel;
  return providerConfig.defaultSonnet;
}

function buildPrompt(subcommand, userPrompt) {
  const promptsDir = path.join(SCRIPT_DIR, "..", "prompts");

  let systemPrompt = "";
  const templateFile = path.join(promptsDir, `${subcommand}.md`);
  if (fs.existsSync(templateFile)) {
    systemPrompt = fs.readFileSync(templateFile, "utf8").trim();
  }

  return { systemPrompt, userPrompt: userPrompt.trim() };
}

// ── Codex companion delegation ───────────────────────────────────────────────

function findCodexCompanion() {
  const base = path.join(os.homedir(), ".claude/plugins/cache/openai-codex/codex");
  if (!fs.existsSync(base)) {
    throw new Error("Codex plugin not installed. Run /codex:setup first.");
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

function callCodexCompanion(userPrompt, systemPrompt, model, writeMode = false) {
  return new Promise((resolve, reject) => {
    const companionPath = findCodexCompanion();
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${userPrompt}`
      : userPrompt;
    const args = ["task"];
    if (writeMode) args.push("--write");
    if (model) args.push("--model", model);
    args.push(fullPrompt);
    const child = spawn(process.execPath, [companionPath, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ content: [{ type: "text", text: stdout.trim() }] });
      } else {
        reject(new Error(`codex-companion exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

// ── Other callers ────────────────────────────────────────────────────────────

function callNativeClaude(userPrompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const fullPrompt = systemPrompt
      ? `${systemPrompt}\n\n---\n\n${userPrompt}`
      : userPrompt;
    const child = spawn("claude", ["-p", fullPrompt], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ content: [{ type: "text", text: stdout.trim() }] });
      } else {
        reject(new Error(`claude CLI exited ${code}: ${stderr.trim()}`));
      }
    });
  });
}

async function callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt, _writeMode) {
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/messages`;

  const body = {
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": providerConfig.token,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API error ${res.status}: ${errorText}`);
  }

  return res.json();
}

function extractText(data) {
  const content = data.content || [];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { provider: null, model: null, write: false };
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    switch (argv[i]) {
      case "--provider":
        options.provider = argv[++i];
        break;
      case "--model":
      case "-m":
        options.model = argv[++i];
        break;
      case "--write":
        options.write = true;
        break;
      default:
        if (!argv[i].startsWith("-")) {
          positionals.push(argv[i]);
        }
    }
    i++;
  }
  return { options, prompt: positionals.join(" ") };
}

function readStdin() {
  if (process.stdin.isTTY) return "";
  return fs.readFileSync(0, "utf8").trim();
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/companion.mjs task --provider <name> [--model <model>] [--write] [prompt]",
      "  node scripts/companion.mjs plan --provider <name> [--model <model>] [prompt]",
      "",
      "  For codex background jobs, use /codex:status, /codex:result, /codex:cancel",
    ].join("\n")
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);

  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    usage();
    return;
  }

  if (!["task", "plan"].includes(subcommand)) {
    throw new Error(`Unknown subcommand: ${subcommand}. Use task or plan.`);
  }

  const { options, prompt: argsPrompt } = parseArgs(argv);
  const stdinPrompt = readStdin();
  const rawPrompt = stdinPrompt || argsPrompt;

  if (!options.provider) {
    throw new Error("--provider is required (e.g. --provider deepseek)");
  }

  if (!rawPrompt) {
    throw new Error("Provide a prompt as arguments or via stdin.");
  }

  const providerConfig = loadProviderConfig(options.provider);
  const { systemPrompt, userPrompt } = buildPrompt(subcommand, rawPrompt);

  let data;
  if (providerConfig.provider === "codex") {
    process.stderr.write(
      `take-over: calling codex-companion task (${options.model || "default model"})...\n`
    );
    data = await callCodexCompanion(userPrompt, systemPrompt, options.model, options.write);
    process.stderr.write("take-over: done\n");
  } else if (providerConfig.native) {
    process.stderr.write(
      `take-over: calling claude (native CLI, ${options.provider})...\n`
    );
    data = await callNativeClaude(userPrompt, systemPrompt);
    process.stderr.write("take-over: done\n");
  } else {
    if (!providerConfig.token) {
      throw new Error(
        `No ANTHROPIC_AUTH_TOKEN found for provider "${options.provider}". ` +
        `Add it to ${CONFIG_PATH} under env:${options.provider}.`
      );
    }

    const model = resolveModel(providerConfig, options.model);
    const modeLabel = options.write ? "read-write" : "read-only";
    process.stderr.write(
      `take-over: calling ${model} (${options.provider}, ${modeLabel})...\n`
    );

    data = await callAnthropicAPI(
      providerConfig,
      model,
      systemPrompt,
      userPrompt,
      options.write
    );

    process.stderr.write(
      `take-over: ${data.stop_reason || "done"}, ` +
      `tokens: in=${data.usage?.input_tokens || "?"} out=${data.usage?.output_tokens || "?"}\n`
    );
  }

  process.stdout.write(extractText(data) + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
