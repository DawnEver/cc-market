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
  callAgentMode,
  emitTakeoverTrace,
  checkCodexStatus,
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
          enum: ["task", "review", "image-generate", "image-edit", "agent"],
          description:
            "Operation mode. 'task' for code/investigation (default). " +
            "'review' for adversarial code review (codex only). " +
            "'agent' for full tool-access via Claude Code harness + provider env. " +
            "'image-generate' for image generation (codex only). " +
            "'image-edit' for image editing (codex only). " +
            "Parsed from <command> block flags: --review, --image, --image-edit.",
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
        images: {
          type: "array",
          description: "Optional image attachments. Each image is base64-encoded with a media type.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Original file path (for reference)" },
              data: { type: "string", description: "Base64-encoded image data" },
              media_type: { type: "string", description: "MIME type, e.g. image/png, image/jpeg" },
            },
          },
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
  {
    name: "codex_status",
    description: "Check Codex CLI installation status, version, and authentication state.",
    inputSchema: {
      type: "object",
      properties: {
        codexPath: {
          type: "string",
          description: "Optional path to codex binary. Auto-detected if omitted.",
        },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────

export async function handleCallModel(args) {
  let { provider, model, mode, systemPrompt: customSystem, userPrompt, write, images } = args;

  // Parse <command> block from userPrompt — authoritative flag source.
  // The agent may have parsed flags incorrectly (or not at all); the
  // <command> block contains the raw user request and is always correct.
  const parsed = parseCommandBlock(userPrompt);
  if (parsed.flags.provider) provider = parsed.flags.provider;
  if (parsed.flags.model) model = parsed.flags.model;
  userPrompt = parsed.cleanPrompt;
  if (parsed.flags.write && write === undefined) write = true;

  process.stderr.write(`mcp-takeover: call_model args: provider=${provider} model=${model || "(none)"} mode=${mode || "(none)"} write=${!!write}\n`);

  if (!provider) throw new Error("provider is required — pass it directly or include --provider <name> in a <command> block in userPrompt");
  if (!userPrompt || !userPrompt.trim()) {
    throw new Error("userPrompt must be non-empty");
  }

  let systemPrompt = customSystem || "";
  if (!customSystem && mode) {
    systemPrompt = buildPrompt(mode, userPrompt).systemPrompt;
  }

  // Resolve images: agent passes file paths; MCP server reads and base64-encodes.
  // This avoids the agent having to shuttle multi-MB base64 strings through tool calls.
  const resolvedImages = [];
  if (images && images.length > 0) {
    const extToMime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
    for (const img of images) {
      if (img.data) {
        resolvedImages.push(img);
      } else if (img.path) {
        try {
          const raw = readFileSync(img.path);
          const ext = (img.path.match(/\.\w+$/i) || ['.png'])[0].toLowerCase();
          resolvedImages.push({
            path: img.path,
            data: raw.toString('base64'),
            media_type: img.media_type || extToMime[ext] || 'image/png',
          });
        } catch (e) {
          process.stderr.write(`mcp-takeover: failed to read image ${img.path}: ${e.message}\n`);
        }
      }
    }
  }

  // Embed images as data URIs for stdin-based callers (claude native, codex task).
  // API callers receive structured content blocks — Anthropic API charges by pixel
  // dimensions, so full-size originals are fine.
  const imageURIs = resolvedImages.length > 0
    ? resolvedImages.map(img => `data:${img.media_type};base64,${img.data}`).join('\n')
    : '';

  // Check if any image exceeds safe size for data-URI embedding in text prompts.
  // Base64 inflates by ~33%, and each char ≈ 0.25 tokens. ~150KB binary → ~200KB
  // base64 → ~50K tokens — safe for 1M context window. Larger images risk overflow.
  const oversized = resolvedImages.some(img => img.data.length > 150000);
  if (oversized && (provider === 'claude' || provider === 'codex')) {
    process.stderr.write(`mcp-takeover: WARNING — image base64 >150KB will inflate text-prompt token count. ` +
      `For Claude native/codex paths, prefer pre-resized images. API path (--provider <api>) uses content blocks and is unaffected.\n`);
  }

  const providerConfig = loadProviderConfig(provider);

  // ── Agent mode: full tool access via provider-specific runtime ──
  if (mode === 'agent') {
    process.stderr.write(`mcp-takeover: agent mode — provider=${provider} model=${model || '(none)'}\n`);
    let data;
    if (providerConfig.provider === 'codex') {
      data = await callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, resolvedImages.length > 0 ? resolvedImages : null);
    } else {
      data = await callAgentMode(provider, userPrompt, systemPrompt, model || null, resolvedImages.length > 0 ? resolvedImages : null);
    }
    return { content: [{ type: 'text', text: extractText(data) }] };
  }

  // Review and image modes require the codex provider
  if (mode && mode !== "task" && providerConfig.provider !== "codex") {
    throw new Error(
      `Mode "${mode}" is only supported with --provider codex. ` +
      `The current provider "${provider}" does not support review or image operations.`
    );
  }

  const promptWithImages = imageURIs ? `${userPrompt}\n\n[Attached images]\n${imageURIs}` : userPrompt;
  const hasImages = resolvedImages.length > 0;

  let data;
  let resolvedModel = model || null;
  if (providerConfig.provider === "codex") {
    if (mode === "review") {
      process.stderr.write(`mcp-takeover: codex review (adversarial)...\n`);
      const { runCodexReview } = await import("./codex/review.mjs");
      data = await runCodexReview(promptWithImages, model || null, null, process.cwd());
    } else if (mode === "image-generate") {
      process.stderr.write(`mcp-takeover: codex image generate...\n`);
      const { generateImage } = await import("./codex/image.mjs");
      data = await generateImage(userPrompt);
    } else if (mode === "image-edit") {
      process.stderr.write(`mcp-takeover: codex image edit...\n`);
      const { editImage } = await import("./codex/image.mjs");
      const imagePath = systemPrompt || userPrompt.split(/\s+/)[0];
      const editPrompt = systemPrompt ? userPrompt : userPrompt.replace(/^\S+\s*/, "");
      data = await editImage(editPrompt, imagePath);
    } else {
      process.stderr.write(
        `mcp-takeover: calling codex (${model || "default"})${write ? " [write]" : ""}${hasImages ? ` + ${resolvedImages.length} image(s)` : ""}...\n`
      );
      data = await callCodexCompanion(userPrompt, systemPrompt, model || null, !!write, hasImages ? resolvedImages : null);
    }
  } else if (providerConfig.native) {
    process.stderr.write("mcp-takeover: calling claude (native CLI)...\n");
    // claude.exe -p with stream-json doesn't support image content blocks.
    // Embed as data URI in text instead — caller is responsible for keeping
    // total token count within model context limits.
    const promptWithImagesNative = imageURIs ? `${userPrompt}\n\n[Attached images]\n${imageURIs}` : userPrompt;
    data = await callNativeClaude(promptWithImagesNative, systemPrompt, null);
  } else {
    resolvedModel = resolveModel(providerConfig, model || null);
    process.stderr.write(
      `mcp-takeover: calling ${resolvedModel} (${provider})...\n`
    );
    data = await callAnthropicAPI(providerConfig, resolvedModel, systemPrompt, userPrompt, hasImages ? resolvedImages : null, true);
    const usage = data.usage || {};
    process.stderr.write(
      `mcp-takeover: ${data.stop_reason || "done"}, ` +
        `in=${usage.input_tokens || "?"} out=${usage.output_tokens || "?"}\n`
    );
  }

  // Emit trace for TraceMe (NDJSON contract, no code dependency)
  const usage = data?._usage || data?.usage || null;
  emitTakeoverTrace({
    ts: new Date().toISOString(),
    provider,
    model: resolvedModel || 'default',
    mode: mode || 'task',
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    cache_read: usage?.cache_read_input_tokens || 0,
    cache_write: usage?.cache_creation_input_tokens || 0,
  });

  return { content: [{ type: "text", text: extractText(data) }] };
}

export async function handleToolCall(name, args) {
  switch (name) {
    case "call_model":
      return await handleCallModel(args);
    case "list_models":
      return { content: [{ type: "text", text: listModels() }] };
    case "codex_status": {
      const status = checkCodexStatus(args.codexPath || null);
      const lines = [
        `Installed: ${status.installed}`,
        status.path ? `Path: ${status.path}` : "",
        status.version ? `Version: ${status.version}` : "",
        `Authenticated: ${status.authenticated}`,
        status.error ? `Error: ${status.error}` : "",
      ];
      return { content: [{ type: "text", text: lines.filter(Boolean).join("\n") }] };
    }
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
