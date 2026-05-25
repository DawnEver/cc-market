#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CONFIG_PATH,
  loadProviderConfig,
  resolveModel,
  buildPrompt,
  findCodexCompanion,
  extractText,
  parseArgs,
  readStdin,
  listModels,
} from "./lib.mjs";

// ── Callers ──────────────────────────────────────────────────────────────────

function callCodexCompanion(userPrompt, systemPrompt, model, writeMode = false) {
  return new Promise((resolve, reject) => {
    const companionPath = findCodexCompanion();
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
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
      if (code === 0) resolve({ content: [{ type: "text", text: stdout.trim() }] });
      else reject(new Error(`codex-companion exited ${code}: ${stderr.trim()}`));
    });
  });
}

function callNativeClaude(userPrompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${userPrompt}` : userPrompt;
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
      if (code === 0) resolve({ content: [{ type: "text", text: stdout.trim() }] });
      else reject(new Error(`claude CLI exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt, writeMode) {
  if (writeMode) throw new Error("--write is only supported for the codex provider.");
  if (!model) throw new Error(`No model resolved for provider. Set ANTHROPIC_DEFAULT_SONNET_MODEL in ${CONFIG_PATH}.`);
  const baseUrl = providerConfig.baseUrl.replace(/\/$/, "");
  const url = `${baseUrl}/messages`;
  const body = {
    model,
    max_tokens: 16000,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;
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

// ── CLI ──────────────────────────────────────────────────────────────────────

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/companion.mjs task --provider <name> [--model <model>] [--write] [prompt]",
      "  node scripts/companion.mjs plan --provider <name> [--model <model>] [prompt]",
      "  node scripts/companion.mjs models",
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

  if (subcommand === "models") {
    process.stdout.write(listModels() + "\n");
    return;
  }

  if (!["task", "plan"].includes(subcommand)) {
    throw new Error(`Unknown subcommand: ${subcommand}. Use task, plan, or models.`);
  }

  const { options, prompt: argsPrompt } = parseArgs(argv);
  const stdinPrompt = readStdin();
  const rawPrompt = stdinPrompt || argsPrompt;

  if (!options.provider) throw new Error("--provider is required (e.g. --provider deepseek)");
  if (!rawPrompt)        throw new Error("Provide a prompt as arguments or via stdin.");
  if (options.write && subcommand === "plan") throw new Error("--write is not supported for the plan subcommand.");

  const providerConfig = loadProviderConfig(options.provider);
  const { systemPrompt, userPrompt } = buildPrompt(subcommand, rawPrompt);

  let data;
  if (providerConfig.provider === "codex") {
    process.stderr.write(`takeover: calling codex-companion task (${options.model || "default model"})...\n`);
    data = await callCodexCompanion(userPrompt, systemPrompt, options.model, options.write);
    process.stderr.write("takeover: done\n");
  } else if (providerConfig.native) {
    if (options.write) throw new Error("--write is only supported for the codex provider.");
    process.stderr.write("takeover: calling claude (native CLI)...\n");
    data = await callNativeClaude(userPrompt, systemPrompt);
    process.stderr.write("takeover: done\n");
  } else {
    const model = resolveModel(providerConfig, options.model);
    process.stderr.write(`takeover: calling ${model} (${options.provider})...\n`);
    data = await callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt, options.write);
    process.stderr.write(
      `takeover: ${data.stop_reason || "done"}, ` +
      `tokens: in=${data.usage?.input_tokens || "?"} out=${data.usage?.output_tokens || "?"}\n`
    );
  }

  process.stdout.write(extractText(data) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
