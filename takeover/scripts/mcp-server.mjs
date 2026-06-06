#!/usr/bin/env node
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

import {
  loadProviderConfig,
  resolveModel,
  buildPrompt,
  extractText,
  listModels,
  parseCommandBlock,
  callAnthropicAPI,
  callCodexCompanion,
  callNativeClaude,
} from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginJson = JSON.parse(readFileSync(join(__dirname, "..", ".claude-plugin", "plugin.json"), "utf8"));
const SERVER_NAME = pluginJson.name;
const SERVER_VERSION = pluginJson.version;

// ── MCP stdio transport ───────────────────────────────────────────

export function send(rpc) {
  process.stdout.write(JSON.stringify(rpc) + "\n");
}

// ── Tool definitions ──────────────────────────────────────────────

export const TOOLS = [
  {
    name: "call_model",
    description:
      "Call an AI model from any configured provider. " +
      "Routes to Claude (native CLI), Codex (codex-companion), " +
      "or any Anthropic-compatible API from ~/.claude/claude_env_settings.json. " +
      "If userPrompt contains a <command> block with --provider/--model flags, " +
      "those are parsed authoritatively — the provider/model params are overridden.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "Provider name: claude, codex, deepseek, " +
            "or a custom provider key from claude_env_settings.json. " +
            "Optional — parsed from <command> block if omitted.",
        },
        model: {
          type: "string",
          description: "Model name. Optional — uses provider default.",
        },
        mode: {
          type: "string",
          enum: ["task"],
          description:
            "Built-in system prompt template. " +
            "'task' for code/investigation or architecture/design.",
        },
        write: {
          type: "boolean",
          description:
            "For codex provider only: enable write mode so the model can edit files. " +
            "Ignored for non-codex providers.",
        },
        systemPrompt: {
          type: "string",
          description: "Custom system prompt. Overrides mode if both set.",
        },
        userPrompt: {
          type: "string",
          description: "The user message or task to hand off.",
        },
      },
      required: ["userPrompt"],
    },
  },
  {
    name: "list_models",
    description: "List all available providers and their configured models.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────

export async function handleCallModel(args) {
  let { provider, model, mode, systemPrompt: customSystem, userPrompt, write } = args;

  // Parse <command> block from userPrompt — authoritative flag source.
  // The agent may have parsed flags incorrectly (or not at all); the
  // <command> block contains the raw user request and is always correct.
  const parsed = parseCommandBlock(userPrompt);
  if (parsed.flags.provider) provider = parsed.flags.provider;
  if (parsed.flags.model) model = parsed.flags.model;
  userPrompt = parsed.cleanPrompt;

  process.stderr.write(`mcp-takeover: call_model args: provider=${provider} model=${model || "(none)"} mode=${mode || "(none)"} write=${!!write}\n`);

  if (!provider) throw new Error("provider is required — pass it directly or include --provider <name> in a <command> block in userPrompt");
  if (!userPrompt || !userPrompt.trim()) {
    throw new Error("userPrompt must be non-empty");
  }

  let systemPrompt = customSystem || "";
  if (!customSystem && mode) {
    systemPrompt = buildPrompt(mode, userPrompt).systemPrompt;
  }

  const providerConfig = loadProviderConfig(provider);

  let data;
  if (providerConfig.provider === "codex") {
    process.stderr.write(
      `mcp-takeover: calling codex (${model || "default"})${write ? " [write]" : ""}...\n`
    );
    data = await callCodexCompanion(userPrompt, systemPrompt, model || null, !!write);
  } else if (providerConfig.native) {
    process.stderr.write("mcp-takeover: calling claude (native CLI)...\n");
    data = await callNativeClaude(userPrompt, systemPrompt);
  } else {
    const resolvedModel = resolveModel(providerConfig, model || null);
    process.stderr.write(
      `mcp-takeover: calling ${resolvedModel} (${provider})...\n`
    );
    data = await callAnthropicAPI(providerConfig, resolvedModel, systemPrompt, userPrompt);
    const usage = data.usage || {};
    process.stderr.write(
      `mcp-takeover: ${data.stop_reason || "done"}, ` +
        `in=${usage.input_tokens || "?"} out=${usage.output_tokens || "?"}\n`
    );
  }

  return { content: [{ type: "text", text: extractText(data) }] };
}

export async function handleToolCall(name, args) {
  switch (name) {
    case "call_model":
      return await handleCallModel(args);
    case "list_models":
      return { content: [{ type: "text", text: listModels() }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Main loop ─────────────────────────────────────────────────────

async function main() {
  const rl = createInterface({ input: process.stdin });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      process.stderr.write(
        `mcp-takeover: bad JSON: ${line.slice(0, 200)}\n`
      );
      continue;
    }

    const { id, method, params } = req;

    try {
      switch (method) {
        case "initialize":
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            },
          });
          break;

        case "ping":
          send({ jsonrpc: "2.0", id, result: {} });
          break;

        case "notifications/initialized":
          break;

        case "tools/list":
          send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
          break;

        case "tools/call":
          send({
            jsonrpc: "2.0",
            id,
            result: await handleToolCall(params.name, params.arguments || {}),
          });
          break;

        default:
          send({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes("not found") ? -32602 : -32000;
      send({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`mcp-takeover fatal: ${error.message}\n`);
    process.exitCode = 1;
  });
}
