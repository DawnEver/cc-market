#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  loadProviderConfig,
  resolveModel,
  buildPrompt,
  extractText,
  parseArgs,
  readStdin,
  listModels,
  callAnthropicAPI,
  callCodexCompanion,
  callNativeClaude,
} from "./lib.mjs";

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

  // --write is only supported for codex
  if (options.write && providerConfig.provider !== "codex") {
    throw new Error("--write is only supported for the codex provider.");
  }

  const { systemPrompt, userPrompt } = buildPrompt(subcommand, rawPrompt);

  let data;
  if (providerConfig.provider === "codex") {
    process.stderr.write(`takeover: calling codex-companion task (${options.model || "default model"})...\n`);
    data = await callCodexCompanion(userPrompt, systemPrompt, options.model, options.write);
    process.stderr.write("takeover: done\n");
  } else if (providerConfig.native) {
    process.stderr.write("takeover: calling claude (native CLI)...\n");
    data = await callNativeClaude(userPrompt, systemPrompt);
    process.stderr.write("takeover: done\n");
  } else {
    const model = resolveModel(providerConfig, options.model);
    process.stderr.write(`takeover: calling ${model} (${options.provider})...\n`);
    data = await callAnthropicAPI(providerConfig, model, systemPrompt, userPrompt);
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
